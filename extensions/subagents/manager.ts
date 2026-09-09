/**
 * Subagent registry: the one source of truth (DESIGN.md §1, §3, §4, §13).
 *
 * Holds the tree of subagent nodes plus the result store. Everything — tools,
 * commands, lifecycle hooks, UI — reads/writes this instance. The instance is
 * meant to be fetched via `getSharedRegistry()`, which attaches it to
 * `globalThis` so it survives extension `/reload`.
 *
 * Live AgentSession integration is injected: nodes carry an opaque
 * `SubagentSessionHandle` (abort/dispose) supplied by session.ts, and queued
 * nodes are started through the `startQueued` hook. All tree logic — queue
 * accounting, cancel cascades, adoption walks, merge-at-settle assembly,
 * result-store LRU/TTL — is offline-testable without a live session.
 *
 * Pure/UI-free.
 */

import {
  DEFAULT_ON_PARENT_ERROR,
  MAX_CONCURRENT,
  MERGE_TIMEOUT_S,
  OUTPUT_CAP,
  RESULT_STORE_MAX,
  ROOT_AGENT_NAME,
  UNCOLLECTED_TTL_MS,
  type ContextMode,
  type OnParentErrorMode,
} from "./constants.ts";

import { ActivityLog, type ActivityEntry } from "./activity.ts";
import type { TranscriptLog } from "./transcript.ts";

export type SubagentStatus =
  | "queued"
  | "running"
  | "merging"
  | "done"
  | "error"
  | "cancelled"
  | "partial";

/** Terminal statuses: the subagent will not run again. */
export const TERMINAL_STATUSES: readonly SubagentStatus[] = ["done", "error", "cancelled", "partial"];

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** Completion payload (DESIGN.md §4) — stored, then removed on fetch. */
export interface SubagentResult {
  name: string;
  status: "done" | "error" | "cancelled" | "partial";
  /** Final text; stored capped at OUTPUT_CAP, injected to models ≤ SNIPPET_CAP. */
  output: string;
  outputTruncated?: boolean;
  /** Always included on error so partial work isn't lost. */
  partialOutput?: string;
  lastToolActivity?: number;
  model?: string;
  thinking?: string;
  modelReason?: string;
  usage: SubagentUsage;
  turns: number;
  durationSec: number;
  startTime?: string;
  endTime?: string;
  stopReason?: string;
  error?: string;
  contextMode: ContextMode;
  contextTurns?: number;
  /** Set by merge-at-settle when a parent absorbed its children's outputs. */
  mergedChildren?: number;
}

/** Opaque handle to a live subagent AgentSession (session.ts supplies it). */
export interface SubagentSessionHandle {
  abort(): Promise<void>;
  dispose(): void;
}

export interface SubagentSpawnOptions {
  name: string;
  parentName: string;
  contextMode: ContextMode;
  contextTurns?: number;
  /** Display string "provider/modelId" of the resolved routing outcome. */
  model?: string;
  thinking?: string;
  modelReason?: string;
  onParentError: OnParentErrorMode;
  timeoutS?: number;
  /** Preflight notices, including provider rerouting and audit-text truncation. */
  warnings?: string[];
  /** Original working directory, used only to render recorded tool paths. */
  cwd?: string;
  /** Full delegated task, bounded by spawn validation. Not inherited history. */
  prompt?: string;
  /** First 80 chars of the prompt, for transcript/popup display. */
  promptSnippet?: string;
}

export interface SubagentNode extends SubagentSpawnOptions {
  depth: number;
  status: SubagentStatus;
  createdAt?: number;
  activity?: ActivityLog;
  transcript?: TranscriptLog;
  lastActivityAt?: number;
  phase?: string;
  /** Own model usage only; node.usage can include already-collected children. */
  ownUsage?: SubagentUsage;
  liveOutput?: string;
  ownOutput?: string;
  outputTruncated?: boolean;
  delivery?: { kind: "collected" | "merged"; parent: string; at: number };
  handle?: SubagentSessionHandle;
  /** Resolves when the subagent settles (any terminal status). */
  done: Promise<void>;
  resolveDone: () => void;
  /** Retained inspection copy; only the result store's collectable copy is removed. */
  result?: SubagentResult;
  startedAt?: number;
  endedAt?: number;
  usage: SubagentUsage;
  /** Costs returned by collect_subagents calls made by this node. */
  delegatedUsage: SubagentUsage;
  /** Direct children whose costs were already included by an explicit collect. */
  collectedChildren: Set<string>;
  turns: number;
  /** Global spawn order; merge sections use per-parent spawn order. */
  spawnIndex: number;
  /** Set when the node was re-parented by adoption. */
  adoptedFrom?: string;
  /** Populated by session.ts for per-node timeout expiry. */
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

export type RegistryListener = (note: string) => void;

export interface RegistryHooks {
  /** Called whenever node statuses change; index.ts batches interrupt-notes. */
  onStateChange?: RegistryListener;
  /** Called when capacity opens; the engine starts queued nodes. */
  startQueued?: () => void;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable merge-at-settle wait (tests); defaults to MERGE_TIMEOUT_S. */
  mergeTimeoutMs?: number;
}

// ── pure tree helpers ──────────────────────────────────────────────────────

/** Direct children of `parentName` in spawn order. */
export function childrenOf(
  nodes: ReadonlyMap<string, SubagentNode>,
  parentName: string,
): SubagentNode[] {
  return [...nodes.values()]
    .filter((node) => node.parentName === parentName)
    .sort((a, b) => a.spawnIndex - b.spawnIndex);
}

/** The subtree rooted at `name` (excluding the root), preorder. */
export function subtreeOf(
  nodes: ReadonlyMap<string, SubagentNode>,
  name: string,
): SubagentNode[] {
  const out: SubagentNode[] = [];
  const visit = (parent: string) => {
    for (const child of childrenOf(nodes, parent)) {
      out.push(child);
      visit(child.name);
    }
  };
  visit(name);
  return out;
}

function isLiving(node: SubagentNode): boolean {
  return !TERMINAL_STATUSES.includes(node.status);
}

/**
 * Nearest living ancestor for adoption (DESIGN.md §3): walk up the parent
 * chain, skipping dead (error/cancelled) ancestors. The root (`__main__`) is
 * always alive while the session runs. Returns null when no ancestor is
 * living (only possible mid-teardown).
 */
export function findNearestLivingAncestor(
  nodes: ReadonlyMap<string, SubagentNode>,
  name: string,
): string | null {
  let current = nodes.get(name);
  while (current) {
    if (current.parentName === ROOT_AGENT_NAME) return ROOT_AGENT_NAME;
    const parent = nodes.get(current.parentName);
    if (!parent) return ROOT_AGENT_NAME;
    if (isLiving(parent)) return parent.name;
    current = parent;
  }
  return null;
}

// ── merge-at-settle assembly ───────────────────────────────────────────────

export interface MergeChildSection {
  name: string;
  status: string;
  output: string;
}

/**
 * Assemble a parent's merged output (DESIGN.md §3): parent text first, then
 * `## name (status)` sections in spawn order, truncated from the bottom
 * (last child backward) to keep the parent text intact. `mergedChildren`
 * counts the sections that survived.
 */
export function mergeChildOutputs(
  parentOutput: string,
  children: MergeChildSection[],
  cap = OUTPUT_CAP,
): { output: string; mergedChildren: number } {
  const section = (child: MergeChildSection) => `## ${child.name} (${child.status})\n${child.output}`;
  let included = children.length;
  let output = "";

  const assemble = () => {
    const parts = [parentOutput];
    for (const child of children.slice(0, included)) parts.push(section(child));
    return parts.join("\n\n");
  };

  output = assemble();
  while (output.length > cap && included > 0) {
    included -= 1;
    output = assemble();
  }
  if (output.length > cap) {
    // Even the parent text alone exceeds the cap: keep the head.
    output = output.slice(0, cap);
  }
  return { output, mergedChildren: included };
}

// ── result store ───────────────────────────────────────────────────────────

/**
 * Done-result store: fetched results are removed; the store keeps at most
 * `capacity` entries (LRU) and drops entries older than `ttlMs`.
 */
export class ResultStore {
  private entries = new Map<string, { result: SubagentResult; at: number }>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    capacity = RESULT_STORE_MAX,
    ttlMs = UNCOLLECTED_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  set(name: string, result: SubagentResult): void {
    this.evictExpired();
    this.entries.delete(name);
    this.entries.set(name, { result, at: this.now() });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Read without removing (subagent_status snippets), refreshing LRU recency. */
  peek(name: string): SubagentResult | undefined {
    this.evictExpired();
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    this.entries.delete(name);
    this.entries.set(name, entry);
    return entry.result;
  }

  /** Fetch and remove (collect_subagents; merge-at-settle). */
  fetch(name: string): SubagentResult | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    this.entries.delete(name);
    return entry.result;
  }

  /** Side-effect-free availability check for observers (no LRU/TTL mutation). */
  isAvailable(name: string): boolean {
    const entry = this.entries.get(name);
    return entry !== undefined && entry.at >= this.now() - this.ttlMs;
  }

  has(name: string): boolean {
    this.evictExpired();
    return this.entries.has(name);
  }

  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [name, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(name);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

// ── registry ───────────────────────────────────────────────────────────────

export interface SpawnRejection {
  ok: false;
  error: string;
}

export interface SettleOutcome {
  status: "done" | "partial" | "error" | "cancelled";
  output?: string;
  outputTruncated?: boolean;
  partialOutput?: string;
  error?: string;
  stopReason?: string;
  usage?: Partial<SubagentUsage>;
  turns?: number;
  lastToolActivity?: number;
}

const EMPTY_USAGE: SubagentUsage = { inputTokens: 0, outputTokens: 0, cost: 0 };

function addUsage(target: SubagentUsage, addition: SubagentUsage): void {
  target.inputTokens += addition.inputTokens;
  target.outputTokens += addition.outputTokens;
  target.cost += addition.cost;
}

function withDelegatedUsage(node: SubagentNode, ownUsage: SubagentUsage): SubagentUsage {
  const usage = { ...ownUsage };
  addUsage(usage, node.delegatedUsage ?? EMPTY_USAGE);
  return usage;
}

export class SubagentRegistry {
  readonly nodes = new Map<string, SubagentNode>();
  readonly store = new ResultStore();
  private nextSpawnIndex = 0;
  private readonly listeners = new Set<RegistryListener>();
  /** Mutable so index.ts can rebind the note sink after /reload. */
  hooks: RegistryHooks;
  private readonly now: () => number;
  private readonly mergeTimeoutMs: number;

  constructor(hooks: RegistryHooks = {}) {
    this.hooks = hooks;
    this.now = hooks.now ?? Date.now;
    this.mergeTimeoutMs = hooks.mergeTimeoutMs ?? MERGE_TIMEOUT_S * 1000;
  }

  // ── spawn bookkeeping ────────────────────────────────────────────────────

  /** Subscribe to state changes without replacing the extension hook. */
  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Telemetry notifies inspectors only, never model-facing lifecycle hooks. */
  recordActivity(name: string, entry: ActivityEntry): void {
    const node = this.nodes.get(name);
    if (!node) return;
    node.activity ??= new ActivityLog();
    node.activity.upsert(entry);
    node.lastActivityAt = this.now();
    this.touch(name);
  }

  touch(name: string): void {
    for (const listener of this.listeners) {
      try {
        listener(`activity: ${name}`);
      } catch {
        // An inspector cannot interfere with a worker.
      }
    }
  }

  private recordState(node: SubagentNode, title: string): void {
    this.recordActivity(node.name, {
      id: `state:${node.activity?.revision ?? 0}`,
      kind: "state", title, text: "", at: this.now(),
    });
  }

  private emit(note: string): void {
    try {
      this.hooks.onStateChange?.(note);
    } catch {
      // State observers must never break registry transitions.
    }
    for (const listener of this.listeners) {
      try {
        listener(note);
      } catch {
        // Popup/UI observers are best-effort.
      }
    }
  }

  /**
   * Register a subagent node (status `queued`). Names are globally unique for
   * the whole session lifetime — finished names are not reusable, the registry
   * is append-only so the result store stays unambiguous (§13).
   */
  register(options: SubagentSpawnOptions): SubagentNode {
    if (options.name === ROOT_AGENT_NAME) throw new Error(`Subagent name "${ROOT_AGENT_NAME}" is reserved for the main agent`);
    if (this.nodes.has(options.name)) {
      throw new Error(`Subagent name "${options.name}" is already used this session`);
    }
    const parent = this.nodes.get(options.parentName);
    const depth = options.parentName === ROOT_AGENT_NAME ? 1 : parent ? parent.depth + 1 : 1;

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const node: SubagentNode = {
      ...options,
      onParentError: options.onParentError ?? DEFAULT_ON_PARENT_ERROR,
      depth,
      status: "queued",
      createdAt: this.now(),
      activity: new ActivityLog(),
      ownUsage: { ...EMPTY_USAGE },
      done,
      resolveDone,
      usage: { ...EMPTY_USAGE },
      delegatedUsage: { ...EMPTY_USAGE },
      collectedChildren: new Set(),
      turns: 0,
      spawnIndex: this.nextSpawnIndex++,
    };
    // Older tool closures surviving /reload may still pass this removed option.
    Reflect.deleteProperty(node, "maxTurns");
    this.nodes.set(node.name, node);

    this.recordState(node, "Queued");
    this.emit(`subagent queued: ${node.name}`);
    return node;
  }

  /** Ask the current queue owner to start newly available work. */
  pumpQueue(): void {
    this.hooks.startQueued?.();
  }

  /** Queue position among queued nodes (0 = next). -1 when not queued. */
  queuePosition(name: string): number {
    const queued = [...this.nodes.values()]
      .filter((node) => node.status === "queued")
      .sort((a, b) => a.spawnIndex - b.spawnIndex);
    return queued.findIndex((node) => node.name === name);
  }

  runningCount(): number {
    let count = 0;
    for (const node of this.nodes.values()) {
      // A merging node's AgentSession has already ended; only live sessions
      // consume a concurrency slot.
      if (node.status === "running") count += 1;
    }
    return count;
  }

  /**
   * Next queued node if concurrency capacity allows. Reserves the node
   * (marks it running) so a pump loop cannot hand the same node out twice;
   * session.ts attaches the live handle via `markRunning`.
   */
  dequeueNext(eligible?: ReadonlySet<string>): SubagentNode | undefined {
    if (this.runningCount() >= MAX_CONCURRENT) return undefined;
    const next = [...this.nodes.values()]
      .filter((node) => node.status === "queued" && (!eligible || eligible.has(node.name)))
      .sort((a, b) => a.spawnIndex - b.spawnIndex)[0];
    if (next) next.status = "running";
    return next;
  }

  /** Attach the live session handle; the caller (session.ts) has started it. */
  markRunning(name: string, handle: SubagentSessionHandle): SubagentNode | undefined {
    const node = this.nodes.get(name);
    if (!node) return undefined;
    node.status = "running";
    node.handle = handle;
    node.startedAt = node.startedAt ?? this.now();
    this.recordState(node, "Started");
    this.emit(`subagent running: ${name}`);
    return node;
  }

  // ── settle / fail / merge ────────────────────────────────────────────────

  /**
   * Record a settlement. Normal terminations (done/partial) with live children
   * defer `done` resolution and must be followed by `mergeAtSettle` (§3),
   * which resolves it once the merged output is final. Error terminations go
   * through `onUnexpectedFailure` instead.
   */
  settle(name: string, outcome: SettleOutcome): SubagentNode | undefined {
    const node = this.nodes.get(name);
    if (!node || TERMINAL_STATUSES.includes(node.status)) return undefined;

    const needsMerge =
      (outcome.status === "done" || outcome.status === "partial") && this.hasLiveChildren(name);

    node.endedAt = this.now();
    node.status = outcome.status;
    node.transcript?.finish(outcome.status, outcome.error);
    node.ownUsage = { ...EMPTY_USAGE, ...(outcome.usage ?? node.ownUsage) };
    node.usage = withDelegatedUsage(node, node.ownUsage);
    node.ownOutput = (outcome.output ?? outcome.partialOutput ?? "").slice(0, OUTPUT_CAP);
    node.outputTruncated ||= outcome.outputTruncated || (outcome.output ?? outcome.partialOutput ?? "").length > OUTPUT_CAP;
    node.turns = outcome.turns ?? node.turns;
    clearTimeout(node.timeoutTimer);

    const partialOutput =
      outcome.partialOutput ?? (outcome.status === "error" ? outcome.output ?? "" : undefined);
    node.result = {
      name: node.name,
      status: outcome.status,
      output: node.ownOutput,
      ...(node.outputTruncated ? { outputTruncated: true } : {}),
      ...(partialOutput !== undefined ? { partialOutput: partialOutput.slice(0, OUTPUT_CAP) } : {}),
      ...(outcome.lastToolActivity !== undefined ? { lastToolActivity: outcome.lastToolActivity } : {}),
      ...(node.model !== undefined ? { model: node.model } : {}),
      ...(node.thinking !== undefined ? { thinking: node.thinking } : {}),
      ...(node.modelReason !== undefined ? { modelReason: node.modelReason } : {}),
      usage: node.usage,
      turns: node.turns,
      durationSec: Math.max(0, Math.round(((node.endedAt ?? 0) - (node.startedAt ?? node.endedAt ?? 0)) / 100) / 10),
      ...(node.startedAt !== undefined ? { startTime: new Date(node.startedAt).toISOString() } : {}),
      endTime: new Date(node.endedAt).toISOString(),
      ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      contextMode: node.contextMode,
      ...(node.contextTurns !== undefined ? { contextTurns: node.contextTurns } : {}),
    };
    this.store.set(name, node.result);
    if (!needsMerge) node.resolveDone();

    // A parent that needs merge-at-settle is not final yet; emit the final
    // completion event only after mergeAtSettle has assembled its output.
    this.recordState(node, needsMerge ? "Own work finished; waiting on children" : `Finished: ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ""}`);
    if (!needsMerge) {
      this.emit(`subagent settled: ${name} (${outcome.status})`);
      this.pumpQueue();
    }
    return node;
  }

  /**
   * Whether a normally-settled node still has children to merge. This includes
   * live children and terminal children whose results were not explicitly
   * collected, so nested work and its cost cannot become unreachable.
   */
  hasLiveChildren(name: string): boolean {
    return childrenOf(this.nodes, name).some(
      (child) =>
        child.status === "queued" ||
        child.status === "running" ||
        child.status === "merging" ||
        (TERMINAL_STATUSES.includes(child.status) && this.store.has(child.name)),
    );
  }

  /**
   * Merge-at-settle (§3): wait up to MERGE_TIMEOUT_S for live children, cancel
   * stragglers, then merge child outputs (spawn order, bottom-truncated) into
   * the parent's result. Every subtree completes bottom-up.
   */
  async mergeAtSettle(name: string): Promise<void> {
    const node = this.nodes.get(name);
    if (!node || !node.result) return;
    node.status = "merging";
    node.endedAt = undefined;
    this.recordState(node, "Waiting on children");
    this.emit(`subagent merging: ${name}`);
    this.pumpQueue(); // The parent's ended session no longer consumes capacity.

    const liveChildren = childrenOf(this.nodes, name).filter(
      (child) => child.status === "queued" || child.status === "running" || child.status === "merging",
    );
    if (liveChildren.length > 0) {
      let mergeTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        mergeTimer = setTimeout(resolve, this.mergeTimeoutMs);
      });
      try {
        await Promise.race([Promise.all(liveChildren.map((child) => child.done)), timeout]);
      } finally {
        if (mergeTimer !== undefined) clearTimeout(mergeTimer);
      }
      for (const child of liveChildren) {
        if (child.status === "queued" || child.status === "running" || child.status === "merging") {
          this.cancelSubtree(child.name, { stopReason: "cut off (merge timeout)" });
        }
      }
    }

    // Session teardown can clear the registry while this merge is waiting;
    // never repopulate a newly cleared result store with stale state.
    if (this.nodes.get(name) !== node || node.status !== "merging") return;

    const sections: MergeChildSection[] = [];
    const mergedUsage = { ...node.result.usage };
    const collectedChildren = node.collectedChildren ?? new Set<string>();
    for (const child of childrenOf(this.nodes, name)) {
      // The store is bounded; fall back to the node's retained result if an
      // unrelated completion evicted the child's fetchable copy before merge.
      const result = this.store.fetch(child.name) ?? child.result;
      if (!result) continue;
      child.delivery ??= { kind: "merged", parent: name, at: this.now() };
      this.recordState(child, `Merged into ${name}`);
      // Explicitly collected children are already represented in the parent's
      // delegatedUsage. Auto-merged children need to be added here instead.
      if (!collectedChildren.has(child.name)) addUsage(mergedUsage, result.usage);
      // Cut-off children with nothing captured contribute no section, but their
      // usage above still counts toward the parent's incurred cost.
      if (result.status === "cancelled" && !result.output) continue;
      sections.push({ name: child.name, status: result.status, output: result.output });
    }

    const merged = mergeChildOutputs(node.result.output, sections);
    node.endedAt = this.now();
    node.usage = mergedUsage;
    node.result = {
      ...node.result,
      output: merged.output,
      outputTruncated: node.result.outputTruncated || merged.mergedChildren < sections.length,
      usage: mergedUsage,
      endTime: new Date(node.endedAt).toISOString(),
      durationSec: Math.max(0, Math.round((node.endedAt - (node.startedAt ?? node.endedAt)) / 100) / 10),
      ...(merged.mergedChildren > 0 ? { mergedChildren: merged.mergedChildren } : {}),
    };
    this.store.set(name, node.result);
    node.status = node.result.status; // back to done/partial
    node.resolveDone();
    this.recordState(node, `Finished: ${node.status}; merged ${merged.mergedChildren} children`);
    this.emit(`subagent merged: ${name} (+${merged.mergedChildren} children)`);
  }

  /**
   * Unexpected parent death (session error, timeout expiry, provider failure —
   * not user cancel, which cascades). Re-parents live children to the nearest
   * living ancestor, or kills them when they opted out (§3).
   */
  onUnexpectedFailure(name: string): void {
    const node = this.nodes.get(name);
    if (!node) return;

    for (const child of childrenOf(this.nodes, name)) {
      const isLive =
        child.status === "queued" || child.status === "running" || child.status === "merging";
      // A completed result can outlive its parent failure, but it must be
      // re-parented too or direct-child collection would make it unreachable.
      const hasUncollectedResult = TERMINAL_STATUSES.includes(child.status) && this.store.has(child.name);
      if (!isLive && !hasUncollectedResult) continue;

      if (isLive && child.onParentError === "kill") {
        this.cancelSubtree(child.name, { stopReason: `parent ${name} failed (onParentError: kill)` });
        continue;
      }
      const ancestor = findNearestLivingAncestor(this.nodes, name);
      if (!ancestor) {
        this.cancelSubtree(child.name, { stopReason: "no living ancestor (teardown)" });
        continue;
      }
      child.parentName = ancestor;
      child.adoptedFrom = name;
      this.recordState(child, `Adopted from ${name} by ${ancestor === ROOT_AGENT_NAME ? "main" : ancestor}`);
      this.emit(`subagent adopted: ${child.name} (${name} → ${ancestor})`);
    }
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  /**
   * Cancel a node and its subtree (§2, §13): recursively aborts sessions,
   * including still-queued items (no session yet — marked cancelled directly).
   * Settled nodes keep their stored results. Returns the names actually
   * cancelled for the one batched interrupt-note per cascade.
   */
  cancelSubtree(name: string, options: { stopReason?: string } = {}): string[] {
    const cancelled: string[] = [];
    const targets = name === ROOT_AGENT_NAME ? [...this.nodes.values()] : [this.nodes.get(name), ...subtreeOf(this.nodes, name)].filter(
      (node): node is SubagentNode => node !== undefined,
    );

    for (const node of targets) {
      if (TERMINAL_STATUSES.includes(node.status)) continue;
      clearTimeout(node.timeoutTimer);
      node.usage = node.status === "merging" ? node.usage : withDelegatedUsage(node, node.ownUsage ?? node.usage);
      node.status = "cancelled";
      node.transcript?.finish("cancelled", options.stopReason);
      node.endedAt = this.now();
      node.ownOutput ??= node.liveOutput ?? "";
      node.result = {
        name: node.name,
        status: "cancelled",
        output: node.ownOutput,
        partialOutput: node.ownOutput,
        ...(node.outputTruncated ? { outputTruncated: true } : {}),
        usage: node.usage,
        turns: node.turns,
        durationSec:
          node.startedAt !== undefined
            ? Math.round((node.endedAt - node.startedAt) / 100) / 10
            : 0,
        ...(node.startedAt !== undefined ? { startTime: new Date(node.startedAt).toISOString() } : {}),
        endTime: new Date(node.endedAt).toISOString(),
        ...(options.stopReason !== undefined ? { stopReason: options.stopReason } : {}),
        contextMode: node.contextMode,
        ...(node.contextTurns !== undefined ? { contextTurns: node.contextTurns } : {}),
        ...(node.model !== undefined ? { model: node.model } : {}),
        ...(node.thinking !== undefined ? { thinking: node.thinking } : {}),
      };
      this.store.set(node.name, node.result);
      const handle = node.handle;
      node.resolveDone();
      cancelled.push(node.name);
      for (const entry of [...(node.activity?.entries ?? [])]) {
        if (entry.state === "running") this.recordActivity(node.name, { ...entry, state: "cancelled", endedAt: node.endedAt });
      }
      this.recordState(node, `Cancelled${options.stopReason ? `: ${options.stopReason}` : " by user"}`);
      // Abort outside the critical section; dispose happens at teardown.
      void handle?.abort().catch(() => {});
    }

    if (cancelled.length > 0) {
      this.emit(`subagents cancelled: ${cancelled.join(", ")}`);
      this.pumpQueue();
    }
    return cancelled;
  }

  // ── collect validation ───────────────────────────────────────────────────

  /**
   * Pre-wait collect validation (§13): unknown names, non-direct-children,
   * and already-collected names fail the whole call, listing the caller's
   * actual children.
   */
  validateCollect(callerName: string, names: string[]): true | SpawnRejection {
    if (names.length === 0) {
      return { ok: false, error: "collect_subagents requires at least one subagent name" };
    }
    const childNames = childrenOf(this.nodes, callerName).map((node) => node.name);
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        return { ok: false, error: `Duplicate subagent name "${name}" in collection request` };
      }
      seen.add(name);
      const node = this.nodes.get(name);
      if (!node) {
        return { ok: false, error: `Unknown subagent "${name}". Children of ${callerName}: ${listNames(childNames)}` };
      }
      if (node.parentName !== callerName) {
        return {
          ok: false,
          error: `"${name}" is not a direct child of ${callerName}. Children: ${listNames(childNames)}`,
        };
      }
      if (TERMINAL_STATUSES.includes(node.status) && !this.store.has(name)) {
        return { ok: false, error: `"${name}" was already collected. Children: ${listNames(childNames)}` };
      }
    }
    return true;
  }

  /**
   * Fetch payloads in requested order and combine usage. Results are removed
   * from the store regardless of item status. When callerName is supplied,
   * the usage is carried into that node's final result for nested accounting.
   * Caller must validate first.
   */
  fetchResults(names: string[], callerName?: string): { results: SubagentResult[]; usage: SubagentUsage } {
    const results: SubagentResult[] = [];
    const usage: SubagentUsage = { ...EMPTY_USAGE };
    for (const name of names) {
      const result = this.store.fetch(name);
      if (!result) continue;
      results.push(result);
      const node = this.nodes.get(name);
      if (node) {
        node.delivery = { kind: "collected", parent: callerName ?? node.parentName, at: this.now() };
        this.recordState(node, `Collected by ${node.delivery.parent === ROOT_AGENT_NAME ? "main" : node.delivery.parent}`);
      }
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cost += result.usage.cost;
    }
    const caller = callerName !== undefined ? this.nodes.get(callerName) : undefined;
    if (caller && results.length > 0) {
      caller.delegatedUsage ??= { ...EMPTY_USAGE };
      caller.collectedChildren ??= new Set<string>();
      for (const result of results) caller.collectedChildren.add(result.name);
      addUsage(caller.delegatedUsage, usage);
    }
    if (results.length > 0) this.emit(`subagents collected: ${results.map((result) => result.name).join(", ")}`);
    return { results, usage };
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  /**
   * Session teardown (§13): cancel-all + dispose for quit/new/resume/fork;
   * keep everything for reload (the shared instance survives /reload).
   */
  teardown(reason: "quit" | "reload" | "new" | "resume" | "fork"): void {
    if (reason === "reload") return;

    for (const node of this.nodes.values()) {
      clearTimeout(node.timeoutTimer);
      if (!TERMINAL_STATUSES.includes(node.status)) {
        node.status = "cancelled";
        node.endedAt = this.now();
        node.resolveDone();
      }
      const handle = node.handle;
      node.handle = undefined;
      void handle?.abort().catch(() => {});
      handle?.dispose();
    }
    this.nodes.clear();
    this.store.clear();
    this.nextSpawnIndex = 0;
  }
}

function listNames(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

// ── shared instance across /reload ─────────────────────────────────────────

const GLOBAL_KEY = "__pi_subagents_registry__";

/**
 * The module-scoped registry instance attached to `globalThis` so it survives
 * extension `/reload`: running subagents and uncollected results keep working,
 * and re-registered tools bind to the same instance (DESIGN.md §1).
 */
export function getSharedRegistry(hooks: RegistryHooks = {}): SubagentRegistry {
  const holder = globalThis as Record<string, unknown>;
  const existing = holder[GLOBAL_KEY];
  if (
    typeof existing === "object" &&
    existing !== null &&
    "nodes" in existing &&
    "store" in existing &&
    "register" in existing &&
    "cancelSubtree" in existing
  ) {
    // Keep live state, but rebind behavior after /reload. These are ordinary
    // TS private fields (not JS #fields), so the existing instance is compatible.
    Object.setPrototypeOf(existing, SubagentRegistry.prototype);
    const registry = existing as SubagentRegistry;
    Object.setPrototypeOf(registry.store, ResultStore.prototype);
    // Old watchers read the node field on each turn. Removing it also disables
    // their future turn-limit aborts without interrupting running workers.
    for (const node of registry.nodes.values()) Reflect.deleteProperty(node, "maxTurns");
    return registry;
  }
  const registry = new SubagentRegistry(hooks);
  holder[GLOBAL_KEY] = registry;
  return registry;
}

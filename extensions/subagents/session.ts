/**
 * In-process subagent session factory (DESIGN.md §9) and the engine that
 * drives the spawn queue.
 *
 * `createEngine()` owns a pending-spec map plus the pump loop; the shared
 * instance (getSharedEngine) is attached to globalThis alongside the shared
 * registry so both survive extension `/reload`.
 *
 * `startSession()` builds one subagent AgentSession:
 * - `SessionManager.inMemory(cwd, { id: name }, seedEntries)` (ephemeral, id = name)
 * - one `DefaultResourceLoader` per spawn call, shared across the batch,
 *   with `noExtensions/noSkills/noPromptTemplates` (no re-discovery, no
 *   recursion) and the fresh routing block via `appendSystemPrompt`
 * - the four subagent tools as `customTools`, closure-bound to the child
 *   (spawn unbound at MAX_DEPTH), with tool names included in the allowlist
 *   (an allowlist without them silently disables custom tools — spike finding)
 *
 * `watchSession()` wires the abort cascade: usage/turn tracking,
 * per-node timeout, settle into the registry, adoption on unexpected failure,
 * and merge-at-settle for normal terminations with live children.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

import { MAX_DEPTH, OUTPUT_CAP } from "./constants.ts";
import { ACTIVITY_ENTRY_CHARS, contentText, toolTitle, type ActivityEntry } from "./activity.ts";
import { getSharedRegistry, TERMINAL_STATUSES, type SubagentNode, type SubagentRegistry } from "./manager.ts";
import { makeSubagentTools, type SpawnRequest, type SubagentEngine, type ToolCaller } from "./tools.ts";
import { TranscriptLog } from "./transcript.ts";

// ── engine ─────────────────────────────────────────────────────────────────

export function createEngine(registry: SubagentRegistry, legacyPump?: () => void, legacyReset?: () => void): SubagentEngine {
  const pending = new Map<string, SpawnRequest>();
  let pumping = false;

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      legacyPump?.();
      for (;;) {
        // Cancellation can settle queued nodes before their start spec is
        // dequeued; discard those specs so they cannot linger across the
        // session or consume memory.
        for (const [name] of pending) {
          const pendingNode = registry.nodes.get(name);
          if (!pendingNode || TERMINAL_STATUSES.includes(pendingNode.status)) pending.delete(name);
        }
        const node = registry.dequeueNext(new Set(pending.keys()));
        if (!node) break;
        const request = pending.get(node.name);
        if (!request) {
          // Registered but no start spec (engine replaced across /reload):
          // put it back in the queue rather than losing it.
          node.status = "queued";
          break;
        }
        pending.delete(node.name);
        try {
          await startSession(registry, engine, node, request);
        } catch (error) {
          if (registry.nodes.get(node.name) !== node) continue;
          registry.settle(node.name, {
            status: "error",
            error: `session creation failed: ${(error as Error).message}`,
            stopReason: "error",
          });
          registry.onUnexpectedFailure(node.name);
        }
      }
    } finally {
      pumping = false;
    }
  }

  const engine: SubagentEngine = {
    registry,
    start(request) {
      pending.set(request.node.name, request);
      void pump();
    },
    pump() {
      void pump();
    },
    reset() {
      pending.clear();
      legacyReset?.();
    },
  };

  return engine;
}

const ENGINE_GLOBAL_KEY = "__pi_subagents_engine__";
// Bump when child tool/factory closures change so new spawns after /reload
// use current validation/routing while previous engines drain their queues.
const ENGINE_VERSION = 4;

/**
 * Shared engine across /reload: running/queued subagents keep their pending
 * specs, and re-registered tools bind to the same instance.
 */
export function getSharedEngine(): SubagentEngine {
  const holder = globalThis as Record<string, unknown>;
  const existing = holder[ENGINE_GLOBAL_KEY];
  if (
    typeof existing === "object" &&
    existing !== null &&
    "start" in existing &&
    "registry" in existing
  ) {
    const previous = existing as SubagentEngine & { inspectorVersion?: number };
    if (previous.inspectorVersion === ENGINE_VERSION) return previous;
    // Old engines own opaque pending specs. Let them drain those while new
    // spawns use the instrumented watcher; neither scheduler steals specs.
    const engine = Object.assign(createEngine(getSharedRegistry(), () => previous.pump(), () => previous.reset?.()), { inspectorVersion: ENGINE_VERSION });
    holder[ENGINE_GLOBAL_KEY] = engine;
    return engine;
  }
  const engine = Object.assign(createEngine(getSharedRegistry()), { inspectorVersion: ENGINE_VERSION });
  holder[ENGINE_GLOBAL_KEY] = engine;
  return engine;
}

// ── session factory ────────────────────────────────────────────────────────

const LOADER_RELOADS = new WeakMap<object, Promise<void>>();

async function reloadOnce(loader: DefaultResourceLoader): Promise<void> {
  let reload = LOADER_RELOADS.get(loader);
  if (!reload) {
    reload = loader.reload();
    LOADER_RELOADS.set(loader, reload);
  }
  await reload;
}

export async function startSession(
  registry: SubagentRegistry,
  engine: SubagentEngine,
  node: SubagentNode,
  request: SpawnRequest,
): Promise<void> {
  if (registry.nodes.get(node.name) !== node || TERMINAL_STATUSES.includes(node.status)) return;

  // One loader per spawn call, shared across the batch (§9). Tests and
  // direct callers may omit it, so retain a per-request fallback.
  const loader = request.resourceLoader ?? new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir: request.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    ...(request.routingBlock ? { appendSystemPrompt: [request.routingBlock] } : {}),
  });
  await reloadOnce(loader);

  const sessionManager = SessionManager.inMemory(request.cwd, { id: node.name }, request.seedEntries);

  const caller: ToolCaller = {
    name: node.name,
    depth: node.depth,
    cwd: request.cwd,
    agentDir: request.agentDir,
    historyEntries: () => sessionManager.buildContextEntries(),
    parentModel: { model: request.model, thinking: request.thinking as ThinkingLevel },
    modelRegistry: request.modelRegistry,
  };
  const childTools = makeSubagentTools(() => caller, engine, {
    bindSpawn: node.depth < MAX_DEPTH,
  });

  const toolNames = ["read", "bash", "edit", "write", ...childTools.map((tool) => tool.name)];
  const { session } = await createAgentSession({
    cwd: request.cwd,
    model: request.model,
    thinkingLevel: request.thinking as ThinkingLevel,
    tools: toolNames,
    customTools: childTools,
    resourceLoader: loader,
    sessionManager,
  });

  // Cancellation can race session construction for queued nodes.
  const current = registry.nodes.get(node.name);
  if (current !== node || TERMINAL_STATUSES.includes(current.status)) {
    session.dispose();
    return;
  }

  registry.markRunning(node.name, {
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  });
  const finish = watchSession(registry, node, session, engine);

  session
    .prompt(request.prompt)
    .then(
      () => finish("completed"),
      (error) => finish("failed", error as Error),
    )
    .catch(() => {});
}

// ── watcher ─────────────────────────────────────────────────────────────────

export function watchSession(
  registry: SubagentRegistry,
  node: SubagentNode,
  session: AgentSession,
  engine?: SubagentEngine,
): (how: "completed" | "failed", error?: Error) => Promise<void> {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  let turns = 0;
  let lastToolActivity: number | undefined;
  let timeoutHit = false;
  let settled = false;
  let disposed = false;
  const seedMessages = new Set(session.messages);
  const accounted = new WeakSet<object>();
  let sawMessageEnd = false;
  let ownText = "";
  let messageIndex = 0;
  let currentMessage: ActivityEntry | undefined;
  const activeTools = new Map<string, ActivityEntry>();
  const transcript = node.transcript ??= new TranscriptLog();
  let transcriptIndex = 0;
  let transcriptMessageId: string | undefined;
  let awaitingTask = Boolean(node.prompt);
  if (node.prompt && !transcript.entries.length) transcript.user("task", node.prompt);

  function record(entry: ActivityEntry): void {
    registry.recordActivity?.(node.name, entry);
  }

  function account(message: (typeof session.messages)[number]): void {
    if (message.role !== "assistant" || seedMessages.has(message) || accounted.has(message)) return;
    accounted.add(message);
    if (!message.usage) return;
    usage.input += message.usage.input;
    usage.output += message.usage.output;
    usage.cacheRead += message.usage.cacheRead;
    usage.cacheWrite += message.usage.cacheWrite;
    usage.totalTokens += message.usage.totalTokens;
    usage.cost += message.usage.cost.total;
    node.ownUsage = { inputTokens: usage.input, outputTokens: usage.output, cost: usage.cost };
    node.usage = { ...node.ownUsage };
  }

  function updateText(text: string, final: boolean): void {
    currentMessage ??= { id: `assistant:${++messageIndex}`, kind: "assistant", title: "Assistant", text: "", at: Date.now() };
    const combined = ownText + text;
    node.liveOutput = combined.slice(0, OUTPUT_CAP);
    node.outputTruncated ||= combined.length > OUTPUT_CAP;
    if (text) record({ ...currentMessage, text, ...(final ? { endedAt: Date.now() } : {}) });
    if (final) {
      ownText = node.liveOutput;
      currentMessage = undefined;
    }
  }

  if (node.timeoutS !== undefined) {
    node.timeoutTimer = setTimeout(() => {
      timeoutHit = true;
      void session.abort();
    }, node.timeoutS * 1000);
  }

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (registry.nodes.get(node.name) !== node || TERMINAL_STATUSES.includes(node.status)) return;
    if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && seedMessages.has(event.message)) return;
    node.lastActivityAt = Date.now();
    if (event.type === "message_start" && event.message.role === "user") {
      const text = contentText(event.message.content);
      if (!awaitingTask || text !== node.prompt) transcript.user(`user:${++transcriptIndex}`, text);
      awaitingTask = false;
    }
    if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant" && !accounted.has(event.message)) {
      if (event.type === "message_start" || !transcriptMessageId) transcriptMessageId = `assistant:${++transcriptIndex}`;
      transcript.assistant(transcriptMessageId, event.message, event.type !== "message_end");
      for (const part of event.message.content) if (part.type === "toolCall") transcript.tool(part);
      if (event.type === "message_end") transcriptMessageId = undefined;
    }
    if (event.type === "tool_execution_start") transcript.tool({ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args }, true);
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const partial = event.type === "tool_execution_update";
      transcript.result(event.toolCallId, event.toolName, partial ? event.partialResult : event.result, !partial && event.isError, partial);
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      currentMessage = undefined;
      node.phase = "Generating response";
    } else if (event.type === "message_update" && event.message.role === "assistant") {
      node.phase = "Generating response";
      updateText(contentText(event.message.content), false);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      sawMessageEnd = true;
      if (!accounted.has(event.message)) updateText(contentText(event.message.content), true);
      account(event.message);
    } else if (event.type === "turn_start") {
      node.phase = "Generating response";
    } else if (event.type === "turn_end") {
      turns += 1;
      node.turns = turns;
    } else if (event.type === "tool_execution_start") {
      const entry: ActivityEntry = {
        id: `tool:${event.toolCallId}`, kind: "tool", title: toolTitle(event.toolName, event.args),
        text: "", at: Date.now(), state: "running",
      };
      activeTools.set(event.toolCallId, entry);
      record(entry);
    } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const entry = activeTools.get(event.toolCallId);
      const text = contentText((event.type === "tool_execution_end" ? event.result : event.partialResult)?.content);
      if (entry) {
        entry.text = text.slice(-ACTIVITY_ENTRY_CHARS);
        entry.truncated ||= text.length > ACTIVITY_ENTRY_CHARS;
        if (event.type === "tool_execution_end") {
          entry.state = event.isError ? "error" : "done";
          entry.endedAt = Date.now();
          activeTools.delete(event.toolCallId);
        }
        record({ ...entry });
      }
      lastToolActivity = Date.now();
    } else if (event.type === "agent_end" && !sawMessageEnd) {
      // Compatibility for event sources that only expose run-level usage.
      for (const message of event.messages) {
        if (message.role === "assistant" && !seedMessages.has(message) && !accounted.has(message)) {
          transcript.assistant(transcriptMessageId ?? `assistant:${++transcriptIndex}`, message, false);
          transcriptMessageId = undefined;
        }
        account(message);
      }
    } else if (event.type === "auto_retry_start" || event.type === "auto_retry_end" || event.type === "compaction_start" || event.type === "compaction_end") {
      node.phase = event.type.replaceAll("_", " ");
      record({ id: `lifecycle:${node.activity?.revision ?? 0}`, kind: "state", title: node.phase, text: "", at: Date.now() });
    }
    registry.touch?.(node.name);
  });

  async function finishInner(how: "completed" | "failed", error?: Error): Promise<void> {
    if (settled) return;
    settled = true;
    clearTimeout(node.timeoutTimer);
    unsubscribe();

    const current = registry.nodes.get(node.name);
    if (current !== node || TERMINAL_STATUSES.includes(current.status)) {
      engine?.pump();
      return; // cancel cascade settled it
    }

    for (const entry of activeTools.values()) record({ ...entry, state: "cancelled", endedAt: Date.now() });
    activeTools.clear();

    const text = node.liveOutput ?? session.messages
      .flatMap((message) => message.role === "assistant" && !seedMessages.has(message) ? [contentText(message.content)] : []).join("");
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const stopReason =
      lastAssistant && lastAssistant.role === "assistant" ? lastAssistant.stopReason : undefined;
    const errorMessage =
      how === "failed"
        ? error?.message
        : lastAssistant?.role === "assistant"
          ? lastAssistant.errorMessage
          : undefined;

    const outcomeUsage = {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cost: usage.cost,
    };

    if (timeoutHit) {
      // timeout_s expiry → error + adoption (§13). This takes precedence over
      // prompt() rejecting because the timeout itself called abort().
      registry.settle(node.name, {
        status: "error",
        output: text,
        partialOutput: text,
        error: `timeout after ${node.timeoutS}s`,
        stopReason: "timeout",
        usage: outcomeUsage,
        turns,
        ...(lastToolActivity !== undefined ? { lastToolActivity } : {}),
      });
      registry.onUnexpectedFailure(node.name);
      engine?.pump();
      return;
    }

    if (errorMessage !== undefined || how === "failed") {
      // Unexpected death: adoption path (§3).
      registry.settle(node.name, {
        status: "error",
        output: text,
        partialOutput: text,
        error: errorMessage ?? error?.message ?? "session failed",
        stopReason: stopReason ?? "error",
        usage: outcomeUsage,
        turns,
        ...(lastToolActivity !== undefined ? { lastToolActivity } : {}),
      });
      registry.onUnexpectedFailure(node.name);
      engine?.pump();
      return;
    }

    if (stopReason === "aborted") {
      // Aborted without a registry cancel (defensive): treat as cancelled.
      registry.settle(node.name, {
        status: "cancelled",
        output: text,
        stopReason: "aborted",
        usage: outcomeUsage,
        turns,
        ...(lastToolActivity !== undefined ? { lastToolActivity } : {}),
      });
      engine?.pump();
      return;
    }

    const status = stopReason === "length" ? "partial" : "done";
    registry.settle(node.name, {
      status,
      output: text,
      ...(stopReason !== undefined ? { stopReason } : {}),
      usage: outcomeUsage,
      turns,
      ...(lastToolActivity !== undefined ? { lastToolActivity } : {}),
    });

    // Normal termination with live children → merge-at-settle (§3).
    if (registry.hasLiveChildren(node.name)) await registry.mergeAtSettle(node.name);
    engine?.pump();
  }

  return async (how, error) => {
    try {
      await finishInner(how, error);
    } finally {
      if (!disposed) session.dispose?.();
      disposed = true;
      node.handle = undefined;
    }
  };
}

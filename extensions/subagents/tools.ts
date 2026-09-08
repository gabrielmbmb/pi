/**
 * The four subagent tools (DESIGN.md §2, §13): spawn_subagents,
 * collect_subagents, subagent_status, cancel_subagent.
 *
 * The same definitions serve two registrations:
 * - index.ts registers them for the main agent via `pi.registerTool` (the
 *   caller is rebuilt from the per-call `ctx`);
 * - session.ts passes them as `customTools` to child sessions, closure-bound
 *   to the child's own name (per-level `makeTools(caller)`), so ownership is
 *   enforced at every depth. At depth == MAX_DEPTH the spawn tool is unbound.
 *
 * Pure session logic lives in manager.ts; session creation is injected via
 * the SubagentEngine interface (implemented in session.ts) so this module has
 * no dependency on the live AgentSession machinery.
 */

import {
  DefaultResourceLoader,
  defineTool,
  type FileEntry,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type Api, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  CONTEXT_MODES,
  MAX_CONTEXT_TURNS,
  MAX_DEPTH,
  MAX_NAME_LEN,
  MAX_PROMPT_BYTES,
  MAX_TURNS,
  MAX_MODEL_REASON_CHARS,
  NAME_REGEX,
  ON_PARENT_ERROR_MODES,
  ROOT_AGENT_NAME,
  SNIPPET_CAP,
  SPAWN_TIMEOUT_MAX_S,
  THINKING_LEVELS,
  type ContextMode,
  type OnParentErrorMode,
  type ThinkingLevelName,
} from "./constants.ts";
import { loadRoutingConfig, type LoadedRoutingConfig } from "./config.ts";
import { buildSeedEntries } from "./context.ts";
import {
  buildRoutingBlock,
  modelLabel,
  resolveSpawnRouting,
  type ModelRegistryLike,
  type ParentModelInfo,
} from "./routing.ts";
import { TERMINAL_STATUSES, type SubagentNode, type SubagentRegistry } from "./manager.ts";

// ── caller / engine contracts ──────────────────────────────────────────────

/** Everything the tools need to know about the agent invoking them. */
export interface ToolCaller {
  /** `__main__` or the calling subagent's name. */
  name: string;
  depth: number;
  cwd: string;
  agentDir: string;
  /** The calling session's compaction-aware entries, captured once per spawn. */
  historyEntries(): SessionEntry[];
  /** The calling session's resolved model (inheritance default). */
  parentModel: ParentModelInfo;
  modelRegistry: ModelRegistryLike;
}

/**
 * Resolves the caller at execution time. The main registration rebuilds the
 * caller from the per-call extension ctx; child registrations return their
 * static closure-bound caller.
 */
export type CallerProvider = (ctx: unknown) => ToolCaller;

/** What session.ts needs to start one subagent session. */
export interface SpawnRequest {
  node: SubagentNode;
  prompt: string;
  seedEntries: FileEntry[];
  /** Full resolved Model object (passed to createAgentSession). */
  model: Model<Api>;
  thinking: string;
  cwd: string;
  agentDir: string;
  modelRegistry: ModelRegistryLike;
  /** Fresh routing block for the child's appendSystemPrompt. */
  routingBlock: string;
  /** One loader shared across all items in one spawn call. */
  resourceLoader?: DefaultResourceLoader;
}

/** Injected session machinery (session.ts). */
export interface SubagentEngine {
  registry: SubagentRegistry;
  /** Register the start spec for a queued node and pump the queue. */
  start(request: SpawnRequest): void;
  /** Pump newly available concurrency slots. */
  pump(): void;
  /** Drop queued start specs during real session teardown. */
  reset?(): void;
}

// ── validation (DESIGN.md §13) ─────────────────────────────────────────────

export interface SpawnItemInput {
  name?: unknown;
  prompt?: unknown;
  context?: unknown;
  context_turns?: unknown;
  model?: unknown;
  thinking?: unknown;
  onParentError?: unknown;
  max_turns?: unknown;
  timeout_s?: unknown;
  model_reason?: unknown;
}

export interface ValidatedSpawnItem {
  name: string;
  prompt: string;
  contextMode: ContextMode;
  contextTurns?: number;
  model?: string;
  thinking?: ThinkingLevelName;
  onParentError: OnParentErrorMode;
  maxTurns?: number;
  timeoutS?: number;
  modelReason?: string;
}

/**
 * Per-item spawn validation. Each item fails atomically with an actionable
 * error; the rest of the batch still spawns. Name uniqueness is checked
 * separately because it needs the registry.
 */
export function validateSpawnItem(item: SpawnItemInput): ValidatedSpawnItem | { error: string } {
  const where = (field: string, problem: string) => `${field}: ${problem}`;

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { error: "item: must be an object" };
  }
  if (typeof item.name !== "string" || !NAME_REGEX.test(item.name)) {
    return {
      error: where(
        "name",
        `must be 1-${MAX_NAME_LEN} chars of letters/digits/_/-, starting and ending with a letter or digit`,
      ),
    };
  }
  if (typeof item.prompt !== "string" || item.prompt.trim().length === 0) {
    return { error: where("prompt", "must be a non-empty task description") };
  }
  if (Buffer.byteLength(item.prompt, "utf8") > MAX_PROMPT_BYTES) {
    return { error: where("prompt", `longer than ${MAX_PROMPT_BYTES} bytes`) };
  }
  if (typeof item.context !== "string" || !(CONTEXT_MODES as readonly string[]).includes(item.context)) {
    return { error: where("context", "must be one of none | last_n_turns | all") };
  }
  const contextMode = item.context as ContextMode;

  let contextTurns: number | undefined;
  if (contextMode !== "last_n_turns" && item.context_turns !== undefined) {
    return { error: where("context_turns", `must be omitted when context is "${contextMode}"`) };
  }
  if (contextMode === "last_n_turns") {
    if (
      typeof item.context_turns !== "number" ||
      !Number.isInteger(item.context_turns) ||
      item.context_turns < 1 ||
      item.context_turns > MAX_CONTEXT_TURNS
    ) {
      return {
        error: where("context_turns", `required (1-${MAX_CONTEXT_TURNS}) when context is "last_n_turns"`),
      };
    }
    contextTurns = item.context_turns;
  }

  if (item.model !== undefined && (typeof item.model !== "string" || item.model.trim() === "")) {
    return { error: where("model", "must be a non-empty model reference") };
  }
  if (item.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(item.thinking as string)) {
    return { error: where("thinking", "must be a valid thinking level") };
  }
  if (
    item.onParentError !== undefined &&
    !(ON_PARENT_ERROR_MODES as readonly string[]).includes(item.onParentError as string)
  ) {
    return { error: where("onParentError", "must be adopt or kill") };
  }
  if (
    item.max_turns !== undefined &&
    (typeof item.max_turns !== "number" ||
      !Number.isInteger(item.max_turns) ||
      item.max_turns < 1 ||
      item.max_turns > MAX_TURNS)
  ) {
    return { error: where("max_turns", `must be an integer between 1 and ${MAX_TURNS}`) };
  }
  if (
    item.timeout_s !== undefined &&
    (typeof item.timeout_s !== "number" ||
      !Number.isInteger(item.timeout_s) ||
      item.timeout_s < 1 ||
      item.timeout_s > SPAWN_TIMEOUT_MAX_S)
  ) {
    return { error: where("timeout_s", `must be an integer between 1 and ${SPAWN_TIMEOUT_MAX_S}`) };
  }
  if (item.model_reason !== undefined && typeof item.model_reason !== "string") {
    return { error: where("model_reason", "must be a string") };
  }
  if (typeof item.model_reason === "string" && item.model_reason.length > MAX_MODEL_REASON_CHARS) {
    return { error: where("model_reason", `longer than ${MAX_MODEL_REASON_CHARS} chars`) };
  }

  return {
    name: item.name,
    prompt: item.prompt,
    contextMode,
    ...(contextTurns !== undefined ? { contextTurns } : {}),
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    ...(item.thinking !== undefined ? { thinking: item.thinking as ThinkingLevelName } : {}),
    onParentError: (item.onParentError as OnParentErrorMode | undefined) ?? "adopt",
    ...(typeof item.max_turns === "number" ? { maxTurns: item.max_turns } : {}),
    ...(typeof item.timeout_s === "number" ? { timeoutS: item.timeout_s } : {}),
    ...(typeof item.model_reason === "string" && item.model_reason.length > 0
      ? { modelReason: item.model_reason }
      : {}),
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function snippetOf(text: string, cap = SNIPPET_CAP): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function statusIcon(node: SubagentNode): string {
  switch (node.status) {
    case "queued":
      return "⏳";
    case "running":
      return "▶";
    case "merging":
      return "⟳";
    case "done":
      return "✓";
    case "partial":
      return "◐";
    case "error":
      return "✗";
    case "cancelled":
      return "⏹";
  }
}

/** True when `callerName` is the target itself, its ancestor, or the root. */
export function isAncestorOf(
  registry: SubagentRegistry,
  callerName: string,
  targetName: string,
): boolean {
  if (callerName === ROOT_AGENT_NAME) return true;
  let current: SubagentNode | undefined = registry.nodes.get(targetName);
  while (current) {
    if (current.name === callerName) return true;
    if (current.parentName === ROOT_AGENT_NAME) return false;
    current = registry.nodes.get(current.parentName);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── tool factory ───────────────────────────────────────────────────────────

export interface MakeToolsOptions {
  /** Bind the spawn tool (default true). session.ts unbinds it at MAX_DEPTH. */
  bindSpawn?: boolean;
}

/**
 * Build the four subagent tools bound to a caller provider. Pass
 * `bindSpawn: false` for children at max depth — the spawn tool is unbound
 * there (nothing left to spawn into), matching Claude Code's depth limit.
 */
export function makeSubagentTools(
  getCaller: CallerProvider,
  engine: SubagentEngine,
  options: MakeToolsOptions = {},
): ToolDefinition[] {
  const registry = engine.registry;
  const tools: ToolDefinition[] = [];

  const spawnTool = defineTool({
    name: "spawn_subagents",
    label: "Spawn Subagents",
    executionMode: "parallel",
    description:
      "Spawn background subagents for self-contained subtasks and fan out work in parallel. " +
      "Each subagent runs with its own context and the read/bash/edit/write tools; results are " +
      "retrieved with collect_subagents. Provide a complete, self-contained prompt per subagent — " +
      "context seeding (none | last_n_turns | all) supplies background conversation, not the task. " +
      "Pick model/thinking per the injected subagent routing guidance and record why in model_reason.",
    parameters: Type.Object({
      subagents: Type.Array(
        Type.Object({
          name: Type.String({
            description: `Unique name, 1-${MAX_NAME_LEN} chars [A-Za-z0-9_-], alnum start/end. Never reusable in a session.`,
          }),
          prompt: Type.String({ description: "Complete, self-contained task for the subagent." }),
          context: StringEnum(CONTEXT_MODES),
          context_turns: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_CONTEXT_TURNS }),
          ),
          model: Type.Optional(
            Type.String({ description: "Model override: 'provider/modelId' or bare id (per routing guidance)." }),
          ),
          thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
          onParentError: Type.Optional(StringEnum(ON_PARENT_ERROR_MODES)),
          max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TURNS })),
          timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: SPAWN_TIMEOUT_MAX_S })),
          model_reason: Type.Optional(
            Type.String({ description: "Why this model/thinking was chosen (audit), e.g. 'rule: reading files'." }),
          ),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const caller = getCaller(ctx);
      if (caller.depth >= MAX_DEPTH) throw new Error(`Spawning is disabled at depth ${MAX_DEPTH}`);
      const items = params.subagents as SpawnItemInput[];
      if (items.length === 0) throw new Error("subagents: at least one item is required");

      // File-level config errors block spawns entirely (DESIGN.md §6).
      let loaded: LoadedRoutingConfig;
      try {
        loaded = loadRoutingConfig(caller.agentDir, caller.cwd);
      } catch (error) {
        throw new Error(`Could not load subagents config: ${(error as Error).message}`);
      }
      if (loaded.fileErrors.length > 0) {
        throw new Error(
          `Spawn blocked — subagents config has errors (fix via /subagents config):\n` +
            loaded.fileErrors.map((fileError) => `- ${fileError.error}`).join("\n"),
        );
      }

      let routingBlock = "";
      try {
        routingBlock = buildRoutingBlock(loaded.config, caller.modelRegistry, loaded).block;
      } catch {
        routingBlock = ""; // strict no-op: guidance is never worth failing a spawn
      }

      // Capture the calling session's history once: same seed basis for the
      // whole batch and for parallel tool calls in one assistant message.
      const entries = safeHistoryEntries(caller);
      const resourceLoader = new DefaultResourceLoader({
        cwd: caller.cwd,
        agentDir: caller.agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        ...(routingBlock ? { appendSystemPrompt: [routingBlock] } : {}),
      });

      const results: Array<Record<string, unknown>> = [];
      for (const rawItem of items) {
        const item = validateSpawnItem(rawItem);
        if ("error" in item) {
          const rawName =
            rawItem && typeof rawItem === "object" && !Array.isArray(rawItem)
              ? (rawItem as SpawnItemInput).name
              : undefined;
          results.push({ name: rawName ?? "(unnamed)", status: "error", error: item.error });
          continue;
        }

        const routing = resolveSpawnRouting(
          { ...(item.model !== undefined ? { model: item.model } : {}), ...(item.thinking !== undefined ? { thinking: item.thinking } : {}) },
          loaded.config,
          caller.modelRegistry,
          caller.parentModel,
        );
        if (routing.error) {
          const candidates =
            routing.candidates && routing.candidates.length > 0 ? ` Candidates: ${routing.candidates.join(", ")}` : "";
          results.push({ name: item.name, status: "error", error: `${routing.error}${candidates}` });
          continue;
        }

        let node: SubagentNode;
        try {
          node = registry.register({
            name: item.name,
            parentName: caller.name,
            contextMode: item.contextMode,
            ...(item.contextTurns !== undefined ? { contextTurns: item.contextTurns } : {}),
            model: modelLabel(routing.model),
            thinking: routing.thinking,
            ...(item.modelReason !== undefined ? { modelReason: item.modelReason } : {}),
            onParentError: item.onParentError,
            ...(item.maxTurns !== undefined ? { maxTurns: item.maxTurns } : {}),
            ...(item.timeoutS !== undefined ? { timeoutS: item.timeoutS } : {}),
            prompt: item.prompt,
            promptSnippet: snippetOf(item.prompt.replace(/\s+/g, " ").trim(), 80),
          });
        } catch (error) {
          results.push({ name: item.name, status: "error", error: (error as Error).message });
          continue;
        }

        let seedEntries: FileEntry[] = [];
        try {
          seedEntries = buildSeedEntries({
            mode: item.contextMode,
            ...(item.contextTurns !== undefined ? { contextTurns: item.contextTurns } : {}),
            entries,
          }).entries;
        } catch (error) {
          registry.cancelSubtree(node.name, { stopReason: `invalid seed: ${(error as Error).message}` });
          results.push({ name: item.name, status: "error", error: (error as Error).message });
          continue;
        }

        engine.start({
          node,
          prompt: item.prompt,
          seedEntries,
          // Routing deliberately uses a structural view; the SDK registry supplies full models.
          model: routing.model as Model<Api>,
          thinking: routing.thinking,
          cwd: caller.cwd,
          agentDir: caller.agentDir,
          modelRegistry: caller.modelRegistry,
          routingBlock,
          resourceLoader,
        });

        const queued = node.status === "queued";
        results.push({
          name: node.name,
          status: queued ? "queued" : "running",
          ...(queued ? { queuePosition: registry.queuePosition(node.name) } : {}),
          model: node.model,
          thinking: node.thinking,
          ...(routing.warnings.length > 0 ? { warnings: routing.warnings } : {}),
        });
      }

      const spawned = results.filter((result) => result.status !== "error").length;
      const text =
        `${spawned}/${items.length} spawned.\n` +
        results
          .map((result) =>
            result.status === "error"
              ? `✗ ${result.name}: ${result.error}`
              : `▶ ${result.name} ${result.status}${result.queuePosition !== undefined ? ` (queue #${result.queuePosition})` : ""} on ${result.model} (thinking: ${result.thinking})${Array.isArray(result.warnings) && result.warnings.length > 0 ? ` ⚠ ${result.warnings.join("; ")}` : ""}`,
          )
          .join("\n") +
        "\nCall collect_subagents with these names to wait for results.";

      return {
        content: [{ type: "text", text }],
        details: { spawned: results },
      };
    },
  });
  if (options.bindSpawn !== false) tools.push(spawnTool);

  const collectTool = defineTool({
    name: "collect_subagents",
    label: "Collect Subagents",
    description:
      "Wait for spawned subagents and return their results. Blocks until all listed subagents " +
      "finish (or timeout_s elapses — returns what's done without cancelling the rest). One child " +
      "erroring does not fail the batch. Only direct children can be collected.",
    parameters: Type.Object({
      names: Type.Array(Type.String(), { minItems: 1 }),
      timeout_s: Type.Optional(
        Type.Integer({ minimum: 0, maximum: SPAWN_TIMEOUT_MAX_S, description: "0 (default) = wait indefinitely." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const caller = getCaller(ctx);
      const names = params.names as string[];
      if (names.length === 0) throw new Error("names: at least one subagent name is required");

      const validation = registry.validateCollect(caller.name, names);
      if (validation !== true) throw new Error(validation.error);

      const nodes = names.map((name) => registry.nodes.get(name)!);
      const timeoutMs = params.timeout_s ? (params.timeout_s as number) * 1000 : 0;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;

      const rowText = () => {
        const rows = nodes.map((node) => `${statusIcon(node)} ${node.name} ${node.status}`);
        const done = nodes.filter((node) => TERMINAL_STATUSES.includes(node.status)).length;
        return `${rows.join("\n")}\n${done}/${nodes.length} done`;
      };

      for (;;) {
        onUpdate?.({ content: [{ type: "text", text: rowText() }], details: {} });
        if (nodes.every((node) => TERMINAL_STATUSES.includes(node.status))) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await Promise.race([
          Promise.all(nodes.map((node) => node.done)),
          sleep(Math.min(remaining, 250)),
          abortedSignal(signal),
        ]);
        if (signal?.aborted) break; // Esc: stop waiting; survivors keep running
      }

      const { results, usage } = registry.fetchResults(names, caller.name);
      const statuses = names
        .map((name) => {
          const node = registry.nodes.get(name)!;
          return `${name}: ${node.status}`;
        })
        .join(", ");

      const payload = results
        .map(
          (result) =>
            `── ${result.name} (${result.status}) ──\n` +
            (result.error !== undefined ? `error: ${result.error}\n` : "") +
            (result.stopReason !== undefined ? `stop: ${result.stopReason}\n` : "") +
            `model: ${result.model ?? "?"}${result.thinking !== undefined ? ` (${result.thinking})` : ""}` +
            `${result.mergedChildren !== undefined ? ` merged: ${result.mergedChildren} children` : ""}\n` +
            `usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / $${result.usage.cost.toFixed(4)} (${result.turns} turns, ${result.durationSec}s)\n` +
            `${result.output}`,
        )
        .join("\n\n");

      const text =
        `${statuses}\n` +
        `combined: ${usage.inputTokens} in / ${usage.outputTokens} out / $${usage.cost.toFixed(4)}\n\n` +
        (payload || "(no outputs)");

      return {
        content: [{ type: "text", text }],
        details: { results, statuses },
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: usage.inputTokens + usage.outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
        },
      };
    },
  });
  tools.push(collectTool);

  tools.push(
    defineTool({
      name: "subagent_status",
      label: "Subagent Status",
      description:
        "Non-blocking status of your subagents (one by name, or all). Includes short output " +
        "snippets for finished ones. Visible to any ancestor of the subagent.",
      parameters: Type.Object({
        name: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const caller = getCaller(ctx);
        const nodes = [...registry.nodes.values()].sort((a, b) => a.spawnIndex - b.spawnIndex);
        const visible = nodes.filter((node) =>
          params.name !== undefined
            ? node.name === params.name
            : isAncestorOf(registry, caller.name, node.name),
        );
        if (params.name !== undefined) {
          const target = registry.nodes.get(params.name as string);
          if (!target || !isAncestorOf(registry, caller.name, target.name)) {
            throw new Error(`No visible subagent named "${params.name}"`);
          }
        }

        const lines = visible.map((node) => {
          const result = registry.store.peek(node.name);
          const base = `${statusIcon(node)} ${node.name} — ${node.status}` +
            (node.adoptedFrom !== undefined ? ` (adopted from ${node.adoptedFrom})` : "") +
            ` · depth ${node.depth} · ${node.model ?? "?"}` +
            (node.turns > 0 ? ` · ${node.turns} turns` : "");
          if (!result) return base;
          const extra =
            result.status === "error" && result.error !== undefined
              ? `error: ${result.error}`
              : snippetOf(result.output.trim());
          return `${base}\n    ${extra.replace(/\n/g, " ")}`;
        });

        const text =
          lines.length > 0
            ? lines.join("\n")
            : "No subagents yet. Spawn some with spawn_subagents.";
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
  );

  tools.push(
    defineTool({
      name: "cancel_subagent",
      label: "Cancel Subagent",
      description:
        "Cancel a subagent and its whole subtree (recursively aborts running sessions and " +
        "cancels queued ones), or omit the name to cancel your entire subtree. Already-settled " +
        "results are kept and still collectable.",
      parameters: Type.Object({
        name: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const caller = getCaller(ctx);
        const targetName = (params.name as string | undefined) ?? undefined;

        if (targetName === undefined) {
          const cancelled = registry.cancelSubtree(caller.name);
          return {
            content: [
              {
                type: "text",
                text:
                  cancelled.length > 0
                    ? `Cancelled subtree of ${caller.name}: ${cancelled.join(", ")}`
                    : `Nothing left to cancel under ${caller.name}`,
              },
            ],
            details: { cancelled },
          };
        }

        const target = registry.nodes.get(targetName);
        if (!target) throw new Error(`Unknown subagent "${targetName}"`);
        if (!isAncestorOf(registry, caller.name, targetName)) {
          throw new Error(`"${targetName}" is not yours to cancel (not a descendant)`);
        }
        const cancelled = registry.cancelSubtree(targetName);
        return {
          content: [{ type: "text", text: `Cancelled: ${cancelled.join(", ")}` }],
          details: { cancelled },
        };
      },
    }),
  );

  return tools;
}

function safeHistoryEntries(caller: ToolCaller): SessionEntry[] {
  try {
    return caller.historyEntries();
  } catch {
    return []; // never fail a spawn because history could not be read
  }
}

function abortedSignal(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

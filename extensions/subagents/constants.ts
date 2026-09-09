/**
 * Constants and small shared enums for the subagents extension.
 *
 * Values come from DESIGN.md §8 (constants) and §13 (validation bounds).
 * Keep this module dependency-free so every other module can import it.
 */

/** Delegation tree depth limit. Root (`__main__`) is depth 0; spawning is blocked at depth 3. */
export const MAX_DEPTH = 3;

/** Concurrently running subagents allowed; spawns beyond this are queued. */
export const MAX_CONCURRENT = 4;


/** Merge-at-settle wait before cancelling straggler children, in seconds. */
export const MERGE_TIMEOUT_S = 300;

/** Stored output cap per subagent, in characters. */
export const OUTPUT_CAP = 50_000;

/** Snippet cap injected by subagent_status, in characters. */
export const SNIPPET_CAP = 4_000;

/** How long done-but-uncollected results stay in the store before TTL eviction. */
export const UNCOLLECTED_TTL_MS = 3_600_000;

/** LRU cap of done-but-uncollected results before TTL eviction applies. */
export const RESULT_STORE_MAX = 20;

export const DEFAULT_ON_PARENT_ERROR = "adopt";

/** Routing config limits (DESIGN.md §6/§8). */
export const MAX_RULES = 20;
export const MAX_RULE_DESC_CHARS = 200;
export const GUIDANCE_SNIPPET_CHARS = 60;

/** Spawn validation bounds (DESIGN.md §13). */
export const MAX_NAME_LEN = 40;
export const MAX_PROMPT_BYTES = 20 * 1024;
export const MAX_CONTEXT_TURNS = 30;
export const SPAWN_TIMEOUT_MAX_S = 3600;
/** Audit metadata storage cap, not a spawn rejection limit. */
export const MAX_MODEL_REASON_CHARS = 1024;

/** How many model candidates to list in resolution errors. */
export const MAX_MODEL_CANDIDATES = 5;

/**
 * Valid subagent names: 1–40 chars of `[A-Za-z0-9_-]`, must start and end
 * alphanumeric. Deliberately a strict subset of pi's `assertValidSessionId`
 * (no `.`), because the in-memory session id equals the name.
 */
export const NAME_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38}[A-Za-z0-9])?$/;

/** Thinking levels accepted by spawn_subagents (mirrors pi's ThinkingLevel). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevelName {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export const CONTEXT_MODES = ["none", "last_n_turns", "all"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export function isContextMode(value: unknown): value is ContextMode {
  return typeof value === "string" && (CONTEXT_MODES as readonly string[]).includes(value);
}

export const ON_PARENT_ERROR_MODES = ["adopt", "kill"] as const;
export type OnParentErrorMode = (typeof ON_PARENT_ERROR_MODES)[number];

/** Parent name used for nodes spawned by the main agent (depth 0). */
export const ROOT_AGENT_NAME = "__main__";

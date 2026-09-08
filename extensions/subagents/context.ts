/**
 * History → seed-messages builder for subagent sessions (DESIGN.md §5).
 *
 * Seeds are built from the calling session's compaction-aware entries
 * (`sessionManager.buildContextEntries()`), uniform at every delegation depth:
 *
 * - `none`          — no seed; system prompt + task prompt only.
 * - `last_n_turns`  — messages since the Nth-last user-role entry.
 * - `all`           — full active branch.
 *
 * Trim rule (precise): the seed is everything *strictly before* the last
 * user-role entry preceding the in-flight assistant message that contains the
 * spawn tool call. This excludes the current run — the triggering user
 * request, the spawn tool-call message itself, and (because steers are only
 * delivered after the current assistant turn's tool calls finish) any steers —
 * while keeping all earlier history. Deterministic for batch spawns and for
 * parallel tool calls in one assistant message, since every spawn in the same
 * run sees the same entries.
 *
 * Entry → seed conversion (verified against pi 0.85.1):
 * - `message` entries      → seed messages (image parts stripped, v1)
 * - `custom_message`       → kept (participates in child context as user role)
 * - `compaction`           → one user-role summary text message (a pass-through
 *                            would dangle: `firstKeptEntryId` no longer matches
 *                            after the id rebuild)
 * - `branch_summary`       → dropped
 * - everything else        → dropped (labels, model changes, custom entries, …)
 * Ids are rebuilt with a fresh linear parent chain so the seed is a well-formed
 * single-branch session for `SessionManager.inMemory(cwd, { id }, entries)`.
 *
 * Pure/UI-free for unit testing.
 */

import type {
  CompactionEntry,
  FileEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import { MAX_CONTEXT_TURNS, type ContextMode } from "./constants.ts";

type SeedMessage = SessionMessageEntry["message"];

/** True for entries that project to a user-role message in LLM context. */
function isUserEntry(entry: SessionEntry): boolean {
  if (entry.type === "message") return entry.message.role === "user";
  return entry.type === "custom_message" || entry.type === "compaction";
}

function isToolResultMessageEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "toolResult";
}

/**
 * Index of the trim boundary: the seed is `entries.slice(0, result)`.
 *
 * DESIGN.md §5 states this as "strictly before the last user-message entry
 * preceding the in-flight assistant message that contains the spawn tool
 * call". At spawn-tool execution time nothing user-role can follow that
 * in-flight assistant entry — toolResults carry role "toolResult", and
 * steers/queued messages are only delivered after the current assistant
 * turn's tool calls finish — so the last user-role entry in the list *is* the
 * one preceding the in-flight assistant message: the current run's trigger.
 * Seeding from before it excludes the current run while keeping all earlier
 * history. Returns 0 when there is no user entry at all (nothing to seed).
 */
export function findTrimIndex(entries: SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserEntry(entries[i]!)) return i;
  }
  return 0;
}

/** Indices of user-role entries in `entries[0..endExclusive)`, in order. */
function userEntryIndices(entries: SessionEntry[], endExclusive: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < endExclusive; i++) {
    if (isUserEntry(entries[i]!)) indices.push(i);
  }
  return indices;
}

/** Strip image content parts (v1 drops images from seeds unconditionally). */
function stripImages(message: SeedMessage): SeedMessage {
  if (!("content" in message)) return message;
  const content = message.content;
  if (typeof content !== "string" && Array.isArray(content)) {
    const filtered = content.filter((part) => (part as { type?: string }).type !== "image");
    if (filtered.length === content.length) return message;
    return { ...message, content: filtered } as SeedMessage;
  }
  return message;
}

function entryTimestampMs(entry: SessionEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Convert a slice of context entries into seed entries with a fresh linear
 * parent chain. The returned list contains no session header;
 * `SessionManager.inMemory(cwd, { id: name }, entries)` prepends one.
 */
export function toSeedEntries(slice: SessionEntry[]): FileEntry[] {
  const seeds: SessionEntry[] = [];
  let previousId: string | null = null;

  const push = (entry: SessionEntry) => {
    const id = `sa-seed-${seeds.length}`;
    entry.id = id;
    entry.parentId = previousId;
    previousId = id;
    seeds.push(entry);
  };

  for (const source of slice) {
    if (source.type === "message") {
      push({
        ...source,
        message: stripImages(source.message),
      });
    } else if (source.type === "custom_message") {
      const content = source.content;
      if (typeof content !== "string" && Array.isArray(content)) {
        push({
          ...source,
          content: content.filter((part) => (part as { type?: string }).type !== "image"),
        });
      } else {
        push({ ...source });
      }
    } else if (source.type === "compaction") {
      push(compactionToUserMessage(source));
    }
    // branch_summary and non-context entries (label, model_change, custom, …) are dropped.
  }

  // A compaction-kept slice can start with toolResults whose tool-call
  // assistant message was compacted away; providers reject orphan tool
  // results, so drop leading toolResult entries.
  while (seeds.length > 0 && isToolResultMessageEntry(seeds[0]!)) seeds.shift();

  // Rebuild the chain after dropping orphaned leading tool results.
  let previous: string | null = null;
  for (const [index, seed] of seeds.entries()) {
    seed.id = `sa-seed-${index}`;
    seed.parentId = previous;
    previous = seed.id;
  }

  return seeds;
}

function compactionToUserMessage(entry: CompactionEntry): SessionMessageEntry {
  return {
    type: "message",
    id: "", // assigned by push()
    parentId: null,
    timestamp: entry.timestamp,
    message: {
      role: "user",
      content: `[Summary of earlier conversation]\n\n${entry.summary}`,
      timestamp: entryTimestampMs(entry),
    } as SeedMessage,
  };
}

export interface BuildSeedOptions {
  mode: ContextMode;
  /** Required iff mode is "last_n_turns"; 1–MAX_CONTEXT_TURNS. */
  contextTurns?: number;
  /**
   * Compaction-aware entries of the calling session
   * (`sessionManager.buildContextEntries()`), including the in-flight
   * assistant message when the spawn tool is executing.
   */
  entries: SessionEntry[];
}

export interface SeedResult {
  /** Seed entries (no session header) for `SessionManager.inMemory`. */
  entries: FileEntry[];
  /** Entries excluded by the trim rule (diagnostics). */
  trimmedEntries: number;
  /** User-role turns included in the seed (diagnostics; 0 for mode "none"). */
  includedTurns: number;
}

/**
 * Build the seed entries for one subagent. Throws on invalid
 * mode/`contextTurns` combinations — the spawn tool surfaces these as
 * per-item validation errors.
 */
export function buildSeedEntries(options: BuildSeedOptions): SeedResult {
  const { mode, entries } = options;

  if (mode === "none") {
    return { entries: [], trimmedEntries: entries.length, includedTurns: 0 };
  }

  if (mode === "last_n_turns") {
    const turns = options.contextTurns;
    if (
      typeof turns !== "number" ||
      !Number.isInteger(turns) ||
      turns < 1 ||
      turns > MAX_CONTEXT_TURNS
    ) {
      throw new Error(
        `context_turns must be an integer between 1 and ${MAX_CONTEXT_TURNS} when context is "last_n_turns"`,
      );
    }

    const trimIndex = findTrimIndex(entries);
    const userIndices = userEntryIndices(entries, trimIndex);
    const start =
      userIndices.length >= turns ? userIndices[userIndices.length - turns]! : 0;
    const slice = entries.slice(start, trimIndex);
    return {
      entries: toSeedEntries(slice),
      trimmedEntries: entries.length - slice.length,
      includedTurns: Math.min(userIndices.length, turns),
    };
  }

  // mode === "all"
  const trimIndex = findTrimIndex(entries);
  const slice = entries.slice(0, trimIndex);
  return {
    entries: toSeedEntries(slice),
    trimmedEntries: entries.length - trimIndex,
    includedTurns: userEntryIndices(entries, trimIndex).length,
  };
}

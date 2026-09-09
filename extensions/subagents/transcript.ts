import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { plainText } from "./activity.ts";

/** Inspection copies only: never replayed into a session or used to execute tools. */
export const TRANSCRIPT_MAX_ENTRIES = 200;
export const TRANSCRIPT_MAX_CHARS = 512_000;
export const TRANSCRIPT_PAYLOAD_CHARS = 32_000;

type TextContent = { type: "text"; text: string };
export interface TranscriptResult {
  content: TextContent[];
  details?: unknown;
  isError: boolean;
}
interface EntryBase { id: string; truncated?: boolean }
export type TranscriptEntry =
  | (EntryBase & { kind: "user"; text: string })
  | (EntryBase & { kind: "assistant"; message: AssistantMessage; streaming: boolean })
  | (EntryBase & { kind: "tool"; call: ToolCall; started: boolean; complete: boolean; result?: TranscriptResult });

/** Bound both depth and breadth, detach mutable SDK values, and remove terminal controls. */
function snapshot(value: unknown): { value: unknown; truncated: boolean } {
  let remaining = TRANSCRIPT_PAYLOAD_CHARS;
  let nodes = 2048;
  let truncated = false;
  const visit = (value: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 12 || remaining <= 0) { truncated = true; return null; }
    if (typeof value === "string") {
      const text = plainText(value);
      const cap = Math.max(0, remaining - 32);
      remaining -= Math.min(text.length, cap) + 32;
      if (text.length <= cap) return text;
      truncated = true;
      if (cap < 32) return "…".slice(0, cap);
      const half = Math.floor((cap - 32) / 2);
      const head = text.slice(0, half).replace(/[\uD800-\uDBFF]$/, "");
      const tail = half ? text.slice(-half).replace(/^[\uDC00-\uDFFF]/, "") : "";
      return `${head}\n[… inspector copy truncated …]\n${tail}`;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") { remaining -= 24; return value; }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        if (remaining <= 0 || nodes <= 0 || result.length >= 256) { truncated = true; break; }
        result.push(visit(item, depth + 1));
      }
      return result;
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        if (remaining <= key.length + 8 || nodes <= 0) { truncated = true; break; }
        remaining -= key.length + 8;
        result[key] = visit(item, depth + 1);
      }
      return result;
    }
    return undefined;
  };
  return { value: visit(value, 0), truncated };
}

/** Bounded, structured counterparts of the worker's own messages and tool executions. */
export class TranscriptLog {
  readonly entries: TranscriptEntry[] = [];
  revision = 0;
  dropped = 0;
  private chars = 2; // enclosing array; per-entry sizes include a separator
  private readonly sizes = new Map<string, number>();

  private put(entry: TranscriptEntry): void {
    const index = this.entries.findIndex((item) => item.id === entry.id);
    this.chars -= this.sizes.get(entry.id) ?? 0;
    const size = JSON.stringify(entry).length + 1;
    this.sizes.set(entry.id, size);
    this.chars += size;
    if (index < 0) this.entries.push(entry);
    else this.entries[index] = entry;
    while (this.entries.length > TRANSCRIPT_MAX_ENTRIES || this.chars > TRANSCRIPT_MAX_CHARS) {
      const removed = this.entries.shift()!;
      this.chars -= this.sizes.get(removed.id) ?? 0;
      this.sizes.delete(removed.id);
      this.dropped++;
    }
    this.revision++;
  }

  user(id: string, text: string): void {
    const copy = snapshot(text);
    this.put({ id, kind: "user", text: copy.value as string, truncated: copy.truncated });
  }

  assistant(id: string, message: AssistantMessage, streaming: boolean): void {
    // No inherited history, thinking, signatures, or provider diagnostics. Tool
    // arguments have their own correlated entries, not a second retained copy.
    const visible = message.content.filter((part) => part.type === "text" || part.type === "toolCall")
      .map((part) => part.type === "text" ? { type: "text", text: part.text }
        : { type: "toolCall", id: part.id, name: part.name, arguments: {} });
    const content = snapshot(visible);
    const copy: AssistantMessage = {
      role: "assistant", content: (content.value as AssistantMessage["content"]).filter((part) =>
        part && (part.type === "text" && typeof part.text === "string" || part.type === "toolCall")),
      api: message.api, provider: message.provider, model: message.model,
      usage: { ...message.usage, cost: { ...message.usage?.cost } },
      stopReason: message.stopReason, timestamp: message.timestamp,
      ...(message.errorMessage ? { errorMessage: plainText(message.errorMessage).slice(0, 2000) } : {}),
    };
    this.put({ id, kind: "assistant", message: copy, streaming, truncated: content.truncated });
  }

  tool(call: ToolCall, started = false): void {
    const id = `tool:${call.id}`;
    const previous = this.entries.find((entry) => entry.id === id);
    const args = snapshot(call.arguments);
    this.put({
      ...(previous?.kind === "tool" ? previous : {}), id, kind: "tool",
      call: { type: "toolCall", id: call.id, name: plainText(call.name), arguments: (args.value ?? {}) as ToolCall["arguments"] },
      started: started || previous?.kind === "tool" && previous.started,
      complete: previous?.kind === "tool" && previous.complete,
      truncated: args.truncated || previous?.truncated,
    });
  }

  result(callId: string, name: string, result: { content?: unknown; details?: unknown }, isError: boolean, partial: boolean): void {
    const id = `tool:${callId}`;
    if (!this.entries.some((entry) => entry.id === id)) this.tool({ type: "toolCall", id: callId, name, arguments: {} }, true);
    const entry = this.entries.find((entry) => entry.id === id);
    if (entry?.kind !== "tool") return;
    const raw = Array.isArray(result.content) ? result.content : [];
    const content = snapshot(raw.filter((part) => part?.type === "text" || part?.type === "image").map((part) =>
      ({ type: "text", text: part.type === "text" ? String(part.text ?? "") : `[Image (${part.mimeType ?? "unknown type"}) omitted from inspector]` })));
    const details = snapshot(result.details);
    this.put({ ...entry, started: true, complete: !partial, truncated: entry.truncated || content.truncated || details.truncated,
      result: { content: (content.value as TextContent[]).filter((part) => part && typeof part.text === "string"), details: details.value, isError } });
  }

  finish(status: string, error?: string): void {
    error = error === undefined ? undefined : plainText(error).slice(0, 2000);
    for (const entry of [...this.entries]) {
      if (entry.kind === "assistant" && entry.streaming) this.put({ ...entry, streaming: false,
        message: { ...entry.message, ...(status === "cancelled" || status === "partial" ? { stopReason: "aborted" as const }
          : status === "error" ? { stopReason: "error" as const, errorMessage: error } : {}) } });
      if (entry.kind !== "tool" || entry.complete) continue;
      this.put({ ...entry, complete: true, result: {
        ...entry.result, isError: true,
        content: [...(entry.result?.content ?? []), { type: "text", text: plainText(error ?? "Operation aborted before tool completion").slice(0, 2000) }],
      } });
    }
  }
}

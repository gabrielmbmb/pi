/** Bounded, UI-independent telemetry. Never sent to the parent model. */
export const ACTIVITY_MAX_EVENTS = 200;
export const ACTIVITY_MAX_CHARS = 128_000;
export const ACTIVITY_ENTRY_CHARS = 12_000;

export interface ActivityEntry {
  id: string;
  kind: "assistant" | "tool" | "state";
  title: string;
  text: string;
  at: number;
  endedAt?: number;
  state?: "running" | "done" | "error" | "cancelled";
  truncated?: boolean;
}

export class ActivityLog {
  readonly entries: ActivityEntry[] = [];
  revision = 0;
  dropped = 0;

  upsert(entry: ActivityEntry): void {
    const existing = this.entries.findIndex((item) => item.id === entry.id);
    const bounded = {
      ...entry,
      title: entry.title.slice(0, 500),
      text: entry.text.slice(-ACTIVITY_ENTRY_CHARS),
      truncated: entry.truncated || entry.text.length > ACTIVITY_ENTRY_CHARS,
    };
    if (existing >= 0) this.entries[existing] = bounded;
    else this.entries.push(bounded);
    let chars = this.entries.reduce((sum, item) => sum + item.text.length + item.title.length, 0);
    while (this.entries.length > ACTIVITY_MAX_EVENTS || chars > ACTIVITY_MAX_CHARS) {
      const removed = this.entries.shift()!;
      chars -= removed.text.length + removed.title.length;
      this.dropped += 1;
    }
    this.revision += 1;
  }
}

/** Strip terminal controls from untrusted task/tool text before composing UI. */
export function plainText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => part?.type === "text" ? String(part.text ?? "") : "").filter(Boolean).join("\n");
}

export function toolTitle(name: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const detail = input.command ?? input.path ?? input.name ?? input.names;
  return plainText(`${name}${detail !== undefined ? `: ${Array.isArray(detail) ? detail.join(", ") : String(detail)}` : ""}`)
    .replace(/\s+/g, " ").slice(0, 500);
}

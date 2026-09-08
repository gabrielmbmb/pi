/** Compact transcript/footer formatting. Interactive UI lives in inspector/. */
import { TERMINAL_STATUSES, type SubagentNode, type SubagentRegistry } from "./manager.ts";
import { ROOT_AGENT_NAME } from "./constants.ts";

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}m${rounded % 60}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function statusSymbol(node: SubagentNode): string {
  return { queued: "…", running: "●", merging: "⟳", done: "✓", partial: "◐", error: "✗", cancelled: "■" }[node.status];
}

export function statusColor(status: SubagentNode["status"]): "success" | "error" | "warning" | "accent" {
  if (status === "done") return "success";
  if (status === "error") return "error";
  if (status === "cancelled" || status === "partial") return "warning";
  return "accent";
}

export interface SubagentCounts {
  running: number;
  queued: number;
  /** Collectable results, not a claim that the human has reviewed them. */
  toReview: number;
}

export function getSubagentCounts(registry: SubagentRegistry): SubagentCounts {
  let running = 0;
  let queued = 0;
  let toReview = 0;
  for (const node of registry.nodes.values()) {
    if (node.status === "running" || node.status === "merging") running += 1;
    else if (node.status === "queued") queued += 1;
    if (TERMINAL_STATUSES.includes(node.status) && (registry.store.isAvailable?.(node.name) ?? registry.store.has(node.name))) toReview += 1;
  }
  return { running, queued, toReview };
}

export function formatSubagentCountSummary(counts: SubagentCounts): string | undefined {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  if (counts.toReview > 0) parts.push(`${counts.toReview} awaiting collection`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatSubagentStatus(registry: SubagentRegistry): string | undefined {
  const counts = getSubagentCounts(registry);
  const nodes = [...registry.nodes.values()];
  const waiting = nodes.filter((node) => node.status === "merging").length;
  const failed = nodes.filter((node) => node.status === "error" && (registry.store.isAvailable?.(node.name) ?? registry.store.has(node.name))).length;
  const summary = formatSubagentCountSummary({ ...counts, running: counts.running - waiting });
  const parts = [summary, waiting ? `${waiting} waiting on children` : undefined, failed ? `${failed} failed` : undefined].filter(Boolean);
  return parts.length ? `Subagents: ${parts.join(" · ")} · /subagents` : undefined;
}

export function nodeLine(node: SubagentNode, now: number, indent: string): string {
  const elapsed = node.startedAt !== undefined ? ` · ${formatDuration(Math.max(0, ((node.endedAt ?? now) - node.startedAt) / 1000))}` : "";
  const tokens = node.usage.inputTokens + node.usage.outputTokens;
  return `${indent}${statusSymbol(node)} ${node.name}${node.adoptedFrom ? " (adopted)" : ""} [${node.status}]${elapsed}` +
    `${node.model ? ` · ${node.model}` : ""}${node.modelReason ? ` · reason: ${node.modelReason}` : ""}` +
    `${tokens > 0 ? ` · ${formatTokens(tokens)} tok` : ""}${node.turns > 0 ? ` · ${node.turns}t` : ""}`;
}

/** Retain all nodes: result delivery/expiry must never erase hierarchy. */
export function buildSelectRows(registry: SubagentRegistry, now = Date.now()): Array<{ value: string; label: string }> {
  const rows: Array<{ value: string; label: string }> = [];
  const visit = (parent: string, depth: number) => {
    const children = [...registry.nodes.values()].filter((node) => node.parentName === parent).sort((a, b) => a.spawnIndex - b.spawnIndex);
    for (const node of children) {
      const index = rows.length;
      rows.push({ value: node.name, label: nodeLine(node, now, "  ".repeat(depth)) });
      visit(node.name, depth + 1);
      const descendants = rows.length - index - 1;
      if (descendants) rows[index]!.label += ` (+${descendants})`;
    }
  };
  visit(ROOT_AGENT_NAME, 0);
  return rows;
}

export function buildWidgetLines(registry: SubagentRegistry, now = Date.now()): string[] {
  return buildSelectRows(registry, now).map((row) => row.label);
}

export function buildTreeDump(registry: SubagentRegistry, now = Date.now()): string {
  return buildWidgetLines(registry, now).join("\n") || "No subagents yet.";
}

export interface DoneEntryData {
  name: string;
  status: string;
  durationSec: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model?: string;
  modelReason?: string;
  output?: string;
  error?: string;
  stopReason?: string;
}

export function doneLine(data: DoneEntryData): string {
  const symbol = data.status === "done" ? "✓" : data.status === "error" ? "✗" : data.status === "partial" ? "◐" : "■";
  const tokens = formatTokens((data.inputTokens ?? 0) + (data.outputTokens ?? 0));
  return `${symbol} ${data.name} · ${formatDuration(data.durationSec)} · ${data.turns} turns` +
    ` · ${tokens} tok · $${(data.cost ?? 0).toFixed(4)}${data.model ? ` · ${data.model}` : ""}` +
    `${data.modelReason ? ` · reason: ${data.modelReason}` : ""}`;
}

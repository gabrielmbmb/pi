import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { plainText } from "../activity.ts";
import { ROOT_AGENT_NAME } from "../constants.ts";
import type { SubagentNode, SubagentRegistry } from "../manager.ts";
import { formatDuration, formatTokens } from "../render.ts";
import { currentActivity, deliveryLabel, isActive } from "./model.ts";

export type AgentView = "activity" | "result" | "details";

export class InspectorContent {
  private cacheKey = "";
  private cached: string[] = [];
  private readonly markdownTheme: MarkdownTheme;
  private readonly theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
    const fg = (color: Parameters<Theme["fg"]>[0]) => (text: string) => theme.fg(color, text);
    this.markdownTheme = {
      heading: fg("mdHeading"), link: fg("mdLink"), linkUrl: fg("mdLinkUrl"),
      code: fg("mdCode"), codeBlock: fg("mdCodeBlock"), codeBlockBorder: fg("mdCodeBlockBorder"),
      quote: fg("mdQuote"), quoteBorder: fg("mdQuoteBorder"), hr: fg("mdHr"), listBullet: fg("mdListBullet"),
      bold: (text) => theme.bold(text), italic: (text) => theme.italic(text),
      strikethrough: (text) => theme.strikethrough(text), underline: (text) => theme.underline(text),
      highlightCode: (code, language) => highlightCode(code, language),
    };
  }

  invalidate(): void {
    this.cacheKey = "";
  }

  private md(text: string, width: number): string[] {
    return new Markdown(plainText(text), 0, 0, this.markdownTheme).render(width);
  }

  private line(text: string, width: number): string[] {
    return wrapTextWithAnsi(plainText(text).replace(/\t/g, "  "), width);
  }

  preview(registry: SubagentRegistry, node: SubagentNode | undefined, width: number, now: number): string[] {
    if (!node) return ["Select an agent to see its task and current activity.", "", "Enter opens its transcript. Completed agents remain inspectable."]
      .flatMap((line) => this.line(line, width));
    const title = (text: string) => this.theme.fg("accent", this.theme.bold(text));
    const task = this.line(node.prompt ?? node.promptSnippet ?? "(task unavailable for this older agent)", width);
    const recent = node.activity?.entries.slice(-5) ?? [];
    const usage = node.ownUsage;
    return [
      title(`${node.name} · ${node.status}`), "", title("Task"),
      ...task.slice(0, 3), ...(task.length > 3 ? [this.theme.fg("dim", "… full task in Details")] : []),
      "", title("Now"), ...this.line(currentActivity(registry, node, now), width),
      ...(isActive(node) && node.lastActivityAt !== undefined ? [this.theme.fg("dim", `Activity ${formatDuration(Math.max(0, (now - node.lastActivityAt) / 1000))} ago`)] : []),
      "", title("Recent activity"),
      ...recent.flatMap((entry) => this.line(`${entry.state === "running" ? "●" : entry.state === "error" ? "✗" : "·"} ${entry.title}`, width)),
      ...(!recent.length ? ["No recorded activity yet."] : []),
      "", ...this.line(`Model: ${node.model ?? "unknown"} · thinking ${node.thinking ?? "unknown"}`, width),
      ...this.line(`${node.turns} turns · ${usage ? `${formatTokens(usage.inputTokens + usage.outputTokens)} tokens · $${usage.cost.toFixed(4)} reported (own)` : "own usage unavailable"}`, width),
      "", ...this.line(this.delivery(registry, node), width),
      this.theme.fg("dim", "Enter transcript · 1 Activity / 2 Result / 3 Details"),
    ];
  }

  private delivery(registry: SubagentRegistry, node: SubagentNode): string {
    if (isActive(node)) return "Work continues while you inspect.";
    if (node.delivery) return deliveryLabel(node);
    // No peek(): inspection must not refresh LRU or consume a result.
    const available = registry.store.isAvailable?.(node.name) ?? registry.store.has(node.name);
    return available ? "Awaiting parent collection" : "Collection unavailable; retained inspection copy";
  }

  render(registry: SubagentRegistry, node: SubagentNode, view: AgentView, width: number, expanded: boolean, now: number): string[] {
    const key = `${node.name}:${node.activity?.revision}:${node.status}:${node.delivery?.at}:${view}:${width}:${expanded}:${Math.floor(now / 1000)}`;
    if (this.cacheKey === key) return this.cached;
    const heading = (text: string) => this.theme.fg("accent", this.theme.bold(text));
    let lines: string[];
    if (view === "details") {
      lines = [heading("Delegated task"), ...this.md(node.prompt ?? node.promptSnippet ?? "Task unavailable for this older agent.", width), "", heading("Configuration & diagnostics"),
        ...[
          `Status: ${node.status}`,
          `Parent: ${node.parentName === ROOT_AGENT_NAME ? "main" : node.parentName}`,
          ...(node.adoptedFrom ? [`Adopted from: ${node.adoptedFrom}`] : []),
          `Model: ${node.model ?? "unknown"}`,
          `Thinking: ${node.thinking ?? "unknown"}`,
          `Routing reason: ${node.modelReason ?? "not specified"}`,
          `Context: ${node.contextMode}${node.contextTurns ? ` (${node.contextTurns} turns)` : ""}; inherited history omitted from Activity`,
          `Depth: ${node.depth} · parent failure: ${node.onParentError}`,
          `Turn limit: ${node.maxTurns ?? "none"} · timeout: ${node.timeoutS ? `${node.timeoutS}s` : "none"}`,
          `Started: ${node.startedAt !== undefined ? new Date(node.startedAt).toISOString() : "not started"}`,
          `Ended: ${node.endedAt !== undefined ? new Date(node.endedAt).toISOString() : "not finished"}`,
          `Turns: ${node.turns}`,
          `Own usage: ${node.ownUsage ? `${node.ownUsage.inputTokens} in / ${node.ownUsage.outputTokens} out / $${node.ownUsage.cost.toFixed(4)}` : "unavailable for older agent"}`,
          `Result usage (includes collected/merged children): $${node.usage.cost.toFixed(4)}`,
          "Usage is provider-reported, not a live token estimate; an interrupted response may have no usage report.",
          this.delivery(registry, node),
          ...(node.result?.stopReason ? [`Stop reason: ${node.result.stopReason}`] : []),
          ...(node.result?.error ? [`Error: ${node.result.error}`] : []),
        ].flatMap((line) => this.line(line, width))];
    } else if (view === "result") {
      const result = node.result;
      const output = result?.output || result?.partialOutput || node.liveOutput || "";
      lines = [heading(result ? `Result · ${result.status}` : "Partial output · work still running"),
        ...this.line(this.delivery(registry, node), width),
        ...(result?.error ? this.line(`Error: ${result.error}`, width).map((line) => this.theme.fg("error", line)) : []),
        ...(result?.stopReason ? this.line(`Stop reason: ${result.stopReason}`, width) : []), "",
        ...(result?.mergedChildren ? this.line(`Includes ${result.mergedChildren} child result sections below the agent's own answer.`, width) : []),
        ...this.md(output || "No text output captured.", width),
        ...(result?.outputTruncated || node.outputTruncated ? ["", ...this.line("Output was capped; this is the retained result, not an unlimited transcript.", width)] : [])];
    } else {
      lines = [heading("Activity · own messages and tools"), this.theme.fg("dim", "Inherited history and private reasoning are omitted."), ""];
      if (node.activity?.dropped) lines.push(...this.line(`${node.activity.dropped} earlier events discarded (bounded history).`, width), "");
      for (const entry of node.activity?.entries ?? []) {
        const time = new Date(entry.at).toLocaleTimeString("en-GB", { hour12: false });
        const symbol = entry.state === "running" ? "●" : entry.state === "error" ? "✗" : entry.state === "cancelled" ? "■" : "✓";
        const duration = entry.kind === "tool" ? ` · ${formatDuration(Math.max(0, ((entry.endedAt ?? now) - entry.at) / 1000))}` : "";
        lines.push(...this.line(`${time} ${entry.kind === "tool" ? `${symbol} ` : ""}${entry.title}${duration}`, width)
          .map((line) => this.theme.fg(entry.state === "error" ? "error" : "accent", line)));
        if (entry.text) {
          if (entry.kind === "assistant") lines.push(...this.md(entry.text, width));
          else if (expanded) lines.push(...this.line(entry.text, width));
          else {
            const tail = entry.text.trim().split("\n").slice(-2).join("\n");
            lines.push(...this.line(tail, width).slice(-3), this.theme.fg("dim", "… tool output collapsed"));
          }
        }
        if (entry.truncated) lines.push(this.theme.fg("warning", "Earlier text discarded; showing retained tail."));
        lines.push("");
      }
      if (!node.activity?.entries.length) lines.push("No activity captured for this agent yet.");
    }
    this.cacheKey = key;
    this.cached = lines;
    return lines;
  }
}

import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  getMarkdownTheme, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { plainText } from "../activity.ts";
import type { SubagentNode } from "../manager.ts";
import type { TranscriptEntry } from "../transcript.ts";

export interface ConversationOptions {
  cwd?: string;
  outputPad?: 0 | 1;
  codeBlockIndent?: string;
  tui?: TUI;
}

type ToolRenderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
const factories = { read: createReadToolDefinition, bash: createBashToolDefinition, edit: createEditToolDefinition, write: createWriteToolDefinition };

/** Virtualized overlays must not emit native chat's terminal prompt/scrollback markers. */
export function stripPromptMarkers(line: string): string {
  return line.replace(/\x1b\]133;[ABC]\x07/g, "");
}

/** Reuse Pi's actual chat components, not copies of their formatting logic. */
export class ConversationContent {
  private node?: SubagentNode;
  private readonly components = new Map<string, { entry: TranscriptEntry; component: Component; expanded: boolean }>();
  private readonly definitions = new Map<string, ToolRenderers>();
  private readonly theme: Theme;
  private readonly options: ConversationOptions;
  private readonly ui: TUI;

  constructor(theme: Theme, options: ConversationOptions = {}) {
    this.theme = theme;
    this.options = options;
    // ToolExecutionComponent only uses requestRender; standalone rendering and
    // tests need no terminal, input listeners, or independent TUI event loop.
    this.ui = options.tui ?? { requestRender() {} } as TUI;
  }

  invalidate(): void {
    this.components.clear();
  }

  private markdownTheme() {
    return { ...getMarkdownTheme(), codeBlockIndent: this.options.codeBlockIndent ?? "  " };
  }

  private definition(name: string, cwd: string): ToolRenderers | undefined {
    if (!Object.hasOwn(factories, name)) return undefined;
    let definition = this.definitions.get(name);
    if (!definition) {
      const { renderCall, renderResult, renderShell } = factories[name as keyof typeof factories](cwd);
      // Keep rendering functions only. Never retain or invoke execute().
      definition = { renderCall, renderResult, renderShell };
      this.definitions.set(name, definition);
    }
    return definition;
  }

  private component(entry: TranscriptEntry, cwd: string, expanded: boolean): Component {
    let cached = this.components.get(entry.id);
    if (!cached || cached.entry.kind !== entry.kind) {
      const component = entry.kind === "user"
        ? new UserMessageComponent(entry.text, this.markdownTheme(), this.options.outputPad ?? 1)
        : entry.kind === "assistant"
          ? new AssistantMessageComponent(undefined, true, this.markdownTheme(), undefined, this.options.outputPad ?? 1)
          : new ToolExecutionComponent(entry.call.name, entry.call.id, entry.call.arguments, { showImages: false }, this.definition(entry.call.name, cwd), this.ui, cwd);
      cached = { entry, component, expanded };
      this.components.set(entry.id, cached);
      this.update(component, entry, expanded);
    } else if (cached.entry !== entry || cached.expanded !== expanded) {
      // User messages are immutable in normal SDK event flow.
      if (entry.kind === "user") cached.component = new UserMessageComponent(entry.text, this.markdownTheme(), this.options.outputPad ?? 1);
      else this.update(cached.component, entry, expanded);
      cached.entry = entry;
      cached.expanded = expanded;
    }
    return cached.component;
  }

  private update(component: Component, entry: TranscriptEntry, expanded: boolean): void {
    if (entry.kind === "assistant") (component as AssistantMessageComponent).updateContent(entry.message, entry.streaming);
    if (entry.kind !== "tool") return;
    const tool = component as ToolExecutionComponent;
    tool.updateArgs(entry.call.arguments);
    // Historical rendering, as in Pi's session replay: don't mark execution
    // started (bash would start its own timer), or setArgsComplete (edit would
    // read today's file). Pending colors come from isPartial; diffs come from
    // the recorded result.details.diff. Inspection owns no execution effects.
    if (entry.result) tool.updateResult(entry.result, !entry.complete);
    tool.setExpanded(expanded);
  }

  render(node: SubagentNode, width: number, expanded: boolean): string[] {
    if (this.node !== node) {
      this.node = node;
      this.components.clear();
      this.definitions.clear();
    }
    const renderWidth = Math.max(4, width);
    const cwd = node.cwd ?? this.options.cwd ?? process.cwd();
    const lines: string[] = [];
    const notice = (text: string) => lines.push(...new Text(this.theme.fg("dim", text), 1, 1).render(renderWidth));
    const transcript = node.transcript;
    if (transcript) {
      if (transcript.dropped) notice(`${transcript.dropped} earlier conversation entries discarded (bounded inspection history).`);
      const ids = new Set(transcript.entries.map((entry) => entry.id));
      for (const id of this.components.keys()) if (!ids.has(id)) this.components.delete(id);
      for (const entry of transcript.entries) {
        if (entry.kind === "user" && lines.length) lines.push("");
        lines.push(...this.component(entry, cwd, expanded).render(renderWidth));
        if (entry.truncated) notice("This inspection copy was truncated; the worker's conversation is unchanged.");
      }
    } else {
      // Workers predating structured capture cannot recover old arguments or
      // diff metadata. Do not invent them, or replay their tools to obtain it.
      if (node.prompt || node.promptSnippet) lines.push(...new UserMessageComponent(plainText(node.prompt ?? node.promptSnippet ?? ""), this.markdownTheme(), this.options.outputPad ?? 1).render(renderWidth));
      const entries = node.activity?.entries ?? [];
      if (entries.some((entry) => entry.kind !== "state")) notice("Older worker: only previously captured text and tool summaries are available. New workers use native conversation capture.");
      if (node.activity?.dropped) notice(`${node.activity.dropped} earlier events discarded (bounded inspection history).`);
      for (const entry of entries) {
        if (entry.kind === "assistant") lines.push("", ...new Markdown(plainText(entry.text), this.options.outputPad ?? 1, 0, this.markdownTheme()).render(renderWidth));
        else if (entry.kind === "tool") {
          const tool = new ToolExecutionComponent(plainText(entry.title), entry.id, {}, { showImages: false }, undefined, this.ui, cwd);
          if (entry.text || entry.state !== "running") tool.updateResult({ content: [{ type: "text", text: plainText(entry.text) }], isError: entry.state === "error" || entry.state === "cancelled" }, entry.state === "running");
          tool.setExpanded(expanded);
          lines.push(...tool.render(renderWidth));
        }
        // Lifecycle/audit notices belong in Details, not between chat messages.
        if (entry.truncated) notice("Earlier text discarded; showing the retained inspection copy.");
      }
      if (!entries.some((entry) => entry.kind === "assistant") && node.result?.output) {
        notice("Only the retained result is available for this worker; earlier conversation messages were not captured.");
        lines.push("", ...new Markdown(plainText(node.result.output), this.options.outputPad ?? 1, 0, this.markdownTheme()).render(renderWidth));
      } else if (!entries.some((entry) => entry.kind !== "state")) notice(node.endedAt === undefined ? "Waiting for the worker's first response." : "No conversation messages were captured.");
    }
    if (node.result?.error && !transcript?.entries.some((entry) => entry.kind === "assistant" && entry.message.stopReason === "error"))
      lines.push(...new Text(this.theme.fg("error", plainText(node.result.error)), this.options.outputPad ?? 1, 1).render(renderWidth));
    return lines.map((line) => truncateToWidth(stripPromptMarkers(line), Math.max(1, width)));
  }
}

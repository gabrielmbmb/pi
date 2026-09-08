import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { plainText } from "../activity.ts";
import { ROOT_AGENT_NAME } from "../constants.ts";
import type { SubagentRegistry } from "../manager.ts";
import { formatDuration, statusColor, statusSymbol } from "../render.ts";
import { InspectorContent, type AgentView } from "./content.ts";
import { breadcrumb, cancelTargets, isActive, treeRows, type TreeFilter, type TreeRow } from "./model.ts";

interface ScrollState {
  offset: number;
  follow: boolean;
  revision: number;
  anchor?: string;
}

export interface InspectorState {
  selectedName?: string;
  collapsed: Set<string>;
  view: AgentView;
  views: Map<string, AgentView>;
  scroll: Map<string, ScrollState>;
  filter: TreeFilter;
  query: string;
  expandedTools: boolean;
}

export function createInspectorState(): InspectorState {
  return { collapsed: new Set(), view: "activity", views: new Map(), scroll: new Map(), filter: "all", query: "", expandedTools: false };
}

interface PanelOptions {
  state?: InspectorState;
  keybindings?: KeybindingsManager;
  height?: () => number;
  now?: () => number;
  inspect?: string;
}

/** One overlay, two depths. Closing this component never affects execution. */
export class SubagentPanel implements Component, Focusable {
  private readonly registry: SubagentRegistry;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly requestRender: () => void;
  private readonly options: PanelOptions;
  private readonly state: InspectorState;
  private readonly content: InspectorContent;
  private readonly input = new Input();
  private viewer = false;
  private focus: "tree" | "preview" = "tree";
  private searching = false;
  private previousQuery = "";
  private previousSelection?: string;
  private help = false;
  private confirmation?: { name: string; targets: string[]; stop: boolean; changed?: boolean };
  private infoOffset = 0;
  private message = "";
  private pageHeight = 10;
  private treePageHeight = 10;
  private totalLines = 0;
  private _focused = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.searching;
  }

  constructor(
    registry: SubagentRegistry,
    theme: Theme,
    onClose: () => void,
    requestRender: () => void,
    options: PanelOptions = {},
  ) {
    this.registry = registry;
    this.theme = theme;
    this.onClose = onClose;
    this.requestRender = requestRender;
    this.options = options;
    this.state = options.state ?? createInspectorState();
    this.content = new InspectorContent(theme);
    if (options.inspect) {
      this.state.selectedName = options.inspect;
      this.state.filter = "all";
      this.state.query = "";
      let parent = registry.nodes.get(options.inspect)?.parentName;
      while (parent) {
        this.state.collapsed.delete(parent);
        parent = registry.nodes.get(parent)?.parentName;
      }
      this.openViewer();
    }
  }

  private key(data: string, action: "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel"): boolean {
    return this.options.keybindings?.matches(data, `tui.select.${action}`)
      ?? matchesKey(data, action === "confirm" ? Key.enter : action === "cancel" ? Key.escape : action);
  }

  private hint(action: "up" | "down" | "confirm" | "cancel"): string {
    return this.options.keybindings?.getKeys(`tui.select.${action}`).join("/") || ({ up: "↑", down: "↓", confirm: "Enter", cancel: "Esc" }[action]);
  }

  private rows(): TreeRow[] {
    const rows = treeRows(this.registry, this.state.collapsed, this.state.query, this.state.filter);
    if (!rows.some((row) => row.name === this.state.selectedName)) {
      // Prefer a retained ancestor when collapsing or changing a filter.
      let parent = this.registry.nodes.get(this.state.selectedName ?? "")?.parentName;
      while (parent && !rows.some((row) => row.name === parent)) parent = this.registry.nodes.get(parent)?.parentName;
      this.state.selectedName = parent ?? rows.find((row) => row.node && isActive(row.node))?.name ?? rows[1]?.name ?? rows[0]?.name;
    }
    return rows;
  }

  private openViewer(view?: AgentView): void {
    this.rows();
    const node = this.registry.nodes.get(this.state.selectedName ?? "");
    if (!node) {
      this.message = "Select a child agent to open its transcript.";
      return;
    }
    this.viewer = true;
    this.state.view = view ?? this.state.views.get(node.name) ?? (isActive(node) ? "activity" : "result");
    this.state.views.set(node.name, this.state.view);
  }

  private scrollState(): ScrollState {
    const key = `${this.state.selectedName}:${this.viewer ? this.state.view : "preview"}`;
    let state = this.state.scroll.get(key);
    if (!state) {
      const node = this.registry.nodes.get(this.state.selectedName ?? "");
      state = { offset: 0, follow: this.viewer && this.state.view === "activity" && Boolean(node && isActive(node)), revision: node?.activity?.revision ?? 0 };
      this.state.scroll.set(key, state);
    }
    return state;
  }

  private scrollBy(amount: number): void {
    const state = this.scrollState();
    state.follow = false;
    state.offset = Math.max(0, Math.min(Math.max(0, this.totalLines - this.pageHeight), state.offset + amount));
    state.anchor = undefined;
  }

  handleInput(data: string): void {
    this.handle(data);
    this.requestRender();
  }

  private handle(data: string): void {
    const cancel = this.key(data, "cancel") || matchesKey(data, Key.escape);
    const enter = this.key(data, "confirm");
    this.message = "";
    if (this.searching) {
      if (cancel || enter) {
        if (cancel) {
          this.state.query = this.previousQuery;
          this.state.selectedName = this.previousSelection;
        }
        this.searching = false;
        this.input.focused = false;
      } else {
        this.input.handleInput(data);
        this.state.query = this.input.getValue();
      }
      return;
    }
    if (this.confirmation) {
      if (cancel || data === "n") this.confirmation = undefined;
      else if (matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) this.confirmation.stop = !this.confirmation.stop;
      else if (this.key(data, "pageDown")) this.infoOffset += this.pageHeight;
      else if (this.key(data, "pageUp")) this.infoOffset = Math.max(0, this.infoOffset - this.pageHeight);
      else if (enter || data === "y") {
        const confirmation = this.confirmation;
        if (!confirmation.stop && data !== "y") {
          this.confirmation = undefined;
          return;
        }
        const targets = cancelTargets(this.registry, confirmation.name).map((node) => node.name);
        if (targets.some((name) => !confirmation.targets.includes(name))) {
          this.confirmation = { name: confirmation.name, targets, stop: false, changed: true };
          return;
        }
        // Revalidated synchronously above; one atomic cascade/queue notification.
        this.registry.cancelSubtree(confirmation.name);
        this.confirmation = undefined;
        this.message = targets.length ? `Stopped ${targets.length} agents. Output retained; edits not rolled back.` : "These agents have already finished.";
      }
      return;
    }
    if (this.help) {
      if (cancel || data === "?") this.help = false;
      else if (this.key(data, "down") || this.key(data, "pageDown")) this.infoOffset += this.key(data, "down") ? 1 : this.pageHeight;
      else if (this.key(data, "up") || this.key(data, "pageUp")) this.infoOffset = Math.max(0, this.infoOffset - (this.key(data, "up") ? 1 : this.pageHeight));
      return;
    }
    if (cancel) {
      if (this.viewer) this.viewer = false;
      else if (this.state.query) this.state.query = "";
      else this.onClose();
      return;
    }
    if (data === "?") { this.help = true; this.infoOffset = 0; return; }
    if (data === "c") {
      const name = this.state.selectedName ?? ROOT_AGENT_NAME;
      const targets = cancelTargets(this.registry, name).map((node) => node.name);
      if (targets.length) this.confirmation = { name, targets, stop: false };
      else this.message = "No active agents in this subtree.";
      this.infoOffset = 0;
      return;
    }
    if (data === "1" || data === "2" || data === "3") {
      this.openViewer(({ "1": "activity", "2": "result", "3": "details" } as const)[data]);
      return;
    }
    if (this.viewer && (this.options.keybindings?.matches(data, "app.tools.expand") ?? matchesKey(data, Key.ctrl("o")))) {
      this.state.expandedTools = !this.state.expandedTools;
      return;
    }
    if (!this.viewer && data === "/") {
      this.previousQuery = this.state.query;
      this.previousSelection = this.state.selectedName;
      this.input.setValue(this.state.query);
      this.searching = true;
      this.input.focused = this.focused;
      return;
    }
    if (!this.viewer && data === "v") {
      this.state.filter = this.state.filter === "all" ? "active" : this.state.filter === "active" ? "failed" : "all";
      return;
    }
    if (!this.viewer && matchesKey(data, Key.tab)) { this.focus = this.focus === "tree" ? "preview" : "tree"; return; }
    if (enter && !this.viewer) { this.openViewer(); return; }
    const up = this.key(data, "up") || data === "k";
    const down = this.key(data, "down") || data === "j";
    const pageUp = this.key(data, "pageUp");
    const pageDown = this.key(data, "pageDown");
    if (this.viewer || this.focus === "preview") {
      if (up || down || pageUp || pageDown) this.scrollBy((up || pageUp ? -1 : 1) * (pageUp || pageDown ? this.pageHeight : 1));
      if (matchesKey(data, Key.home)) this.scrollBy(-Infinity);
      if (matchesKey(data, Key.end)) {
        const scroll = this.scrollState();
        scroll.offset = Math.max(0, this.totalLines - this.pageHeight);
        scroll.anchor = undefined;
        scroll.follow = this.viewer && this.state.view === "activity";
      }
      return;
    }
    const rows = this.rows();
    const index = rows.findIndex((row) => row.name === this.state.selectedName);
    if (index < 0) return;
    const selected = rows[index]!;
    if (up || down || pageUp || pageDown) this.state.selectedName = rows[Math.max(0, Math.min(rows.length - 1, index + (up || pageUp ? -1 : 1) * (pageUp || pageDown ? this.treePageHeight : 1)))]!.name;
    else if (matchesKey(data, Key.home)) this.state.selectedName = rows[0]!.name;
    else if (matchesKey(data, Key.end)) this.state.selectedName = rows.at(-1)!.name;
    else if (matchesKey(data, Key.left) || data === "h") {
      if (selected.hasChildren && !selected.collapsed) this.state.collapsed.add(selected.name);
      else this.state.selectedName = selected.node?.parentName ?? ROOT_AGENT_NAME;
    } else if (matchesKey(data, Key.right) || data === "l") {
      if (selected.collapsed) this.state.collapsed.delete(selected.name);
      else if (selected.hasChildren) this.state.selectedName = rows[index + 1]?.name ?? selected.name;
    }
  }

  private tree(width: number, height: number, now: number): string[] {
    const rows = this.rows();
    if (!rows.length) return [this.registry.nodes.size ? "No matching agents. / search · v view" : "No subagents yet."];
    const index = rows.findIndex((row) => row.name === this.state.selectedName);
    const count = Math.max(1, height - 1);
    this.treePageHeight = count;
    const start = Math.max(0, Math.min(index - Math.floor(count / 2), rows.length - count));
    const lines = rows.slice(start, start + count).map((row) => {
      const selected = row.name === this.state.selectedName;
      const arrow = row.hasChildren ? row.collapsed ? "▸ " : "▾ " : "  ";
      const node = row.node;
      const elapsed = node?.startedAt !== undefined ? ` ${formatDuration(Math.max(0, ((node.endedAt ?? now) - node.startedAt) / 1000))}` : "";
      const state = node?.status === "merging" ? "waiting on children" : node?.status === "queued" ? `queued #${this.registry.queuePosition(node.name) + 1}` : node?.status;
      const suffix = row.collapsed ? ` (+${row.descendants} · ${row.activeDescendants} active${row.failedDescendants ? ` · ${row.failedDescendants} failed` : ""})` : "";
      const text = `${selected ? "❯" : " "} ${row.prefix}${arrow}${node ? `${statusSymbol(node)} ${node.name}${suffix} · ${state}${elapsed}${node.adoptedFrom ? " [adopted]" : ""}` : `main${suffix}`}`;
      const styled = this.theme.fg(node ? statusColor(node.status) : "accent", truncateToWidth(plainText(text), width));
      return selected ? this.theme.bg("selectedBg", this.theme.bold(styled)) : styled;
    });
    lines.push(this.theme.fg("dim", `${start + 1}–${Math.min(rows.length, start + count)} / ${rows.length} rows`));
    return lines;
  }

  private viewport(lines: string[], height: number, width: number): string[] {
    const scroll = this.scrollState();
    this.pageHeight = Math.max(1, height - 1);
    this.totalLines = lines.length;
    if (!scroll.follow && scroll.anchor) {
      const anchor = lines.indexOf(scroll.anchor);
      if (anchor >= 0) scroll.offset = anchor;
    }
    const max = Math.max(0, lines.length - this.pageHeight);
    scroll.offset = scroll.follow ? max : Math.min(scroll.offset, max);
    scroll.anchor = lines[scroll.offset];
    const revision = this.registry.nodes.get(this.state.selectedName ?? "")?.activity?.revision ?? 0;
    if (scroll.follow) scroll.revision = revision;
    const activity = this.viewer && this.state.view === "activity";
    const live = this.registry.nodes.get(this.state.selectedName ?? "");
    const status = activity ? scroll.follow ? `${live && isActive(live) ? "LIVE" : "At end"} · following latest` : `Paused${revision > scroll.revision ? ` · ↓ ${revision - scroll.revision} updates` : ""} · End follow` : `${Math.min(lines.length, scroll.offset + 1)}–${Math.min(lines.length, scroll.offset + this.pageHeight)} / ${lines.length}`;
    const body = lines.slice(scroll.offset, scroll.offset + this.pageHeight);
    while (body.length < this.pageHeight) body.push("");
    return [...body, this.theme.fg("dim", truncateToWidth(status, width))];
  }

  render(width: number): string[] {
    const height = Math.max(3, Math.floor(this.options.height?.() ?? 26));
    const inner = Math.max(1, width - 4);
    const now = this.options.now?.() ?? Date.now();
    this.rows();
    const node = this.registry.nodes.get(this.state.selectedName ?? "");
    const counts = new Map<string, number>();
    for (const item of this.registry.nodes.values()) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    const summary = ["running", "merging", "queued", "error", "partial", "done", "cancelled"]
      .filter((status) => counts.has(status))
      .map((status) => `${counts.get(status)} ${status === "merging" ? "waiting" : status === "error" ? "failed" : status}`).join(" · ") || "idle";
    const title = this.theme.fg("accent", this.theme.bold(`Subagents · ${summary}`));
    const tabs = `1 Activity${this.state.view === "activity" ? " ●" : ""}  2 Result${this.state.view === "result" ? " ●" : ""}  3 Details${this.state.view === "details" ? " ●" : ""}`;
    const controls = this.viewer ? `${tabs} · ${breadcrumb(this.registry, node?.name ?? ROOT_AGENT_NAME)}` : `View: ${this.state.filter === "failed" ? "failed + partial" : this.state.filter} (v) · ${this.focus === "tree" ? "TREE" : "PREVIEW"} focused · / search${this.state.query ? `: ${this.state.query}` : ""}`;
    let header = [title, this.theme.fg("muted", plainText(controls).replace(/\s+/g, " "))];
    if (this.searching) header.push(...this.input.render(inner));
    const bodyHeight = Math.max(1, height - header.length - 3);
    let body: string[];
    let footer = this.message || (this.viewer
      ? `${this.hint("up")}/${this.hint("down")} scroll · PgUp/PgDn · ${this.options.keybindings?.getKeys("app.tools.expand").join("/") || "Ctrl+O"} tools · c stop · ${this.hint("cancel")} back · ? help`
      : `${this.hint("up")}/${this.hint("down")} select · ←→ fold · ${this.hint("confirm")} transcript · Tab pane · c stop · ${this.hint("cancel")} close · ?`);
    if (!this.message && inner < 100) footer = inner < 45
      ? `${this.hint("cancel")} ${this.viewer ? "back" : "close"} · ? help · ${this.hint("confirm")} open`
      : this.viewer
        ? `${this.hint("cancel")} back · ? help · ${this.hint("up")}/${this.hint("down")} scroll · 1/2/3 views · c stop`
        : `${this.hint("cancel")} close · ? help · ${this.hint("up")}/${this.hint("down")} select · ${this.hint("confirm")} open · Tab pane · c stop`;
    if (this.confirmation || this.help) {
      const confirmation = this.confirmation;
      const text = confirmation ? [
        `Stop ${confirmation.name === ROOT_AGENT_NAME ? "all subagents" : `${confirmation.name} and its active descendants`}?`,
        ...(confirmation.changed ? ["The subtree changed. Review the new scope before confirming."] : []),
        "", ...confirmation.targets.map((name) => `• ${name} (${this.registry.nodes.get(name)?.status ?? "finished"})`),
        "", "Captured output stays available. File edits are NOT rolled back.",
      ] : [
        "Subagent inspector — read-only unless you explicitly stop work", "",
        `${this.hint("up")}/${this.hint("down")} or j/k: select in tree; scroll in transcript/preview`,
        "←/→ or h/l: collapse/parent; expand/first child",
        `${this.hint("confirm")}: open transcript · Tab: focus tree/preview`,
        "1 Activity · 2 Result · 3 Details (full task and configuration)",
        "PgUp/PgDn: page · Home: beginning · End: latest/follow",
        "Scrolling up pauses following, never execution.",
        `${this.options.keybindings?.getKeys("app.tools.expand").join("/") || "Ctrl+O"}: expand/collapse tool output`,
        "/: search names/tasks in tree · v: All / Active / Failed + Partial",
        "c: confirm stopping selected subtree; main selects every agent",
        "Esc: dismiss search/confirmation, return to tree, then close",
        "Completed agents remain visible after collection, merge, or expiry.",
        "Activity is bounded and excludes inherited history/private reasoning.",
        "? closes this help · PgUp/PgDn scroll",
      ];
      const lines = text.flatMap((line) => wrapTextWithAnsi(plainText(line), inner));
      this.pageHeight = bodyHeight;
      this.infoOffset = Math.min(this.infoOffset, Math.max(0, lines.length - bodyHeight));
      body = lines.slice(this.infoOffset, this.infoOffset + bodyHeight);
      footer = confirmation ? `${confirmation.stop ? " Keep running " : "[Keep running]"}  ${confirmation.stop ? `[Stop ${confirmation.targets.length}]` : ` Stop ${confirmation.targets.length} `} · Tab · ${this.hint("confirm")} · ${this.hint("cancel")}` : "PgUp/PgDn scroll · Esc back";
    } else if (this.viewer && node) {
      body = this.viewport(this.content.render(this.registry, node, this.state.view, inner, this.state.expandedTools, now), bodyHeight, inner);
    } else if (inner >= 104) {
      const leftWidth = Math.floor((inner - 3) * 0.44);
      const rightWidth = inner - leftWidth - 3;
      const left = this.tree(leftWidth, bodyHeight, now);
      const right = this.viewport(this.content.preview(this.registry, node, rightWidth, now), bodyHeight, rightWidth);
      body = Array.from({ length: bodyHeight }, (_, i) => `${this.pad(left[i] ?? "", leftWidth)} ${this.theme.fg("borderMuted", "│")} ${this.pad(right[i] ?? "", rightWidth)}`);
    } else if (bodyHeight >= 10) {
      const treeHeight = Math.max(4, Math.floor(bodyHeight * 0.45));
      body = [...this.tree(inner, treeHeight, now)];
      while (body.length < treeHeight) body.push("");
      body.push(this.theme.fg("borderMuted", "─".repeat(inner)));
      body.push(...this.viewport(this.content.preview(this.registry, node, inner, now), bodyHeight - treeHeight - 1, inner));
    } else {
      body = this.focus === "preview" ? this.viewport(this.content.preview(this.registry, node, inner, now), bodyHeight, inner) : this.tree(inner, bodyHeight, now);
    }
    if (this.searching) footer = `${this.hint("confirm")} apply · ${this.hint("cancel")} restore · Type to filter names/tasks`;
    // Own the height budget: overlay maxHeight clips, it does not scroll.
    header = header.slice(0, Math.max(0, height - 3));
    const capacity = Math.max(0, height - header.length - 3);
    body = body.slice(0, capacity);
    while (body.length < capacity) body.push("");
    const lines = [...header, ...body, this.theme.fg("dim", plainText(footer))];
    if (width < 5) return lines.slice(0, height).map((line) => truncateToWidth(line, Math.max(1, width)));
    const border = (a: string, b: string) => this.theme.fg("borderMuted", `${a}${"─".repeat(inner + 2)}${b}`);
    return [border("╭", "╮"), ...lines.map((line) => `${this.theme.fg("borderMuted", "│")} ${this.pad(line, inner)} ${this.theme.fg("borderMuted", "│")}`), border("╰", "╯")];
  }

  private pad(text: string, width: number): string {
    const line = truncateToWidth(text.replace(/\t/g, "  ").replace(/\n/g, " "), width);
    return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  }

  invalidate(): void {
    this.content.invalidate();
    this.input.invalidate();
  }
}

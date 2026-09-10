/**
 * Subagents extension entry point (DESIGN.md §2, §4, §6, §7).
 *
 * Registers the four subagent tools for the main agent, the /subagents
 * command, per-turn routing guidance injection, interrupt-injection notes,
 * session teardown, and the TUI (compact footer status, transcript entries,
 * state-change chips, popup explorer, notifications).
 *
 * The registry and engine are shared instances attached to globalThis so they
 * survive /reload (running subagents and uncollected results keep working).
 */

import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createInspectorState, SubagentPanel } from "./inspector/panel.ts";
import { cancelTargets } from "./inspector/model.ts";

import { loadRoutingConfig } from "./config.ts";
import { MAX_CONCURRENT, ROOT_AGENT_NAME } from "./constants.ts";
import {
  getSharedRegistry,
  type SubagentNode,
} from "./manager.ts";
import { buildRoutingBlock, SPAWN_TOOL_GUIDELINES } from "./routing.ts";
import { getSharedEngine } from "./session.ts";
import { makeSubagentTools, type ToolCaller } from "./tools.ts";
import {
  buildSelectRows,
  buildTreeDump,
  doneLine,
  formatSubagentStatus,
  statusColor,
} from "./render.ts";

const STATUS_KEY = "subagents";
const NOTE_CUSTOM_TYPE = "subagent_state_change";
const START_ENTRY = "subagent_start";
const DONE_ENTRY = "subagent_done";

/** Notes that participate in the next turn's model context (§4: cancellation, adoption, merge-timeout kills). */
const INJECTED_NOTE_RE = /^subagents? (cancelled|adopted)/;

export default function subagentsExtension(pi: ExtensionAPI) {
  const registry = getSharedRegistry();
  const engine = getSharedEngine();

  // ── per-session UI context (captured at session_start, per usage-monitor) ──
  let uiContext: ExtensionContext | undefined;
  let inspectorState = createInspectorState();
  let closeInspector: (() => void) | undefined;
  // Fallback for registries created by an older extension version before
  // `/reload`; those instances do not have the new subscribe() method.
  const uiListeners = new Set<() => void>();

  // ── interrupt-note batching (§4, §13: batched per event burst, ~1s) ──────
  let pendingNotes: string[] = [];
  let noteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  function queueNote(note: string): void {
    pendingNotes.push(note);
    if (noteFlushTimer !== undefined) return;
    noteFlushTimer = setTimeout(() => {
      noteFlushTimer = undefined;
      flushNotes();
    }, 1000);
  }

  function flushNotes(): void {
    const notes = pendingNotes;
    pendingNotes = [];
    if (notes.length === 0) return;
    const text = notes.map((note) => `• ${note}`).join("\n");
    try {
      pi.sendMessage(
        {
          customType: NOTE_CUSTOM_TYPE,
          content: `Subagent state change:\n${text}`,
          display: true,
        },
        { deliverAs: "nextTurn", triggerTurn: false },
      );
    } catch {
      // Never let note delivery disturb the session.
    }
  }

  // ── compact footer status (silent when there is nothing to inspect) ───────
  function refreshStatus(): void {
    const ctx = uiContext;
    if (!ctx || !ctx.hasUI) return;
    const status = formatSubagentStatus(registry);
    ctx.ui.setStatus(STATUS_KEY, status);
    if (status === undefined) {
      if (statusRefreshTimer !== undefined) clearTimeout(statusRefreshTimer);
      statusRefreshTimer = undefined;
    } else if (statusRefreshTimer === undefined) {
      // ResultStore entries expire even without a transition; re-check so the
      // indicator eventually disappears when the review window closes.
      statusRefreshTimer = setTimeout(() => {
        statusRefreshTimer = undefined;
        refreshStatus();
      }, 60_000);
    }
  }

  // ── registry state-change sink (rebound per session_start) ───────────────
  function notifyUiListeners(): void {
    for (const listener of uiListeners) {
      try {
        listener();
      } catch {
        // Popup rendering is best-effort.
      }
    }
  }

  function onStateChange(note: string): void {
    try {
      const queuedMatch = note.match(/^subagent queued: ([A-Za-z0-9_-]+)$/);
      const settledMatch = note.match(/^subagent settled: ([A-Za-z0-9_-]+) \(\w+\)$/);
      const mergedMatch = note.match(/^subagent merged: ([A-Za-z0-9_-]+) \(\+\d+ children\)$/);
      const completionMatch = settledMatch ?? mergedMatch;
      const name = queuedMatch?.[1] ?? completionMatch?.[1];
      const node = name !== undefined ? registry.nodes.get(name) : undefined;

      if (queuedMatch && node) {
        pi.appendEntry(START_ENTRY, {
          name: node.name,
          promptSnippet: node.promptSnippet ?? "",
          model: node.model,
          thinking: node.thinking,
          modelReason: node.modelReason,
          contextMode: node.contextMode,
          ...(node.contextTurns !== undefined ? { contextTurns: node.contextTurns } : {}),
          parent: node.parentName,
          depth: node.depth,
        });
      } else if (completionMatch && node?.result) {
        const result = node.result;
        pi.appendEntry(DONE_ENTRY, {
          name: result.name,
          status: result.status,
          durationSec: result.durationSec,
          turns: result.turns,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cost: result.usage.cost,
          model: result.model,
          modelReason: result.modelReason,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
          ...(result.mergedChildren !== undefined ? { mergedChildren: result.mergedChildren } : {}),
        });

        const ctx = uiContext;
        if (ctx?.hasUI) {
          const symbol =
            result.status === "done" ? "✓" : result.status === "error" ? "✗" : result.status === "partial" ? "◐" : "⏹";
          const tail =
            result.status === "error" && result.error !== undefined
              ? ` — ${result.error.slice(0, 120)}`
              : "";
          ctx.ui.notify(
            `${symbol} ${result.name} ${result.status === "done" ? "finished" : result.status} · ${result.durationSec}s · $${result.usage.cost.toFixed(4)}${tail}`,
            result.status === "error" ? "error" : result.status === "done" ? "info" : "warning",
          );
        }
      }

      if (INJECTED_NOTE_RE.test(note) && interruptNotesEnabled()) queueNote(note);
      refreshStatus();
    } catch {
      // State-change handling must never disturb the session.
    } finally {
      notifyUiListeners();
    }
  }

  function commandNotify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    if (!ctx.hasUI) return;
    ctx.ui.notify(message, level);
  }

  function interruptNotesEnabled(): boolean {
    try {
      const ctx = uiContext;
      const loaded = loadRoutingConfig(getAgentDir(), ctx?.cwd ?? process.cwd());
      return loaded.config?.interruptNotes !== false;
    } catch {
      return true;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    inspectorState = createInspectorState();
    uiListeners.clear();
    uiContext = ctx;
    registry.hooks = { ...registry.hooks, onStateChange, startQueued: () => engine.pump() };
    try {
      const loaded = loadRoutingConfig(getAgentDir(), ctx.cwd);
      if (loaded.fileErrors.length === 0) {
        registry.setMaxConcurrent(loaded.config?.maxConcurrent ?? MAX_CONCURRENT);
      }
    } catch {
      // Spawn validation reports config errors; startup must remain unaffected.
    }
    refreshStatus();
  });

  pi.on("session_shutdown", (event) => {
    closeInspector?.();
    closeInspector = undefined;
    flushNotes();
    if (noteFlushTimer !== undefined) clearTimeout(noteFlushTimer);
    if (statusRefreshTimer !== undefined) clearTimeout(statusRefreshTimer);
    noteFlushTimer = undefined;
    statusRefreshTimer = undefined;
    uiListeners.clear();
    if (uiContext?.hasUI) uiContext.ui.setStatus(STATUS_KEY, undefined);
    uiContext = undefined;
    if (event.reason !== "reload") engine.reset?.();
    registry.teardown(event.reason);
  });

  // ── per-turn routing guidance injection (§6; spike-verified mechanism) ───
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const loaded = loadRoutingConfig(getAgentDir(), ctx.cwd);
      if (loaded.fileErrors.length > 0) return;
      const block = buildRoutingBlock(loaded.config, ctx.modelRegistry, loaded).block;
      if (!block) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    } catch {
      return; // strict no-op: main-agent integrity is non-negotiable
    }
  });

  // ── the four tools, bound to the main agent ───────────────────────────────
  const mainCaller = (ctx: ExtensionContext): ToolCaller => ({
    name: ROOT_AGENT_NAME,
    depth: 0,
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    historyEntries: () => ctx.sessionManager.buildContextEntries(),
    parentModel: {
      model: ctx.model!,
      thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
    },
    modelRegistry: ctx.modelRegistry,
  });

  for (const tool of makeSubagentTools((ctx) => mainCaller(ctx as ExtensionContext), engine)) {
    pi.registerTool({
      ...tool,
      ...(tool.name === "spawn_subagents"
        ? {
            promptSnippet:
              "Spawn parallel background subagents for self-contained subtasks and collect their results",
            promptGuidelines: SPAWN_TOOL_GUIDELINES,
          }
        : {}),
    });
  }

  // ── /subagents command (§7.5) ─────────────────────────────────────────────
  pi.registerCommand("subagents", {
    description: "Live subagent tree, activity transcripts, results, and safe subtree cancellation",
    getArgumentCompletions: (prefix: string) => {
      const candidates = [
        { value: "config", label: "config", description: "Show merged routing config + diagnostics" },
        { value: "cancel all", label: "cancel all", description: "Cancel every subagent" },
        ...buildSelectRows(registry).flatMap((row) => [
          { value: `inspect ${row.value}`, label: `inspect ${row.value}`, description: row.label },
          { value: `cancel ${row.value}`, label: `cancel ${row.value}`, description: row.label },
        ]),
      ];
      const filtered = candidates.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "config") {
        const loaded = loadRoutingConfig(getAgentDir(), ctx.cwd);
        const lines: string[] = ["Subagent routing config:"];
        lines.push(`  user:    ${loaded.userPath}`);
        lines.push(`  project: ${loaded.projectPath}`);
        const maxConcurrent = loaded.config?.maxConcurrent ?? MAX_CONCURRENT;
        lines.push(`  max concurrent: ${maxConcurrent}${loaded.config?.maxConcurrent === undefined ? " (default)" : ""}`);
        if (loaded.fileErrors.length > 0) {
          lines.push("  errors (spawns blocked):");
          for (const fileError of loaded.fileErrors) lines.push(`    ✗ ${fileError.error}`);
        } else if (loaded.config) {
          const block = buildRoutingBlock(loaded.config, ctx.modelRegistry, loaded);
          lines.push(...block.block.split("\n").map((line) => `  ${line}`));
          for (const disabled of block.disabledRules) {
            lines.push(`  ⚠ rule "${disabled.name}" disabled: ${disabled.reason}`);
          }
          if (block.defaultWarning !== undefined) lines.push(`  ⚠ ${block.defaultWarning}`);
        } else {
          lines.push("  (no config found — subagents inherit the parent model)");
        }
        const text = lines.join("\n");
        if (ctx.hasUI) await ctx.ui.editor("Subagents config", text);
        else commandNotify(ctx, text, "info");
        return;
      }

      if (subcommand === "cancel") {
        const target = rest[0];
        if (target === undefined) {
          commandNotify(ctx, "Usage: /subagents cancel <name|all>", "warning");
          return;
        }
        if (target !== "all" && !registry.nodes.has(target)) {
          commandNotify(ctx, `No subagent named "${target}"`, "error");
          return;
        }
        const scope = target === "all" ? ROOT_AGENT_NAME : target;
        let targets = cancelTargets(registry, scope);
        while (ctx.hasUI && targets.length > 0) {
          if (!await ctx.ui.confirm(
            "Stop subagent subtree",
            `Stop ${targets.length} active agents: ${targets.map((node) => node.name).join(", ")}? Captured output is retained; file edits are NOT rolled back.`,
          )) return;
          const latest = cancelTargets(registry, scope);
          // Compare identities as well as names across a possible session switch.
          if (!latest.some((node) => !targets.includes(node))) break;
          targets = latest;
        }
        const cancelled = registry.cancelSubtree(scope);
        commandNotify(
          ctx,
          cancelled.length > 0 ? `Cancelled: ${cancelled.join(", ")}` : "Nothing to cancel",
          "info",
        );
        return;
      }

      const inspect = subcommand === "inspect" ? rest[0] : undefined;
      if (subcommand && subcommand !== "inspect") {
        commandNotify(ctx, "Usage: /subagents [inspect <name> | cancel <name|all> | config]", "warning");
        return;
      }
      if (subcommand === "inspect" && (!inspect || !registry.nodes.has(inspect))) {
        commandNotify(ctx, inspect ? `No subagent named "${inspect}"` : "Usage: /subagents inspect <name>", "warning");
        return;
      }
      if (closeInspector) return;

      // Inspection never replaces the main session or consumes results.
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        commandNotify(ctx, buildTreeDump(registry), "info");
        return;
      }

      const displaySettings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted?.() ?? false });
      inspectorState.expandedTools = ctx.ui.getToolsExpanded?.() ?? inspectorState.expandedTools;
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          let closed = false;
          let unsubscribe = () => {};
          let renderTimer: ReturnType<typeof setTimeout> | undefined;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          const cleanup = () => {
            if (closed) return;
            closed = true;
            unsubscribe();
            clearTimeout(renderTimer);
            clearInterval(heartbeat);
            closeInspector = undefined;
          };
          const close = () => {
            if (closed) return;
            cleanup();
            done(undefined);
          };
          closeInspector = close;
          // Token/tool bursts coalesce; only an open inspector owns a clock.
          const requestRender = () => {
            if (closed || renderTimer !== undefined) return;
            renderTimer = setTimeout(() => {
              renderTimer = undefined;
              if (!closed) tui.requestRender();
            }, 80);
          };
          heartbeat = setInterval(requestRender, 1000);
          const panel = new SubagentPanel(
            registry,
            theme,
            close,
            requestRender,
            { state: inspectorState, keybindings, height: () => Math.max(3, tui.terminal.rows), inspect,
              tui, cwd: ctx.cwd, outputPad: displaySettings.getOutputPad(), codeBlockIndent: displaySettings.getCodeBlockIndent() },
          );
          const subscribe = (registry as typeof registry & {
            subscribe?: (listener: (note: string) => void) => () => void;
          }).subscribe;
          if (typeof subscribe === "function") {
            unsubscribe = subscribe.call(registry, requestRender);
          } else {
            uiListeners.add(requestRender);
            unsubscribe = () => uiListeners.delete(requestRender);
          }
          return Object.assign(panel, { dispose: cleanup });
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
            margin: 0,
          },
        },
      );
    },
  });

  // ── transcript rendering (§7.1, §7.2b) ────────────────────────────────────
  pi.registerEntryRenderer(START_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data as {
      name: string;
      promptSnippet: string;
      model?: string;
      thinking?: string;
      modelReason?: string;
      contextMode: string;
      depth: number;
    };
    let text =
      theme.fg("accent", "▶ ") +
      theme.bold(data.name) +
      theme.fg("dim", ` — ${data.promptSnippet}`) +
      theme.fg("muted", ` · ${data.model ?? "?"}${data.thinking !== undefined ? ` (${data.thinking})` : ""}`) +
      (data.modelReason !== undefined ? theme.fg("dim", ` · reason: ${data.modelReason}`) : "");
    if (expanded) {
      text +=
        theme.fg("dim", `\n    context: ${data.contextMode} · depth ${data.depth}`) +
        theme.fg("dim", "\n    (Ctrl+O on the completion entry shows the output)");
    }
    return new Text(text, 0, 0);
  });

  pi.registerEntryRenderer(DONE_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data as Parameters<typeof doneLine>[0] & { mergedChildren?: number };
    const color = statusColor(data.status as SubagentNode["status"]);
    let text = theme.fg(color, doneLine(data));
    if (expanded) {
      const extras: string[] = [];
      if (data.error !== undefined) extras.push(`error: ${data.error}`);
      if (data.stopReason !== undefined) extras.push(`stop: ${data.stopReason}`);
      if (data.mergedChildren !== undefined) extras.push(`merged children: ${data.mergedChildren}`);
      text += theme.fg("dim", extras.length > 0 ? `\n    ${extras.join(" · ")}` : "");
      if (data.output !== undefined && data.output.trim().length > 0) {
        text += `\n${data.output}`;
      }
    }
    return new Text(text, 0, 0);
  });

  pi.registerMessageRenderer(NOTE_CUSTOM_TYPE, (message, _options, theme) => {
    return new Text(theme.fg("dim", `⏹ ${message.content}`), 0, 0);
  });
}

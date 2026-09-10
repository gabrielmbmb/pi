# Subagent inspector

`/subagents` opens a live tree and automatic task/activity preview. Wide terminals use side-by-side panes; narrow terminals stack the panes, and very short terminals show only the focused pane. The inspector works in Pi's regular and fullscreen TUI modes without replacing the main session or editor.

```text
main
├─ ▾ implementation  ⟳ waiting on children
│  ├─ ✓ api           done
│  └─ ● tests         running
├─ ✗ security         error
└─ … docs             queued #1
```

Selecting a row immediately shows its task, current tool(s), recent activity, model, turns, and reported own usage. Enter opens a **borderless, full-width conversation**, using Pi's actual main-chat components—not an activity table or a lookalike Markdown layout:

- **1 Conversation** — the delegated task as a native user message, streaming assistant replies, and native `read` / `bash` / `edit` / `write` cards, including recorded edit diffs and pending/success/error backgrounds. Uses Pi's theme, message padding, code-block indentation, and initial tool-expansion preference. No per-message timestamps or audit headings. Inherited history and private reasoning remain omitted; images use text placeholders.
- **2 Result** — complete retained result or captured partial output. Merged child sections, errors, stop reasons, and truncation are identified explicitly.
- **3 Details** — full delegated task, current parent, adoption source, model/routing/thinking, context, limits, timestamps, usage, delivery state, and lifecycle/audit events.

Both running and completed agents initially open Conversation, at the latest message. Your subsequent view choices, folding, selection, and scroll positions are remembered until the main session changes or the extension reloads.

## Keys

| Key | Action |
| --- | --- |
| ↑ / ↓ or j / k | Select in the tree; scroll in the viewer or focused preview |
| ← / → or h / l | Collapse / parent; expand / first child |
| Enter | Open the selected agent's viewer |
| Tab | Focus tree / preview |
| 1 / 2 / 3 | Open Conversation / Result / Details |
| PgUp / PgDn | Page the focused list or content |
| Home / End | Beginning / end; End resumes following in Conversation |
| Ctrl+O | Expand or collapse tool output in Conversation |
| Mouse wheel / trackpad | Scroll the conversation in fullscreen mode |
| / | Search agent names and delegated tasks in the tree |
| v | Cycle All / Active / Failed + Partial filters |
| c | Confirm stopping the selected subtree; `main` means every agent |
| ? | Show scrollable contextual help |
| Esc | Dismiss search/confirmation/help, return from viewer, then close |

Pi's configured `tui.select.*` bindings control the picker; Conversation uses `tui.altScreen.*` page/top/bottom and optional line/half-page bindings. `app.tools.expand` controls tool expansion. Navigation aliases are inactive while typing a search. No global editor shortcuts are intercepted.

### Following output

Conversation follows the latest output initially. Scrolling up pauses **following**, never execution. New updates are counted without moving the reader; End resumes following. A worker finishing does not switch tabs or move focus.

### Cancellation

`c` shows the exact active subtree, with **Keep running** selected by default. Tab changes the choice and Enter confirms; `y` explicitly confirms stopping and `n` keeps work running. If additional agents enter the subtree while the confirmation is open, confirmation is reset and the new scope must be reviewed. Finished agents are not cancelled.

Captured partial text and reported usage remain inspectable. **Stopping work does not undo file edits.** Closing the inspector never stops work.

## Commands

```text
/subagents                       # tree + preview
/subagents inspect tests         # open tests directly (name completion supported)
/subagents cancel tests          # confirmed subtree cancellation in UI modes
/subagents cancel all
/subagents config                # routing config + diagnostics
```

The interactive inspector is TUI-only. RPC retains textual command notifications; model-facing status/collection tools remain available independently of the inspector.

## Configuration

The optional `maxConcurrent` setting is read from the same user/project config files as model routing:

```jsonc
{
  "maxConcurrent": 8,
  "defaultThinking": "low",
  "rules": []
}
```

It defaults to **4**, accepts values from **1 to 64**, and is shared across the entire delegation tree. Project config overrides user config. Additional workers are queued; changing the value never interrupts workers already running.

## Spawn validation and model routing

Subagents have no turn-count limit. Turns are tracked for reporting only; explicit cancellation and the optional `timeout_s` still stop work. `/reload` also clears obsolete turn limits from running and queued workers; already-stopped workers are not restarted.

- `model_reason` is optional audit metadata. Whitespace is normalized; text beyond **1,024 characters** is truncated with a warning, never rejected for length. The task prompt is unchanged.
- Omit `model` for the configured default, or the caller's exact provider/model when no usable default exists. This also applies to nested agents; guidance is injected even without a routing config. Do not guess provider prefixes: `openai` and `openai-codex` have separate credentials.
- Overrides are checked for configured credentials **before starting a worker**. Bare IDs select the single authenticated exact match, or (if no exact ID exists) the single authenticated prefix match.
- An explicitly requested provider without credentials can reroute only to **one authenticated provider with the same model ID**. For example, `openai/gpt-5.4` can resolve to `openai-codex/gpt-5.4` when only Codex is authenticated. The actual provider and warning appear in the spawn response and inspector Details.
- No automatic model-ID changes or ambiguous provider choices: those items fail preflight without starting a worker; other valid batch items still start. Unusable configured defaults fall back to inheritance with a warning.
- This checks configured credentials, not their validity, quota, or network reachability. Runtime failures are not retried on other providers.

Use `/reload` to apply changes to new top-level spawns. Already running workers and queued work keep their previous tool/factory closures until they finish.

## History and accounting

- Collection, merge, result-store expiry, and eviction do **not** remove agents from the tree or erase their retained inspection copy. Filtered matches keep their ancestor paths.
- Delivery labels distinguish awaiting collection, collected by a parent, merged into a parent, and an unavailable collection copy. They do not imply human review.
- Adoption changes the displayed ownership tree; the previous parent remains recorded in Details.
- Own model usage is separate from result usage that includes collected/merged descendants. Do not sum inclusive result usage across the tree.
- Usage arrives with finalized assistant messages. It is provider-reported, not an estimate of the in-flight response; an interrupted response can have no usage report.
- Conversation stores at most **200 entries / 512,000 serialized characters** per agent. Text, tool arguments, and result metadata have separate **32,000-character snapshot budgets**, with depth/breadth limits; large strings keep their beginning and end. Truncation and eviction are disclosed in the viewer. These are detached inspection copies, not changes to the worker's context.
- The separate preview/audit log remains bounded to **200 entries / 128,000 characters**, with **12,000 characters per event text**. Results retain the existing 50,000-character cap.
- Rendering never re-executes tools, recomputes edit diffs against current files, or starts native tool execution timers. Like Pi's historical session rendering, tool cards display recorded data; the inspector owns its own live-follow/scrolling.
- Live history is session-local and survives ordinary `/reload`. Session switches/quit dispose workers and clear it. Existing start/completion entries still provide view-only transcript history across restarts; the inspector does not reconstruct old live sessions from those entries.
- Workers predating native conversation capture show a labeled fallback using their retained text/tool summaries. Their existing engine drains queued work; new top-level spawns use structured capture. Reloading cannot recover old tool arguments, diff metadata, or discarded messages.

## Implementation

- `activity.ts`: bounded preview/audit telemetry and terminal-text sanitization.
- `transcript.ts`: bounded, detached SDK message/tool snapshots; no inherited context, private reasoning, or binary image payloads.
- `inspector/conversation.ts`: public Pi chat components and built-in tool renderer factories, cached per retained entry.
- `inspector/model.ts`: pure tree projection, ancestor-preserving filters, scope, and activity labels.
- `inspector/content.ts`: previews and themed Markdown/tool/result/detail content.
- `inspector/panel.ts`: identity-based navigation, height-budgeted layout, scrolling, follow state, and confirmation.
- `session.ts`: capture SDK streaming/tool events without copying inherited messages into child output.
- `manager.ts`: retained result metadata, own usage, lifecycle events, cancellation, and delivery.
- `index.ts`: command wiring, throttled redraws, visible-only heartbeat, and lifecycle cleanup.

The overlay owns its height budget and scroll offsets: Pi's overlay `maxHeight` clips content rather than providing scrolling. Rendering is coalesced at 80 ms and the elapsed-time heartbeat runs only while the inspector is open. Telemetry never invokes the model-facing lifecycle-note hook.

Run `pnpm test` for registry, watcher, navigation, cancellation-race, width/height/Unicode, live-follow, and command lifecycle coverage. Development dependencies are aligned with Pi 0.85.1. Conversation tests compare native message/tool output byte-for-byte in dark/light themes, at multiple widths, with both padding and expansion settings.

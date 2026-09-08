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

Selecting a row immediately shows its task, current tool(s), recent activity, model, turns, and reported own usage. Enter opens a full-width viewer:

- **1 Activity** — streaming assistant text, correlated tool calls/results, retry/compaction notices, and lifecycle/collection/adoption events. Tool output starts collapsed. Inherited conversation history and private reasoning are not displayed.
- **2 Result** — complete retained result or captured partial output. Merged child sections, errors, stop reasons, and truncation are identified explicitly.
- **3 Details** — full delegated task, current parent, adoption source, model/routing/thinking, context, limits, timestamps, usage, and delivery state.

Running agents initially open Activity, terminal agents initially open Result. Your subsequent view choices, folding, selection, and scroll positions are remembered until the main session changes or the extension reloads.

## Keys

| Key | Action |
| --- | --- |
| ↑ / ↓ or j / k | Select in the tree; scroll in the viewer or focused preview |
| ← / → or h / l | Collapse / parent; expand / first child |
| Enter | Open the selected agent's viewer |
| Tab | Focus tree / preview |
| 1 / 2 / 3 | Open Activity / Result / Details |
| PgUp / PgDn | Page the focused list or content |
| Home / End | Beginning / end; End resumes following in Activity |
| Ctrl+O | Expand or collapse tool output in Activity |
| / | Search agent names and delegated tasks in the tree |
| v | Cycle All / Active / Failed + Partial filters |
| c | Confirm stopping the selected subtree; `main` means every agent |
| ? | Show scrollable contextual help |
| Esc | Dismiss search/confirmation/help, return from viewer, then close |

Pi's configured `tui.select.*` and `app.tools.expand` bindings are respected and advertised in the footer. Navigation aliases are inactive while typing a search. No global editor shortcuts are intercepted.

### Following output

Activity follows the latest output initially for running agents. Scrolling up pauses **following**, never execution. New updates are counted without moving the reader; End resumes following. A worker finishing does not switch tabs or move focus.

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

## History and accounting

- Collection, merge, result-store expiry, and eviction do **not** remove agents from the tree or erase their retained inspection copy. Filtered matches keep their ancestor paths.
- Delivery labels distinguish awaiting collection, collected by a parent, merged into a parent, and an unavailable collection copy. They do not imply human review.
- Adoption changes the displayed ownership tree; the previous parent remains recorded in Details and Activity.
- Own model usage is separate from result usage that includes collected/merged descendants. Do not sum inclusive result usage across the tree.
- Usage arrives with finalized assistant messages. It is provider-reported, not an estimate of the in-flight response; an interrupted response can have no usage report.
- Activity stores at most **200 entries / 128,000 characters** per agent, with **12,000 characters per entry**. Large entries retain their tail. Earlier discarded events/text are disclosed in Activity. Results retain the existing 50,000-character cap.
- Live history is session-local and survives ordinary `/reload`. Session switches/quit dispose workers and clear it. Existing start/completion entries still provide view-only transcript history across restarts; the inspector does not reconstruct old live sessions from those entries.
- When upgrading from the old inspector during a run, existing workers cannot retroactively provide uncaptured events. Their existing engine drains queued work; new top-level spawns use the instrumented watcher. Start a fresh session for uniformly instrumented workers.

## Implementation

- `activity.ts`: bounded observer-only telemetry and terminal-text sanitization.
- `inspector/model.ts`: pure tree projection, ancestor-preserving filters, scope, and activity labels.
- `inspector/content.ts`: previews and themed Markdown/tool/result/detail content.
- `inspector/panel.ts`: identity-based navigation, height-budgeted layout, scrolling, follow state, and confirmation.
- `session.ts`: capture SDK streaming/tool events without copying inherited messages into child output.
- `manager.ts`: retained result metadata, own usage, lifecycle events, cancellation, and delivery.
- `index.ts`: command wiring, throttled redraws, visible-only heartbeat, and lifecycle cleanup.

The overlay owns its height budget and scroll offsets: Pi's overlay `maxHeight` clips content rather than providing scrolling. Rendering is coalesced at 80 ms and the elapsed-time heartbeat runs only while the inspector is open. Telemetry never invokes the model-facing lifecycle-note hook.

Run `pnpm test` for registry, watcher, navigation, cancellation-race, width/height/Unicode, live-follow, and command lifecycle coverage. Development dependencies currently predate the target Pi 0.85.1 runtime; SDK compatibility is checked against the installed runtime's declarations.

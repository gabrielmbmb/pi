# Subagents extension — design (v3, settled)

In-process subagent delegation for pi: the main agent spawns background subagents, fans out work in parallel, collects their results, and can build arbitrarily deep (≤ 3) delegation trees. Subagents are real `AgentSession`s created via the pi SDK (`createAgentSession`) inside the extension's own process — **not** spawned `pi` child processes.

Supersedes `prompts/subagent.md` (removed when this lands).

---

## 1. Architecture

```
extensions/subagents/
├── index.ts          # pi.registerTool ×4, pi.registerCommand (/subagents), pi.on lifecycle, entry renderers
├── manager.ts        # registry: the one source of truth (tree of subagent nodes + result store)
├── session.ts        # createSubagentSession(): in-process AgentSession factory; abort cascade wiring
├── context.ts        # history → seed-messages builder (none | last_n_turns | all), current-turn trimming
├── config.ts         # model-routing config: load/validate/merge user + project subagents.json
├── routing.ts        # injected guidance block + model resolution chain at spawn
├── render.ts         # compact transcript/footer formatting
├── activity.ts       # bounded observer-only event log
└── inspector/        # tree projection, preview, transcript, navigation, cancellation UI
```

**Single registry, one entry per subagent:**

```ts
node = {
  name,                    // globally unique at spawn (reject collisions)
  parentName,              // "__main__" = root (depth 0, lives for the whole session)
  depth,                   // spawn blocked at depth ≥ MAX_DEPTH
  status,                  // queued | running | done | error | cancelled | partial
  session, abort, done,
  result,                  // retained inspection payload (see §4); store copy removed on fetch
  model, thinking, contextMode,
  onParentError,           // "adopt" (default) | "kill"
  maxTurns, startedAt, usage
}
```

Everything — tools, commands, lifecycle hooks, UI — reads/writes this registry. Children of child sessions get the four tools as `customTools` **closure-bound to their own name** (per-level `makeTools(agentName)`), so the same tool code enforces ownership at every depth.

The registry instance is module-scoped and **attached to `globalThis`**, so it survives extension `/reload` (running subagents and uncollected results keep working; re-registered tools bind to the same instance). Teardown policies in §3 distinguish reload from real session switches.

### Why in-process

- The three context modes (full history / last N turns / none) are only implementable with real message seeding.
- Streaming, usage aggregation (`usage` in tool results → pi cost stats), and abort (`session.abort()`) are first-class.
- Tradeoffs accepted: no crash isolation; session teardown must cancel everything; background work dies on process exit (interactive-only).

---

## 2. API surface

| Tool | Params | Behavior |
|---|---|---|
| `spawn_subagents` | `subagents[]` each: `{name, prompt, context: "none"\|"last_n_turns"\|"all", context_turns?, model?, thinking?, onParentError?, max_turns?, timeout_s?, model_reason?}` | Batch spawn; returns immediately per item: `{name, status: running\|queued, queuePosition, model, thinking}` (resolved routing outcome — lets the agent audit its own choices). Queued past `MAX_CONCURRENT`. Depth ≥ 3 → the tool is **unbound** (children at max depth can't attempt it). `executionMode: "parallel"` (spawns touch no shared files — safe for concurrent tool-call fan-out). Full validation table in §13. |
| `collect_subagents` | `names[]`, `timeout_s?` (0 = none) | **Parent-only.** Blocks until all listed finish (timeout → returns what's done, others marked `running` — does not cancel); streams ✓/⏳/✗ rows via `onUpdate`; returns payloads in **requested order**, per-item statuses (one child erroring doesn't fail the batch); combined `usage`; **removes results from the store.** |
| `subagent_status` | `name?` (all) | **Any ancestor** + user. Non-blocking; status + 4 KB snippets. Late collection path. |
| `cancel_subagent` | `name?` (omitted = **whole caller subtree**) | **Any ancestor** + user. **Cascades down the subtree** (recursively aborts sessions, including still-queued items); marks `cancelled`; emits one batched interrupt-note (§4, §13). |

**Command `/subagents`:** bare → live tree + automatic preview; Enter opens a scrollable Activity / Result / Details viewer. Completed agents remain inspectable after collection/expiry. `c` confirms the selected subtree's cancellation (Keep running by default). `/subagents inspect <name>` opens one agent directly; `/subagents cancel <name|all>` confirms cancellation in UI modes; `/subagents config` shows routing diagnostics. No spawn from the command — agent-only spawning. See [README.md](README.md) for controls and retention limits.

---

## 3. Execution model

- **Background-first.** Spawn returns instantly; the model can emit several spawn calls in one turn → parallel fan-out is the default flow, no parallel mode needed.
- **Fan-in.** The model calls `collect_subagents` to wait — this is the "Codex orchestrator waits for all results" pattern.
- **Merge-at-settle.** A subagent that settles with children still running auto-collects them (parent status shows transient `merging`): waits ≤ `MERGE_TIMEOUT_S`, cancels the stragglers (recursively, marked `(cut off)`), and merges children outputs into its own final output — its own text first, then `## name (status)` sections in **spawn order**, truncated from the **bottom** to 50 KB total. Only for *normal* terminations (done/partial/max_turns); error terminations take the adoption path. Every subtree completes bottom-up; nothing is ever unfetchable.
- **Adoption.** A parent that dies **unexpectedly** (session error, `timeout_s` expiry, provider failure — *not* user cancel, which cascades) re-parents its running children to the **nearest living ancestor** (walk up the tree; always `__main__` in practice). Adopted nodes keep their original depth; the popup marks them as adopted. `onParentError: "kill"` per spawn opts out (children cancelled recursively instead).
- **Turn-end with uncollected children at depth ≥ 1** is impossible by construction (sessions end at settle; merge-at-settle covers them). At depth 0 (main agent) uncollected results stay in the store until fetched or TTL.

### Cancellation matrix

| Trigger | Effect |
|---|---|
| Esc during `collect_subagents` | Collect + main run abort; surviving background workers keep running |
| `cancel_subagent` / `/subagents cancel` | That node + subtree; cancelled status; context note |
| Session replacement / quit (`session_shutdown`, `/fork`) | Cancel-all + `dispose()` every session |
| `/reload` | Keep running workers and retained results; rebind UI/registry behavior |
| `timeout_s` (optional) | Per subagent, v2 for per-node; value → `error` |

---

## 4. Completion model (what reaches the main agent)

**Pull, never auto-inject.** Basis: Claude Code ("results reach Claude as a completion notification in a later turn; it waits for it before reporting"), Codex (orchestrator waits + consolidates), Cursor (results attached explicitly only).

Completion payload (registry + collect result):

```ts
{
  name, status,                       // done | error | cancelled | partial
  output,                             // final text; stored 50 KB, injected to model ≤ 4 KB snippet
  partialOutput, lastToolActivity,    // always included on error — partial work isn't lost
  model, thinking, modelReason,
  usage: { inputTokens, outputTokens, cost }, turns, durationSec, startTime, endTime,
  stopReason, error,                  // diagnostics
  contextMode, contextTurns
}
```

- `collect_subagents` returns payloads and **combined usage** (pi credit accounting includes subagent work).
- **Interrupt-injection (opt-out-able, default on):** cancellation, adoption, and merge-timeout kills are recorded as a short **factual** note via `pi.sendMessage({customType: "subagent_state_change", …}, { deliverAs: "nextTurn", triggerTurn: false })` — included in the next turn's context, never triggers a run, batched per event burst, rendered in the transcript via `registerMessageRenderer`. Rationale: the one state change the model cannot otherwise know about; precedent: Codex's `agents.interrupt_message` (default true). Completion alone never injects.

---

## 5. Context modes

Seed = entries built from the **calling session's** `sessionManager.getBranch()` (uniform at every depth), passed as `SessionManager.inMemory(cwd, { id: name }, entries)` — entries-based seeding is first-class in the runtime SDK (0.85.1: `FileEntry[]`; ids rebuilt with a fresh linear parent chain; compaction summaries mapped to message entries). Goes through the same path as session resume, so seeded history is expected to be visible to grandchildren (`getBranch()` at depth 2 — still spike-verified, §10).

- `none` — system prompt (+ routing block) + task prompt only.
- `last_n_turns` — messages since the Nth-last *user* message (`context_turns`, 1–30).
- `all` — full active branch via `buildContextEntries()` (compaction-aware).

**Entry→seed conversion (verified shape, 0.85.1):** `buildContextEntries()` returns a mixed list — `message` entries plus `compaction` entries (the compaction entry itself, then kept entries) and possibly `branch_summary`. Conversion: `message` entries → seed messages; `compaction` entries → one user-role summary text; `branch_summary` → dropped; ids rebuilt with a fresh linear parent chain. Subagent session ids (= names) must satisfy `assertValidSessionId` — verify the name regex against it in the spike.

**Trim rule (precise):** seed = all branch entries **strictly before the last user-message entry preceding the in-flight assistant message that contains the spawn tool call**. This excludes the current run (the user request that triggered the spawn, any steers, and the spawn tool-call message itself) while keeping all earlier history. Deterministic for batch spawns (same seed for all items) and for parallel tool calls in one assistant message. Compaction summaries (from `buildContextEntries`) map to user-role seed messages.
- `last_n_turns`: `context_turns` (1–30, required) counts user-message entries; slice = from the Nth-last user entry (inclusive) through the trim point. Compaction summaries count as one user entry each.

Caveats: history seeding duplicates tokens (all-mode ≈ a second copy of context); **image parts are dropped from seeds unconditionally in v1** (capability-aware pass = v2 nicety).

---

## 6. Model routing (token-burn control)

Config, two layers (merged by rule name; project overrides):

```
~/.pi/agent/subagents.json     # user
.pi/subagents.json             # project
```

```jsonc
{
  "defaultModel": "gpt-5.6-luna",
  "defaultThinking": "low",
  "rules": [
    { "name": "reading files",
      "description": "read, grep, search, and summarize code or docs; recon; quick lookups",
      "model": "gpt-5.6-luna", "thinking": "low" },
    { "name": "implementing complex algorithms",
      "description": "design and implement algorithms, concurrency, data structures, systems design",
      "model": "gpt-6-astra", "thinking": "high" }
  ]
}
```

- Loaded fresh from disk on every tool call (hot reload). Validation severities: **file-level errors** (invalid JSON, duplicate rule names within a file, > `MAX_RULES`, description > `MAX_RULE_DESC_CHARS`, bad `thinking`) → hard error, spawns blocked, diagnostics via `/subagents config`; **per-rule model unresolvable** → that rule disabled + diagnostic (spawns still work); **`defaultModel` unresolvable** → warning + inherit fallback. Precedence: project > user per rule name; project `defaultModel`/`defaultThinking` win when present.
- **Bare-id resolution** (no `/` in the id): exact `model.id` match across `ctx.modelRegistry.getAll()` → unique provider; else prefix match with exactly one candidate; else error listing top candidates. Providers with no configured auth (`hasConfiguredAuth`) match last; unresolved auth on the *chosen* model → warning only (model fallback chains may still work). Optional shortcut: `resolveCliModel()` helper (exported from `model-resolver`) if its semantics fit — evaluate in Phase 1.
- **The agent routes by task similarity** (per user decision): injected guidance block (bullets via `promptGuidelines` on the spawn tool; same block via `DefaultResourceLoader.appendSystemPrompt` into subagent sessions at every depth) lists `name → model/thinking` + ~60-char description snippet per rule; full descriptions live in the file (readable).
- **Resolution chain:** explicit `model`/`thinking` params (agent chose a rule) → `defaultModel`/`defaultThinking` → inherit parent session. Cheap-by-default; expensive-on-demand. No config → inherit (feature opt-in).
- **Injection (always fresh):** a `pi.on("before_agent_start")` handler appends the current routing block to the system prompt of every main-session turn (config re-read per turn, cached; returns nothing on any error or when no config exists — idempotent, zero-risk fallback). *Spike-verified adjustment:* pi-ai has no `system` message role, so the originally planned `pi.on("context")` system-role prepend is impossible; `before_agent_start` systemPrompt chaining provides the same per-turn freshness and lands in every provider payload of that turn. Subagent sessions get the same block via `appendSystemPrompt` (built fresh per spawn, so guidance is never stale at any depth). `promptGuidelines` carries only a one-line static pointer to the config path.
- `model_reason` param (e.g. `"rule: reading files"`) surfaced in the popup/usage line for burn auditing.

---

## 7. UI/UX

The implemented inspector and controls are documented in [README.md](README.md).

1. **Quiet footer:** live counts and `/subagents` discoverability. Collection availability is not labeled as human review. No persistent sidebar/editor replacement.
2. **Tree + preview:** explicit connectors and collapsible branches; current ownership including adoption; automatic task/current-tool/recent-activity preview. Stable identity-based selection and spawn order. All nodes remain inspectable; search and Active/Failed filters retain ancestor paths.
3. **Agent viewer:** Enter opens Activity, Result, or Details at full width inside the same overlay. Activity renders own assistant messages and correlated tool results, follows output while at the end, and pauses following when scrolled up. Result shows the full retained output with error/truncation/merged-child metadata; Details includes the full delegated task and configuration.
4. **Safe controls:** arrows select/fold, Tab switches pane focus, configured Pi selection/expansion keys are honored, and Escape unwinds UI depth without affecting work. Cancellation shows the exact active subtree and defaults to Keep running; new descendants require renewed confirmation. Partial output is preserved; file edits are never described as rolled back.
5. **Observability:** `session.subscribe` captures streaming/tool/lifecycle events into a bounded log, independently of whether the inspector is open. Own usage updates from finalized messages, excluding inherited seed history and delegated totals. Observer updates never enter model context or invoke the model-facing lifecycle-note hook.
6. **Rendering:** height-budgeted near-full-terminal overlay with responsive split/stacked layouts, manually owned viewports, 80 ms redraw coalescing, and a one-second heartbeat only while open. Cleanup removes timers/subscriptions on close and session teardown. Inspection never calls session-switch or collection APIs.
7. **Transcript integration:** existing start/completion entries, cancellation/adoption notes, completion notifications, and collect progress remain. Persisted completion entries provide view-only history across restarts; the live inspector itself is session-local.
8. **Mode guards:** custom components are TUI-only; RPC command notifications and model-facing status/collection remain independent. Legacy workers surviving an upgrade cannot retroactively expose events that were never captured.

---

## 8. Constants

```ts
MAX_DEPTH: 3,                // root = 0; spawn blocked at depth 3 (tool unbound; error otherwise)
MAX_CONCURRENT: 4,           // beyond → queued
MERGE_TIMEOUT_S: 300,        // merge-at-settle wait before cancelling stragglers
OUTPUT_CAP: 50_000,          // per-subagent stored output
SNIPPET_CAP: 4_000,          // status-tool injection
UNCOLLECTED_TTL_MS: 3_600_000,
RESULT_STORE_MAX: 20,        // LRU of done results before TTL
DEFAULT_ON_PARENT_ERROR: "adopt",
MAX_RULES: 20, MAX_RULE_DESC_CHARS: 200, GUIDANCE_SNIPPET_CHARS: 60,
// validation bounds (see §13)
MAX_NAME_LEN: 40, MAX_TURNS: 50, MAX_CONTEXT_TURNS: 30, SPAWN_TIMEOUT_MAX_S: 3600,
// teardown policy: cancel-all + dispose on quit | new | resume | fork; KEEP on reload
```

## 9. Session factory rules

- `SessionManager.inMemory(cwd, { id: name }, seedEntries)` — ephemeral, id = name, seeds per §5.
- Model runtime: `createAgentSession({ modelRuntime? })` — runtime SDK exposes `ModelRuntime.create()`; default resolution shares the same auth/env as the running pi (credentials work out of the box; concurrent streams spike-verified, §10). `ModelRuntime.create()` defaults are convenient: `authPath` resolves from the same agent dir, `allowModelNetwork: false` (no surprise catalog fetches when spawning).
- `DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, appendSystemPrompt: [routingBlock] })` — no extension re-discovery → no recursion; context files (AGENTS.md) stay loaded. One loader instance is built **per spawn call and shared across the batch** (avoids repeated reload cost).
- Tools: allowlist `read/bash/edit/write` default plus the **bound subagent tool names** — a `createAgentSession` `tools` allowlist silently disables any `customTools` name not listed (spike finding). At depth == `MAX_DEPTH` the **spawn tool is unbound** (nothing to spawn into), matching Claude Code's depth-limit behavior.
- Model/thinking: per §6; children inherit from their parent session's resolved model.
- Session lifecycle: `session.abort()` on cancel (cascade), `dispose()` on teardown; `turn_end` counting for `max_turns` (`agent_end` is emitted once for the overall prompt run).

## 10. Spike risks (validate first)

**Status: complete.** All seven risks verified against the nix-managed runtime pi 0.85.1 (live scripted main→child→grandchild run + offline checks; throwaway `spike/` deleted). Results: #1 ✓ seeds visible at depth 2 (codeword round-trip main→child→grandchild; trim rule confirmed live — the in-flight assistant message *is* present in `buildContextEntries()` at tool time). #2 ✓ `session.abort()` during streaming stops the run, `prompt()` settles, `stopReason: "aborted"`, partial output preserved; caveat: aborted runs report **zero usage**. #3 ✓ usage accumulates from `agent_end` messages and tool-result `usage` persists (both the `tool_result` event and the session entries carry it); pi `Usage` shape is `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { …, total } }` — not `inputTokens/outputTokens`. #4 ✓ SDK sessions execute bash directly, no permission hang (the `config.allowFileWrites` contingency is not needed; keep it documented anyway). #5 ✓ two children streamed concurrently on the same provider. #6 ✓ **mechanism change:** pi-ai has no `system` message role, so `pi.on("context")` cannot prepend a system-role message — injection uses `before_agent_start` systemPrompt chaining instead (verified: marker present in every provider payload); `sendMessage` custom content confirmed in the next call's payload (model obeyed an instruction carried only by the note). #7 ✓ name regex ⊆ `assertValidSessionId`. Implementation-critical extras: the `createAgentSession` `tools` allowlist **must include custom tool names** or they are silently disabled; extension-created timers must be cleared (they hold the process open); `resolveCliModel()` was evaluated and rejected for bare-id resolution (fuzzy alias/date heuristics, synthesized fallback models) — `routing.ts` implements the strict chain instead.

1. Seeding via `inMemory(..., entries)` is visible to grandchildren (`getBranch()` at depth 2). If not: fall back to `agent.state.messages` assignment and accept depth-≥2 `all`-context degradation.
2. Abort propagation: tool `signal` → `session.abort()` → recursive children abort.
3. Usage aggregation from `agent_end` messages into tool result `usage` (handler result patch `usage` — confirmed supported in 0.85.1 docs).
4. Permission mode of SDK-created sessions in the running pi (auto-accept vs hanging prompt). If prompts hang: v1 background subagents default to read-only tools per §13 contingency.
5. Concurrent in-process provider streams (2+ sessions same provider).
6. `pi.on("context")` injection (documented: "Fired before each LLM call. Can modify messages"): confirm prepended system message lands in the LLM payload without breaking subsequent turns; handler must be a strict no-op on error (main agent integrity is non-negotiable). Also confirm `sendMessage(..., {deliverAs: "nextTurn"})` custom-message content lands in the next turn's model context (not just the transcript).
7. `assertValidSessionId` rules vs the `name` regex — adjust id generation if the in-memory session id (name) is rejected.

## 11. Research basis

Claude Code: notify-then-pull; summary-only results; nested subagents with depth+concurrency limits and `(+N)` tree panel; partial output preserved on failure; background tool trimming; `isolation: worktree`. Codex: orchestrator waits + consolidated response; `agents.interrupt_message` (default true); max concurrent threads; token-burn reports. Cursor: weakest pattern (results never auto-reach the main thread).

## 12. v2 backlog

- `isolation: "worktree"` (reuse this repo's `worktree.ts` machinery) — solves cross-session file races.
- Per-rule `tools`/`max_turns` profiles; `timeout_s` refinement.
- Batch-spawn token optimization if multi-call fan-out proves hungry.
- Persistent/reconstructable inspector history across process restarts and transcript search.
- Role definition files (agent markdown w/ frontmatter) if named roles ever return.
## 13. Validations, edge cases, resolved ambiguities (final review)

**Spawn validation** (each item fails atomically with an actionable error; the rest of the batch still spawns):

| Param | Rule |
|---|---|
| `name` | `[A-Za-z0-9_-]{1..40}`; **globally unique for the whole session lifetime** (finished names are not reusable — registry is append-only, keeps result store unambiguous) |
| `prompt` | non-empty, ≤ 20 KB |
| `context` | `none` \| `last_n_turns` \| `all` |
| `context_turns` | required iff `last_n_turns`; 1–30 |
| `model`/`thinking` | resolvable per §6 (else error with candidates); thinking enum |
| `onParentError` | `adopt` (default) \| `kill` |
| `max_turns` | 1–50; counted by the child session's `turn_end` events (one model/tool cycle; `agent_end` is run-level); reached → stop, status `partial` |
| `timeout_s` | 1–3600; expiry → abort, status `error`, stopReason `timeout`; running children go down the adoption path |
| `model_reason` | ≤ 80 chars, free-form (audit only) |
| depth | spawn tool unbound at depth == `MAX_DEPTH` |
| empty batch | `subagents: []` → error |

**Collect semantics:** unknown / not-a-direct-child / already-collected names → whole call errors *before* waiting, listing the caller's actual children. Returned payloads in requested order; statuses per item (`done`, `error`, `cancelled`, `partial`); a failed child does not fail the batch; `timeout_s: 0` (default) = wait indefinitely (Esc aborts the tool call). Results removed from the store regardless of item status.

**Cancel semantics:** omitted name = caller's entire subtree. Queued items (session not yet created) are marked `cancelled` directly without abort. One batched interrupt-note per cascade (never one per node). Captured own output and reported usage are preserved. Cancelling a `merging` parent cancels its still-active descendants; the pending merge cannot resurrect the cancelled parent or overwrite its partial result.

**Merge-at-settle:** only fires for normal terminations (done/partial) with live children; sections in spawn order; truncation from the last child backward to keep parent text intact; payload gains `mergedChildren: n`.

**Adoption:** trigger set = parent `error` (session/provider error, `timeout_s` expiry) with live children, `onParentError: "adopt"`; nearest **living** ancestor (walk up; root always alive while session runs; on teardown everything dies — no adoption). Depth unchanged; the popup + interrupt-note mark it.

**Registry lifecycle:** survives `/reload` (globalThis-attached instance); `session_shutdown` with reason `quit | new | resume | fork` → cancel-all + `dispose()` of every session; reason `reload` → keep. The footer status is rebuilt at `session_start`, and an open overlay subscribes to registry changes.

**Routing config:** severities per §6 (file-level hard error vs per-rule disable vs default warn); parse failure blocks spawns with the file path + error.

**UI behavior:** footer status updates from registry transitions and clears when no work/collectable results remain; the inspector subscribes to observer telemetry and lifecycle changes, with coalesced rendering and a visible-only elapsed-time heartbeat. Completed nodes remain inspectable regardless of collection availability. Start/completion entries and state-change chips remain separate from observer-only activity. See §7 and [README.md](README.md).

**Tests** (`tests/subagents.test.mjs`, Node 26 native TS import): config load/merge/severities, bare-id resolution, guidance block rendering, trim-rule slicing, last-N-turn slicing, merge ordering/truncation, adoption walk. Logic modules (`config.ts`, `routing.ts`, `context.ts`) stay pure/UI-free for this.

**Permission mode (spike risk #4 — contingency):** SDK-created sessions expose no permission API in 0.80.6. If the spike shows subagent tool calls block on prompts that can't render: v1 ships `config.allowFileWrites` (default true); when false, subagent tool allowlist drops to read-only tools (`read`/`grep`/`find`/`ls`) and the docs say so.

## 14. Implementation order & spike acceptance (handoff plan)

**Phase 0 — spike (throwaway `spike/` dir, delete after):** verify the seven §10 risks against the **nix-managed runtime pi 0.85.1** — that is the version the extension executes in, even though the repo's `devDependencies`/`node_modules` pin `@earendil-works/pi-coding-agent` 0.80.6 (stale local tooling only). Canonical reference: `/nix/store/nmqcsavb2l9fbq560slb8iq1a5xfjnbq-pi-coding-agent-0.85.1/lib/node_modules/@earendil-works/pi-coding-agent/` (docs/, examples/, and full `dist/*.d.ts` typings).
1. Seeds via `inMemory(..., entries)` are visible to grandchildren (`getBranch()` at depth 2). If not: fall back to `agent.state.messages` assignment and accept depth-≥2 `all`-context degradation (note in §10).
2. Abort propagation: tool `signal` → `session.abort()` → recursive children abort.
3. Usage aggregation from `agent_end` messages into tool result `usage`.
4. Permission behavior of `createAgentSession` sessions (see contingency in §13).
5. Concurrent in-process provider streams (2+ sessions same provider).
6. `pi.on("context")` routing-block injection (see §6): idempotent, error-safe no-op.
7. `assertValidSessionId` rules vs the `name` regex — adjust id generation if the in-memory session id (name) is rejected.
Acceptance: a scripted main→child→grandchild run demonstrates seeds, streaming, usage, and abort end-to-end.

**Phase 1 — core modules** (pure, UI-free, testable): `config.ts` → `routing.ts` → `context.ts` (trim/slice logic) with `tests/subagents.test.mjs` alongside (Node 26 native TS imports).

**Phase 2 — manager + sessions:** `manager.ts` (tree, queue, result store, adoption/merge/cancel machinery) → `session.ts` (factory, bound `customTools`, depth unbind).

**Phase 3 — tools + commands:** `index.ts` registering the four tools + `/subagents`; interrupt-injection via `sendMessage(..., {deliverAs: "nextTurn", triggerTurn: false})`.

**Phase 4 — UI:** `render.ts` (entries, chips, compact status, popup explorer, notifications), wired to registry events.

**Phase 5 — delivery:** README extensions table row, remove `prompts/subagent.md`, squash to one clean commit; manual end-to-end pass in `~/.pi/agent/extensions/` symlink or pnpm workspace run (check how other extensions here are loaded/tested via `tests/*.test.mjs`).
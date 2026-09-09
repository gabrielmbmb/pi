import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TranscriptLog } from "../extensions/subagents/transcript.ts";
import { SubagentRegistry, ResultStore, getSharedRegistry } from "../extensions/subagents/manager.ts";
import { ROOT_AGENT_NAME } from "../extensions/subagents/constants.ts";
import { ActivityLog, ACTIVITY_MAX_CHARS, ACTIVITY_MAX_EVENTS, plainText } from "../extensions/subagents/activity.ts";
import { SubagentPanel, createInspectorState } from "../extensions/subagents/inspector/panel.ts";
import { treeRows, currentActivity } from "../extensions/subagents/inspector/model.ts";
import { InspectorContent } from "../extensions/subagents/inspector/content.ts";
import { watchSession, getSharedEngine } from "../extensions/subagents/session.ts";
import subagentsExtension from "../extensions/subagents/index.ts";

initTheme("dark", false);

const theme = {
  fg: (_color, text) => text, bg: (_color, text) => text,
  bold: (text) => text, italic: (text) => text, underline: (text) => text, strikethrough: (text) => text,
};
const keys = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", end: "\x1b[F", home: "\x1b[H", pageDown: "\x1b[6~", pageUp: "\x1b[5~" };

function spawn(registry, name, parentName = ROOT_AGENT_NAME, extra = {}) {
  return registry.register({ name, parentName, contextMode: "none", onParentError: "adopt", prompt: `Task for ${name}`, ...extra });
}
function running(registry, name, parentName = ROOT_AGENT_NAME, extra = {}) {
  const node = spawn(registry, name, parentName, extra);
  registry.markRunning(name, { async abort() {}, dispose() {} });
  return node;
}
function panel(registry, options = {}) {
  const state = options.state ?? createInspectorState();
  let closed = 0;
  const component = new SubagentPanel(registry, theme, () => closed++, () => {}, { height: () => 24, ...options, state });
  return { component, state, render: (width = 120) => component.render(width).join("\n"), closed: () => closed };
}
function assistant(text, cost = 0.2) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: cost } } };
}
function watched(registry, node, seeds = []) {
  let listener;
  let disposed = 0;
  const session = {
    messages: [...seeds],
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    async abort() {},
    dispose() { disposed++; },
  };
  const finish = watchSession(registry, node, session);
  return { session, finish, send: (event) => listener?.(event), disposed: () => disposed };
}

test("inspector: collection and eviction never remove nodes or ancestor paths", () => {
  const registry = new SubagentRegistry();
  running(registry, "parent");
  running(registry, "child", "parent");
  registry.settle("parent", { status: "error", output: "retained answer" });
  registry.fetchResults(["parent"]);
  registry.store.clear();
  const rows = treeRows(registry, new Set(), "child");
  assert.deepEqual(rows.map((row) => row.name), [ROOT_AGENT_NAME, "parent", "child"]);
  assert.equal(rows[1].prefix, "└─ ");
  assert.equal(rows[2].prefix, "   └─ ");
  const ui = panel(registry, { inspect: "parent" });
  assert.match(ui.render(), /retained answer/);
  ui.component.handleInput("2");
  assert.match(ui.render(), /Collected by main/);
});

test("inspector: stable identity, real folding, parent/child navigation", () => {
  const registry = new SubagentRegistry();
  running(registry, "parent");
  running(registry, "child", "parent");
  running(registry, "other");
  const ui = panel(registry);
  ui.state.selectedName = "parent";
  ui.render();
  ui.component.handleInput(keys.right);
  assert.equal(ui.state.selectedName, "child");
  registry.settle("parent", { status: "error" });
  registry.fetchResults(["parent"]);
  assert.match(ui.render(), /child/);
  assert.equal(ui.state.selectedName, "child");
  ui.component.handleInput(keys.left);
  assert.equal(ui.state.selectedName, "parent");
  ui.component.handleInput(keys.left);
  assert.ok(ui.state.collapsed.has("parent"));
  assert.equal(treeRows(registry, ui.state.collapsed).some((row) => row.name === "child"), false);
  ui.component.handleInput(keys.right);
  assert.equal(ui.state.collapsed.has("parent"), false);
});

test("inspector: active/error filters retain context and adopted ownership is explicit", () => {
  const registry = new SubagentRegistry();
  running(registry, "parent");
  const child = running(registry, "child", "parent");
  registry.settle("parent", { status: "error", error: "provider failed" });
  assert.deepEqual(treeRows(registry, new Set(), "", "active").map((row) => row.name), [ROOT_AGENT_NAME, "parent", "child"]);
  registry.onUnexpectedFailure("parent");
  assert.equal(child.parentName, ROOT_AGENT_NAME);
  assert.match(child.activity.entries.at(-1).title, /Adopted from parent by main/);
  assert.match(panel(registry).render(), /\[adopted\]/);
});

test("inspector: preview is automatic and Enter/Escape have distinct depths", () => {
  const registry = new SubagentRegistry();
  running(registry, "worker", ROOT_AGENT_NAME, { prompt: "Investigate token refresh" });
  const ui = panel(registry);
  assert.match(ui.render(), /Investigate token refresh/);
  ui.component.handleInput(keys.enter);
  assert.match(ui.render(), /Conversation/);
  assert.match(ui.render(), /Read-only/);
  assert.doesNotMatch(ui.render(), /╭|╰|Activity · own messages/);
  ui.component.handleInput("3");
  assert.match(ui.render(), /Delegated task/);
  ui.component.handleInput(keys.esc);
  assert.match(ui.render(), /TREE focused/);
  assert.equal(ui.closed(), 0);
  ui.component.handleInput(keys.esc);
  assert.equal(ui.closed(), 1);
  assert.equal(registry.nodes.get("worker").status, "running");
});

test("inspector: full retained result scrolls beyond the old five-line limit", () => {
  const registry = new SubagentRegistry();
  running(registry, "worker");
  registry.settle("worker", { status: "done", output: Array.from({ length: 100 }, (_, n) => `paragraph ${n}\n`).join("\n") });
  const ui = panel(registry, { inspect: "worker" });
  assert.match(ui.render(), /Conversation/);
  ui.component.handleInput("2");
  assert.match(ui.render(), /Result · done/);
  assert.doesNotMatch(ui.render(), /paragraph 99/);
  ui.component.handleInput(keys.end);
  assert.match(ui.render(), /paragraph 99/);
  ui.component.handleInput(keys.home);
  assert.match(ui.render(), /paragraph 0/);
  assert.ok(registry.store.isAvailable("worker"));
});

test("inspector: following pauses on scroll and new output does not move the reader", () => {
  const registry = new SubagentRegistry();
  const node = running(registry, "worker");
  node.transcript = new TranscriptLog();
  node.transcript.user("task", node.prompt);
  for (let i = 0; i < 40; i++) node.transcript.assistant(`${i}`, assistant(`event-${i}`), false);
  const ui = panel(registry, { inspect: "worker" });
  assert.match(ui.render(), /event-39/);
  assert.match(ui.render(), /LIVE · following/);
  ui.component.handleInput(keys.home);
  assert.match(ui.render(), /event-0/);
  node.transcript.assistant("new", assistant("newest-event"), true);
  assert.match(ui.render(), /event-0/);
  assert.doesNotMatch(ui.render(), /newest-event/);
  assert.match(ui.render(), /1 updates/);
  ui.component.handleInput(keys.end);
  assert.match(ui.render(), /newest-event/);
});

test("inspector: tree search is editable and never intercepts action letters", () => {
  const registry = new SubagentRegistry();
  running(registry, "cat");
  running(registry, "dog");
  const ui = panel(registry);
  ui.component.focused = true;
  ui.component.handleInput("/");
  for (const c of "cat") ui.component.handleInput(c);
  assert.equal(ui.state.query, "cat");
  assert.equal(registry.nodes.get("cat").status, "running");
  assert.doesNotMatch(ui.render(), /dog/);
  ui.component.handleInput(keys.esc);
  assert.equal(ui.state.query, "");
  assert.match(ui.render(), /dog/);
});

test("inspector: cancellation defaults to keep, revalidates new descendants, retains output", () => {
  const registry = new SubagentRegistry();
  const parent = running(registry, "parent");
  parent.liveOutput = "Partial work";
  const ui = panel(registry);
  ui.state.selectedName = "parent";
  ui.component.handleInput("c");
  assert.match(ui.render(), /\[Keep running\]/);
  ui.component.handleInput(keys.enter);
  assert.equal(parent.status, "running");
  ui.component.handleInput("c");
  running(registry, "child", "parent");
  ui.component.handleInput("y");
  assert.equal(parent.status, "running");
  assert.match(ui.render(), /subtree changed/);
  assert.match(ui.render(), /child/);
  ui.component.handleInput("y");
  assert.equal(parent.status, "cancelled");
  assert.equal(registry.nodes.get("child").status, "cancelled");
  assert.equal(parent.result.output, "Partial work");
});

test("inspector: main cancellation is one atomic cascade and leaves completed output", () => {
  let pumps = 0;
  const registry = new SubagentRegistry({ startQueued: () => pumps++ });
  running(registry, "one");
  spawn(registry, "two");
  spawn(registry, "done");
  registry.settle("done", { status: "done", output: "keep" });
  pumps = 0;
  const ui = panel(registry);
  ui.state.selectedName = ROOT_AGENT_NAME;
  ui.render();
  ui.component.handleInput("c");
  ui.component.handleInput("y");
  assert.equal(pumps, 1);
  assert.equal(registry.nodes.get("one").status, "cancelled");
  assert.equal(registry.nodes.get("two").status, "cancelled");
  assert.equal(registry.nodes.get("done").result.output, "keep");
});

test("inspector: all layouts fit tiny, narrow, wide, resized, and Unicode terminals", () => {
  const registry = new SubagentRegistry();
  running(registry, "parent", ROOT_AGENT_NAME, { prompt: "漢字 😀 é\t".repeat(80) });
  running(registry, "child", "parent");
  let height = 24;
  const ui = panel(registry, { height: () => height });
  for (const view of ["", "1", "2", "3", "?"]) {
    if (view) ui.component.handleInput(view);
    for (const h of [3, 6, 10, 24, 40]) {
      height = h;
      for (const width of [1, 4, 20, 60, 80, 110, 150]) {
        const lines = ui.component.render(width);
        assert.ok(lines.length <= height, `${width}x${height}: too tall`);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${height}: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("inspector: configured selection and expansion bindings work", () => {
  const registry = new SubagentRegistry();
  running(registry, "a");
  running(registry, "b");
  const mappings = { "tui.select.down": "J", "tui.select.up": "K", "tui.select.confirm": "O", "tui.select.cancel": "Q", "app.tools.expand": "X" };
  const ui = panel(registry, { keybindings: { matches: (data, action) => mappings[action] === data, getKeys: (action) => [mappings[action] ?? ""] } });
  ui.render();
  ui.component.handleInput("J");
  assert.equal(ui.state.selectedName, "b");
  ui.component.handleInput("O");
  ui.component.handleInput("X");
  assert.equal(ui.state.expandedTools, true);
  ui.component.handleInput("Q");
  ui.component.handleInput("Q");
  assert.equal(ui.closed(), 1);
});

test("telemetry: bounds history/text and strips hostile terminal control sequences", () => {
  const log = new ActivityLog();
  for (let i = 0; i < 500; i++) log.upsert({ id: `${i}`, kind: "tool", title: "tool", text: "a".repeat(20_000), at: i });
  assert.ok(log.entries.length <= ACTIVITY_MAX_EVENTS);
  assert.ok(log.entries.reduce((n, entry) => n + entry.text.length + entry.title.length, 0) <= ACTIVITY_MAX_CHARS);
  assert.ok(log.dropped > 0);
  assert.ok(log.entries.every((entry) => entry.truncated));
  assert.equal(plainText("hello\x1b[2J\x1b]52;c;secret\x07 world"), "hello world");
});

test("telemetry: inspector updates never invoke model-facing lifecycle hooks", () => {
  const notes = [];
  const registry = new SubagentRegistry({ onStateChange: (note) => notes.push(note) });
  running(registry, "worker");
  const before = notes.length;
  let observed = 0;
  const off = registry.subscribe(() => observed++);
  registry.recordActivity("worker", { id: "text", kind: "assistant", title: "Assistant", text: "hello", at: 0 });
  assert.equal(observed, 1);
  assert.equal(notes.length, before);
  off();
  registry.touch("worker");
  assert.equal(observed, 1);
});

test("telemetry: streaming text, concurrent tool IDs, finalized usage and seeded history", async () => {
  const registry = new SubagentRegistry();
  const node = running(registry, "worker");
  const seed = assistant("SECRET INHERITED OUTPUT", 10);
  const worker = watched(registry, node, [seed]);
  const message = assistant("live answer");
  worker.send({ type: "message_start", message });
  worker.send({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "live answer" } });
  assert.equal(node.liveOutput, "live answer");
  assert.ok(node.activity.entries.some((entry) => entry.text === "live answer"));
  for (const id of ["a", "b"]) worker.send({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `command-${id}` } });
  worker.send({ type: "tool_execution_update", toolCallId: "b", partialResult: { content: [{ type: "text", text: "output-b" }] } });
  worker.send({ type: "tool_execution_end", toolCallId: "a", result: { content: [{ type: "text", text: "output-a" }] }, isError: true });
  assert.match(currentActivity(registry, node, Date.now()), /command-b/);
  assert.doesNotMatch(currentActivity(registry, node, Date.now()), /command-a/);
  assert.equal(node.activity.entries.find((entry) => entry.id === "tool:a").state, "error");
  assert.equal(node.activity.entries.find((entry) => entry.id === "tool:b").text, "output-b");
  worker.send({ type: "message_end", message });
  worker.send({ type: "agent_end", messages: [message] });
  assert.deepEqual(node.ownUsage, { inputTokens: 4, outputTokens: 6, cost: 0.2 });
  worker.session.messages.push(message);
  await worker.finish("completed");
  assert.equal(node.result.output, "live answer");
  assert.equal(node.result.usage.cost, 0.2);
  assert.equal(worker.disposed(), 1);
  assert.doesNotMatch(JSON.stringify(node.activity.entries), /SECRET INHERITED/);
});

test("telemetry: cancellation retains partial text, usage, and ignores late updates", async () => {
  const registry = new SubagentRegistry();
  const node = running(registry, "worker");
  const worker = watched(registry, node);
  const message = assistant("partial answer");
  worker.send({ type: "message_update", message });
  registry.cancelSubtree("worker");
  worker.send({ type: "message_update", message: assistant("late overwrite") });
  await worker.finish("failed", new Error("aborted"));
  assert.equal(node.result.output, "partial answer");
  assert.equal(node.result.partialOutput, "partial answer");
  assert.equal(worker.disposed(), 1);
  assert.equal(node.handle, undefined);
});

test("manager: cancelling a merging parent cannot resurrect it or double-count usage", async () => {
  const registry = new SubagentRegistry();
  const parent = running(registry, "parent");
  running(registry, "child", "parent");
  registry.settle("parent", { status: "done", output: "own answer", usage: { cost: 0.1 } });
  const merge = registry.mergeAtSettle("parent");
  registry.cancelSubtree("parent");
  await merge;
  assert.equal(parent.status, "cancelled");
  assert.equal(parent.result.status, "cancelled");
  assert.equal(parent.result.output, "own answer");
  assert.equal(parent.result.usage.cost, 0.1);
});

test("manager: result inspection does not refresh collection LRU or extend TTL", () => {
  let now = 0;
  const store = new ResultStore(2, 50, () => now);
  store.set("one", { name: "one" });
  store.set("two", { name: "two" });
  assert.equal(store.isAvailable("one"), true);
  store.set("three", { name: "three" });
  assert.equal(store.isAvailable("one"), false);
  now = 51;
  assert.equal(store.isAvailable("two"), false);
});

test("inspector: tool output expansion and errors have readable content", () => {
  const registry = new SubagentRegistry();
  const node = running(registry, "worker");
  node.transcript = new TranscriptLog();
  node.transcript.tool({ type: "toolCall", id: "tool", name: "bash", arguments: { command: "tests" } }, true);
  node.transcript.result("tool", "bash", { content: [{ type: "text", text: "first line\nsecond line\nthird line\nfourth line\nfifth line\nsixth line\nlast line" }] }, true, false);
  const content = new InspectorContent(theme);
  const collapsed = content.render(registry, node, "activity", 80, false, 2000).join("\n");
  assert.match(collapsed, /last line/);
  assert.doesNotMatch(collapsed, /first line/);
  assert.match(content.render(registry, node, "activity", 80, true, 2000).join("\n"), /first line/);
});

test("inspector: Details discloses provider rerouting and metadata truncation", () => {
  const registry = new SubagentRegistry();
  const node = running(registry, "worker", ROOT_AGENT_NAME, {
    model: "openai-codex/gpt-5.4",
    warnings: [
      "No configured auth for openai/gpt-5.4; using openai-codex/gpt-5.4 (same model ID).",
      "model_reason was truncated to 1024 characters for storage; the task prompt is unchanged.",
    ],
  });
  const details = new InspectorContent(theme).render(registry, node, "details", 160, false, Date.now()).join("\n");
  assert.match(details, /Spawn warning: No configured auth for openai\/gpt-5\.4; using openai-codex\/gpt-5\.4/);
  assert.match(details, /Spawn warning: model_reason was truncated/);
});

test("command: direct inspection, completions, redraw cleanup, and session teardown", async () => {
  const previousRegistry = globalThis.__pi_subagents_registry__;
  const previousEngine = globalThis.__pi_subagents_engine__;
  const registry = new SubagentRegistry();
  globalThis.__pi_subagents_registry__ = registry;
  globalThis.__pi_subagents_engine__ = { registry, start() {}, pump() {}, reset() {} };
  const commands = new Map();
  const hooks = new Map();
  const notices = [];
  let component;
  let done;
  let renders = 0;
  let resolveOpened;
  const opened = new Promise((resolve) => { resolveOpened = resolve; });
  const pi = {
    on: (name, fn) => hooks.set(name, fn), registerCommand: (name, command) => commands.set(name, command),
    registerTool() {}, registerEntryRenderer() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage() {},
  };
  const ctx = { mode: "tui", hasUI: true, cwd: process.cwd(), ui: {
    setStatus() {}, notify: (text) => notices.push(text),
    custom: (factory) => new Promise((resolve) => {
      done = (value) => { component.dispose(); resolve(value); };
      component = factory({ terminal: { rows: 24 }, requestRender: () => renders++ }, theme, undefined, done);
      resolveOpened();
    }),
  } };
  try {
    subagentsExtension(pi);
    hooks.get("session_start")({}, ctx);
    running(registry, "worker");
    const command = commands.get("subagents");
    assert.ok(command.getArgumentCompletions("inspect").some((item) => item.value === "inspect worker"));
    await command.handler("inspect missing", ctx);
    assert.match(notices.at(-1), /No subagent/);
    const pending = command.handler("inspect worker", ctx);
    await opened;
    assert.match(component.render(120).join("\n"), /Conversation/);
    for (let i = 0; i < 50; i++) registry.touch("worker");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(renders, 1);
    component.handleInput(keys.esc);
    component.handleInput(keys.esc);
    await pending;
    const before = renders;
    registry.touch("worker");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(renders, before);
    assert.equal(registry.nodes.get("worker").status, "running");
    let confirmations = 0;
    ctx.ui.confirm = async () => {
      confirmations++;
      if (confirmations === 1) running(registry, "new-child", "worker");
      return confirmations === 1;
    };
    await command.handler("cancel worker", ctx);
    assert.equal(confirmations, 2);
    assert.equal(registry.nodes.get("worker").status, "running");
    assert.equal(registry.nodes.get("new-child").status, "running");
    const reopening = command.handler("inspect worker", ctx);
    hooks.get("session_shutdown")({ reason: "reload" });
    await reopening;
    assert.equal(registry.nodes.get("worker").status, "running");
  } finally {
    hooks.get("session_shutdown")?.({ reason: "quit" });
    globalThis.__pi_subagents_registry__ = previousRegistry;
    globalThis.__pi_subagents_engine__ = previousEngine;
  }
});

test("reload: registry behavior upgrades without replacing live nodes or old queues", () => {
  const previousRegistry = globalThis.__pi_subagents_registry__;
  const previousEngine = globalThis.__pi_subagents_engine__;
  try {
    const registry = new SubagentRegistry();
    const node = running(registry, "old-worker");
    const queued = spawn(registry, "old-queued");
    node.maxTurns = 1;
    queued.maxTurns = 2;
    const legacyPrototype = Object.create(SubagentRegistry.prototype);
    legacyPrototype.recordActivity = undefined;
    Object.setPrototypeOf(registry, legacyPrototype);
    let legacyPumps = 0;
    const legacy = { registry, inspectorVersion: 1, start() {}, pump() { legacyPumps++; } };
    globalThis.__pi_subagents_registry__ = registry;
    globalThis.__pi_subagents_engine__ = legacy;
    assert.equal(getSharedRegistry(), registry);
    assert.equal(Object.hasOwn(node, "maxTurns"), false);
    assert.equal(Object.hasOwn(queued, "maxTurns"), false);
    registry.recordActivity(node.name, { id: "new", kind: "state", title: "new behavior", text: "", at: 0 });
    assert.equal(registry.nodes.get(node.name), node);
    const engine = getSharedEngine();
    assert.notEqual(engine, legacy);
    assert.equal(engine.inspectorVersion, 4);
    assert.equal(getSharedEngine(), engine);
    engine.pump();
    assert.equal(legacyPumps, 1);
    assert.equal(registry.nodes.get("old-queued").status, "queued");
    const newQueued = spawn(registry, "new-queued", ROOT_AGENT_NAME, { maxTurns: 1 });
    assert.equal(Object.hasOwn(newQueued, "maxTurns"), false);
    assert.equal(registry.dequeueNext(new Set(["new-queued"])).name, "new-queued");
    assert.equal(registry.nodes.get("old-queued").status, "queued");
  } finally {
    globalThis.__pi_subagents_registry__ = previousRegistry;
    globalThis.__pi_subagents_engine__ = previousEngine;
  }
});

test("telemetry: output caps are explicit and cache/accounting excludes descendants", async () => {
  const registry = new SubagentRegistry();
  const node = running(registry, "worker");
  const worker = watched(registry, node);
  const first = assistant("a".repeat(60_000));
  worker.send({ type: "message_update", message: first });
  worker.send({ type: "message_end", message: first });
  worker.send({ type: "agent_end", messages: [first] });
  spawn(registry, "child", "worker");
  registry.settle("child", { status: "done", output: "child result", usage: { cost: 10 } });
  registry.fetchResults(["child"], "worker");
  const second = assistant("more", 0.3);
  worker.send({ type: "message_start", message: second });
  worker.send({ type: "message_end", message: second });
  worker.send({ type: "agent_end", messages: [first, second] });
  worker.session.messages.push(first, second);
  await worker.finish("completed");
  assert.equal(node.result.output.length, 50_000);
  assert.equal(node.result.outputTruncated, true);
  assert.equal(node.ownUsage.cost, 0.5);
  assert.equal(node.result.usage.cost, 10.5);
  const content = new InspectorContent(theme);
  assert.match(content.render(registry, node, "result", 80, false, Date.now()).join("\n"), /Output was capped/);
});

test("manager: merge releases queue capacity and records child delivery", async () => {
  let pumps = 0;
  const registry = new SubagentRegistry({ startQueued: () => pumps++ });
  running(registry, "parent");
  running(registry, "child", "parent");
  registry.settle("parent", { status: "done", output: "parent" });
  const merge = registry.mergeAtSettle("parent");
  assert.equal(pumps, 1);
  registry.settle("child", { status: "done", output: "child" });
  await merge;
  assert.equal(registry.nodes.get("child").delivery.kind, "merged");
  assert.equal(registry.nodes.get("child").delivery.parent, "parent");
  assert.equal(registry.nodes.get("child").result.output, "child");
});

test("manager: the synthetic main identity cannot be used as a subagent name", () => {
  assert.throws(() => spawn(new SubagentRegistry(), ROOT_AGENT_NAME), /reserved/);
});

test("telemetry: a late old-session completion cannot overwrite a reused agent name", async () => {
  const registry = new SubagentRegistry();
  const oldNode = running(registry, "worker");
  const oldWorker = watched(registry, oldNode);
  registry.teardown("new");
  const newNode = running(registry, "worker");
  oldWorker.send({ type: "message_update", message: assistant("stale output") });
  await oldWorker.finish("failed", new Error("stale failure"));
  assert.equal(newNode.status, "running");
  assert.equal(newNode.result, undefined);
  assert.equal(newNode.liveOutput, undefined);
  assert.equal(oldWorker.disposed(), 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  getMarkdownTheme, initTheme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ConversationContent, stripPromptMarkers } from "../extensions/subagents/inspector/conversation.ts";
import { InspectorContent } from "../extensions/subagents/inspector/content.ts";
import { SubagentPanel, createInspectorState } from "../extensions/subagents/inspector/panel.ts";
import { TranscriptLog, TRANSCRIPT_MAX_CHARS, TRANSCRIPT_MAX_ENTRIES } from "../extensions/subagents/transcript.ts";
import { SubagentRegistry } from "../extensions/subagents/manager.ts";
import { ROOT_AGENT_NAME } from "../extensions/subagents/constants.ts";
import { plainText } from "../extensions/subagents/activity.ts";
import { watchSession } from "../extensions/subagents/session.ts";

initTheme("dark", false);
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text,
  italic: (text) => text, strikethrough: (text) => text, underline: (text) => text };
const ui = { requestRender() {} };
const cwd = "/tmp/pi-native-conversation";
function assistant(text, extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.4",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
    stopReason: "stop", timestamp: 1000, ...extra };
}
function worker() {
  const registry = new SubagentRegistry();
  const node = registry.register({ name: "worker", parentName: ROOT_AGENT_NAME, cwd,
    prompt: "Check **token refresh**.\n\n1. Read the code.\n2. Run the tests.", contextMode: "none", onParentError: "adopt" });
  registry.markRunning(node.name, { async abort() {}, dispose() {} });
  node.transcript = new TranscriptLog();
  return { registry, node, log: node.transcript };
}
const normalize = (lines, width) => lines.map((line) => truncateToWidth(stripPromptMarkers(line), width));
const factories = { read: createReadToolDefinition, bash: createBashToolDefinition, edit: createEditToolDefinition, write: createWriteToolDefinition };

for (const themeName of ["dark", "light"]) test(`conversation: byte-for-byte native message and tool styling (${themeName})`, () => {
  initTheme(themeName, false);
  try {
    const { node, log } = worker();
    log.user("task", node.prompt);
    const answer = assistant("I'll check the implementation.\n\n```ts\nconst refreshed = await refresh();\n```\n\n**Result:** token refresh works.");
    log.assistant("reply", answer, false);
    const tools = [
      { name: "bash", arguments: { command: "pnpm test" }, result: { content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `test ${i} passed`).join("\n") }] } },
      { name: "read", arguments: { path: "src/auth.ts", offset: 10, limit: 20 }, result: { content: [{ type: "text", text: "export const refreshed = true;" }] } },
      { name: "write", arguments: { path: "src/result.ts", content: "export const ok = true;" }, result: { content: [{ type: "text", text: "Successfully wrote file." }] } },
      { name: "edit", arguments: { path: "file-that-does-not-exist.ts", edits: [{ oldText: "false", newText: "true" }] }, result: { content: [{ type: "text", text: "Successfully replaced 1 block." }], details: { diff: "-1 const ok = false;\n+1 const ok = true;", firstChangedLine: 1 } } },
      { name: "collect_subagents", arguments: { names: ["tests"] }, result: { content: [{ type: "text", text: "tests: done\nAll checks passed." }] } },
    ];
    for (const tool of tools) {
      log.tool({ type: "toolCall", id: tool.name, name: tool.name, arguments: tool.arguments }, true);
      log.result(tool.name, tool.name, tool.result, false, false);
    }
    for (const outputPad of [0, 1]) for (const expanded of [false, true]) for (const width of [48, 80, 120]) {
      const markdownTheme = { ...getMarkdownTheme(), codeBlockIndent: "    " };
      const expected = [
        ...new UserMessageComponent(node.prompt, markdownTheme, outputPad).render(width),
        ...new AssistantMessageComponent(answer, true, markdownTheme, undefined, outputPad).render(width),
      ];
      for (const tool of tools) {
        const definition = factories[tool.name]?.(cwd);
        const component = new ToolExecutionComponent(tool.name, tool.name, tool.arguments, { showImages: false }, definition, ui, cwd);
        // This is Pi's historical session rendering sequence, without execution.
        component.updateResult({ ...tool.result, isError: false });
        component.setExpanded(expanded);
        expected.push(...component.render(width));
      }
      const content = new ConversationContent(theme, { cwd, outputPad, codeBlockIndent: "    " });
      assert.deepEqual(content.render(node, width, expanded), normalize(expected, width), `${outputPad}/${expanded}/${width}`);
    }
  } finally { initTheme("dark", false); }
});

test("conversation: streaming tools, errors, and final output use native state colors", () => {
  const { node, log } = worker();
  const args = { command: "pnpm test" };
  log.tool({ type: "toolCall", id: "call", name: "bash", arguments: args }, true);
  const content = new ConversationContent(theme);
  const expected = new ToolExecutionComponent("bash", "call", args, { showImages: false }, createBashToolDefinition(cwd), ui, cwd);
  assert.deepEqual(content.render(node, 80, false), normalize(expected.render(80), 80));
  const output = { content: [{ type: "text", text: "running tests" }] };
  log.result("call", "bash", output, false, true);
  expected.updateResult({ ...output, isError: false }, true);
  assert.deepEqual(content.render(node, 80, false), normalize(expected.render(80), 80));
  log.result("call", "bash", output, true, false);
  expected.updateResult({ ...output, isError: true }, false);
  assert.deepEqual(content.render(node, 80, false), normalize(expected.render(80), 80));
  assert.equal(log.entries.length, 1);
});

test("conversation: rendering cannot start execution timers or recompute edit previews", async () => {
  const { node, log } = worker();
  log.tool({ type: "toolCall", id: "shell", name: "bash", arguments: { command: "must never execute" } }, true);
  log.result("shell", "bash", { content: [{ type: "text", text: "streaming" }] }, false, true);
  log.tool({ type: "toolCall", id: "edit", name: "edit", arguments: { path: "missing-file", edits: [{ oldText: "before", newText: "after" }] } }, true);
  log.result("edit", "edit", { content: [], details: { diff: "-1 before\n+1 after", firstChangedLine: 1 } }, false, false);
  const previousTimer = globalThis.setInterval;
  const previousComplete = ToolExecutionComponent.prototype.setArgsComplete;
  const previousStart = ToolExecutionComponent.prototype.markExecutionStarted;
  const forbid = () => { throw new Error("Inspection must not initiate execution-time effects"); };
  globalThis.setInterval = forbid;
  ToolExecutionComponent.prototype.setArgsComplete = forbid;
  ToolExecutionComponent.prototype.markExecutionStarted = forbid;
  try {
    const content = new ConversationContent(theme);
    const first = content.render(node, 100, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    content.invalidate();
    assert.deepEqual(content.render(node, 100, false), first);
    assert.match(plainText(first.join("\n")), /after/);
    assert.doesNotMatch(plainText(first.join("\n")), /ENOENT|Could not read/);
  } finally {
    globalThis.setInterval = previousTimer;
    ToolExecutionComponent.prototype.setArgsComplete = previousComplete;
    ToolExecutionComponent.prototype.markExecutionStarted = previousStart;
  }
});

test("transcript: watcher correlates streaming messages and tools without duplicating task or replies", async () => {
  const { registry, node, log } = worker();
  const seed = assistant("SECRET INHERITED HISTORY");
  let listener;
  const session = { messages: [seed], subscribe(fn) { listener = fn; return () => { listener = undefined; }; }, async abort() {}, dispose() {} };
  const finish = watchSession(registry, node, session);
  const send = (event) => listener?.(event);
  send({ type: "message_start", message: { role: "user", content: node.prompt } });
  send({ type: "message_end", message: { role: "user", content: node.prompt } });
  send({ type: "message_update", message: seed });
  send({ type: "message_start", message: assistant("") });
  const call = { type: "toolCall", id: "call", name: "bash", arguments: { command: "pnpm test" }, thoughtSignature: "SECRET SIGNATURE" };
  const message = assistant("", { stopReason: "toolUse", diagnostics: [{ text: "SECRET DIAGNOSTIC" }], content: [
    { type: "thinking", thinking: "SECRET PRIVATE REASONING" }, { type: "text", text: "Checking tests." }, call,
  ] });
  send({ type: "message_update", message });
  send({ type: "message_end", message });
  send({ type: "message_end", message });
  assert.deepEqual(log.entries.map((entry) => entry.kind), ["user", "assistant", "tool"]);
  assert.equal(log.entries[1].streaming, false);
  send({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: call.arguments });
  const result = { content: [{ type: "text", text: "test one passed" }], details: { fullOutputPath: "/tmp/result" } };
  send({ type: "tool_execution_update", toolCallId: "call", toolName: "bash", partialResult: result });
  result.content[0].text = "all tests passed";
  assert.equal(log.entries[2].result.content[0].text, "test one passed");
  call.arguments.command = "changed outside the log";
  assert.equal(log.entries[2].call.arguments.command, "pnpm test");
  send({ type: "tool_execution_end", toolCallId: "call", toolName: "bash", result, isError: false });
  send({ type: "message_start", message: assistant("") });
  const final = assistant("Done.");
  send({ type: "message_end", message: final });
  session.messages.push(message, final);
  await finish("completed");
  assert.deepEqual(log.entries.map((entry) => entry.kind), ["user", "assistant", "tool", "assistant"]);
  assert.equal(log.entries[2].complete, true);
  assert.equal(log.entries[2].result.content[0].text, "all tests passed");
  assert.doesNotMatch(JSON.stringify(log.entries), /SECRET/);
  assert.equal(node.ownUsage.cost, 0.6);
  registry.fetchResults([node.name]);
  registry.store.clear();
  assert.equal(node.transcript, log);
  assert.equal(log.entries.at(-1).message.content[0].text, "Done.");
});

test("transcript: cancellation freezes partial output and ignores stale SDK updates", async () => {
  const { registry, node, log } = worker();
  let listener;
  const session = { messages: [], subscribe(fn) { listener = fn; return () => { listener = undefined; }; }, async abort() {}, dispose() {} };
  const finish = watchSession(registry, node, session);
  listener({ type: "message_update", message: assistant("partial answer") });
  listener({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "sleep 100" } });
  listener({ type: "tool_execution_update", toolCallId: "call", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial stdout" }] } });
  registry.cancelSubtree(node.name);
  const before = JSON.stringify(log.entries);
  listener({ type: "message_update", message: assistant("late answer") });
  assert.equal(JSON.stringify(log.entries), before);
  assert.equal(log.entries[1].streaming, false);
  assert.equal(log.entries[1].message.stopReason, "aborted");
  assert.equal(log.entries[2].complete, true);
  assert.match(log.entries[2].result.content[0].text, /partial stdout/);
  assert.equal(log.entries[2].result.isError, true);
  await finish("failed", new Error("aborted"));
});

test("transcript: snapshots bound huge/cyclic payloads and exclude image bytes", () => {
  const { node, log } = worker();
  const args = { path: "src/file.ts", content: "😀漢字".repeat(100_000) };
  args.self = args;
  log.tool({ type: "toolCall", id: "large", name: "write", arguments: args });
  log.result("large", "write", { content: [{ type: "image", data: "SECRET_IMAGE".repeat(10_000), mimeType: "image/png" }], details: { diff: "big diff\n".repeat(100_000) } }, false, false);
  assert.equal(log.entries[0].truncated, true);
  const serialized = JSON.stringify(log.entries);
  assert.ok(serialized.length < TRANSCRIPT_MAX_CHARS);
  assert.doesNotMatch(serialized, /SECRET_IMAGE/);
  assert.equal(Buffer.from(log.entries[0].call.arguments.content).toString("utf8"), log.entries[0].call.arguments.content);
  assert.match(log.entries[0].result.content[0].text, /Image.*omitted/);
  assert.match(plainText(new ConversationContent(theme).render(node, 80, false).join("\n")), /inspection copy was truncated/);
});

test("transcript: eviction and reader caches remain bounded", () => {
  const { node, log } = worker();
  const content = new ConversationContent(theme);
  for (let i = 0; i < 400; i++) {
    log.assistant(`reply:${i}`, assistant(`reply ${i}: ${"line\n".repeat(1000)}`), false);
    if (i % 50 === 0) content.render(node, 80, false);
  }
  content.render(node, 80, false);
  assert.ok(log.entries.length <= TRANSCRIPT_MAX_ENTRIES);
  assert.ok(JSON.stringify(log.entries).length <= TRANSCRIPT_MAX_CHARS);
  assert.ok(log.dropped > 0);
  assert.equal(log.sizes.size, log.entries.length);
  assert.ok(content.components.size <= log.entries.length);
  assert.match(plainText(content.render(node, 80, false).join("\n")), /earlier conversation entries discarded/);
});

test("conversation: resize, invalidation, terminal controls, and node replacement are safe", () => {
  const { registry, node, log } = worker();
  log.user("task", "漢字 😀 é\t".repeat(20));
  log.assistant("reply", assistant("hello\x1b]52;c;SECRET_CLIPBOARD\x07\x1b[2J\n```ts\nconst x = '漢字';\n```"), true);
  const content = new InspectorContent(theme);
  for (const width of [1, 2, 4, 10, 40, 120]) {
    const lines = content.render(registry, node, "activity", width, false, 1000);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /133;|52;c;|\x1b\[2J|SECRET_CLIPBOARD/);
  }
  const first = content.render(registry, node, "activity", 80, false, 1000);
  content.invalidate();
  assert.deepEqual(content.render(registry, node, "activity", 80, false, 1000), first);
  const replacement = { ...node, transcript: new TranscriptLog() };
  replacement.transcript.user("task", "New session task");
  replacement.transcript.assistant("replacement", assistant("NEW SESSION"), false);
  assert.match(plainText(content.render(registry, replacement, "activity", 80, false, 1000).join("\n")), /NEW SESSION/);
});

test("conversation: native scroll bindings, wheel input, and duplicate-line anchors", () => {
  const { registry, node, log } = worker();
  for (let i = 0; i < 50; i++) log.assistant(`${i}`, assistant("repeated line"), false);
  const bindings = { "tui.altScreen.top": ["a"], "tui.altScreen.bottom": ["z"], "tui.altScreen.halfPageUp": ["k"] };
  const keybindings = { matches: (data, key) => (bindings[key] ?? []).includes(data), getKeys: (key) => bindings[key] ?? [] };
  const state = createInspectorState();
  const panel = new SubagentPanel(registry, theme, () => {}, () => {}, { state, inspect: node.name, keybindings, height: () => 24 });
  panel.render(80);
  const scroll = state.scroll.get("worker:activity");
  const bottom = scroll.offset;
  panel.handleInput("k");
  assert.equal(scroll.offset, bottom - Math.floor(panel.pageHeight / 2)); // not half-page plus the k alias
  panel.render(80);
  const paused = scroll.offset;
  panel.handleInput("\x1b[5~"); // unbound native page-up must not fall back to picker bindings
  assert.equal(scroll.offset, paused);
  panel.handleInput("a");
  panel.render(80);
  assert.equal(scroll.offset, 0);
  assert.deepEqual(panel.handleMouse({ type: "wheel", wheelDelta: 6 }), { handled: true });
  panel.render(80);
  assert.equal(scroll.offset, 6);
  log.assistant("new", assistant("new output"), false);
  panel.render(80);
  assert.equal(scroll.offset, 6); // do not jump to the first identical blank/native text line
  assert.equal(scroll.follow, false);
  panel.handleInput("z");
  panel.render(80);
  assert.equal(scroll.follow, true);
  assert.match(plainText(panel.render(80).join("\n")), /new output/);
});

test("conversation: completed agents open chat, not an activity table or only the result", () => {
  const { registry, node, log } = worker();
  log.user("task", "Original task");
  log.assistant("reply", assistant("Final answer"), false);
  registry.settle(node.name, { status: "done", output: "Final answer" });
  const state = createInspectorState();
  const panel = new SubagentPanel(registry, theme, () => {}, () => {}, { state, inspect: node.name, height: () => 24 });
  const rendered = plainText(panel.render(120).join("\n"));
  assert.equal(state.view, "activity"); // retained internal view ID; user-facing label is Conversation
  assert.match(rendered, /Conversation/);
  assert.match(rendered, /Original task/);
  assert.match(rendered, /Final answer/);
  assert.match(rendered, /Read-only/);
  assert.doesNotMatch(rendered, /╭|╰|Activity ·|Configuration & diagnostics|00:00:/);
  assert.equal(registry.store.isAvailable(node.name), true);
});

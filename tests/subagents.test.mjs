import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadRoutingConfig,
  mergeConfigs,
  parseSubagentsConfig,
  routingConfigPaths,
} from "../extensions/subagents/config.ts";
import {
  buildRoutingBlock,
  resolveModelRef,
  resolveSpawnRouting,
  SPAWN_TOOL_GUIDELINES,
} from "../extensions/subagents/routing.ts";
import {
  buildSeedEntries,
  findTrimIndex,
  toSeedEntries,
} from "../extensions/subagents/context.ts";
import { MAX_CONTEXT_TURNS, NAME_REGEX } from "../extensions/subagents/constants.ts";

// ── helpers ────────────────────────────────────────────────────────────────

async function makeTempDirs() {
  const base = await mkdtemp(join(tmpdir(), "subagents-test-"));
  return {
    base,
    agentDir: join(base, "agent"),
    cwd: join(base, "project"),
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function writeConfig(root, kind, content) {
  const dir = kind === "user" ? root.agentDir : join(root.cwd, ".pi");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "subagents.json"), content, "utf8");
}

function fakeRegistry(models, authed = []) {
  const authSet = new Set(authed);
  return {
    getAll() {
      return models;
    },
    hasConfiguredAuth(model) {
      return authSet.has(`${model.provider}/${model.id}`);
    },
  };
}

const MODELS = [
  { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus" },
  { provider: "anthropic", id: "claude-haiku-4-8", name: "Claude Haiku" },
  { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
  { provider: "openai", id: "gpt-5.5-mini", name: "GPT-5.5 Mini" },
  { provider: "google", id: "gemini-3.1-pro", name: "Gemini Pro" },
  { provider: "groq", id: "gpt-5.5", name: "GPT-5.5 (groq mirror)" },
  { provider: "groq", id: "gpt-5.5-mirror", name: "GPT-5.5 Mirror" },
];

function msg(id, role, content, parentId) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content, timestamp: Date.parse("2026-01-01T00:00:00.000Z") },
  };
}

function user(id, parentId, content = "hello") {
  return msg(id, "user", content, parentId);
}

function assistant(id, parentId, content = "hi") {
  return msg(id, "assistant", content, parentId);
}

function toolResult(id, parentId) {
  return msg(id, "toolResult", [{ type: "text", text: "output" }], parentId);
}

function customMessage(id, parentId, content = "note") {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "subagent_state_change",
    content,
    display: true,
  };
}

function compaction(id, parentId, summary = "earlier stuff happened") {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary,
    firstKeptEntryId: "k1",
    tokensBefore: 1000,
  };
}

function branchSummary(id, parentId) {
  return { type: "branch_summary", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", fromId: "x", summary: "s" };
}

// ── config.ts ──────────────────────────────────────────────────────────────

test("config: no files -> null config, no errors", async () => {
  const root = await makeTempDirs();
  try {
    await mkdir(root.agentDir, { recursive: true });
    await mkdir(root.cwd, { recursive: true });
    const loaded = loadRoutingConfig(root.agentDir, root.cwd);
    assert.equal(loaded.config, null);
    assert.deepEqual(loaded.fileErrors, []);
    assert.equal(loaded.userPath, join(root.agentDir, "subagents.json"));
    assert.equal(loaded.projectPath, join(root.cwd, ".pi", "subagents.json"));
  } finally {
    await root.cleanup();
  }
});

test("config: user-only and project-only files load", async () => {
  const root = await makeTempDirs();
  try {
    await writeConfig(root, "user", JSON.stringify({
      defaultModel: "claude-opus-4-8",
      defaultThinking: "low",
      rules: [{ name: "r1", description: "d", model: "claude-haiku-4-8" }],
    }));
    let loaded = loadRoutingConfig(root.agentDir, root.cwd);
    assert.equal(loaded.config.rules.length, 1);
    assert.equal(loaded.config.defaultModel, "claude-opus-4-8");

    await rm(join(root.agentDir, "subagents.json"));
    await writeConfig(root, "project", JSON.stringify({
      rules: [{ name: "p1", description: "d", model: "gpt-5.5", thinking: "high" }],
    }));
    loaded = loadRoutingConfig(root.agentDir, root.cwd);
    assert.equal(loaded.config.rules.length, 1);
    assert.equal(loaded.config.rules[0].thinking, "high");
    assert.equal(loaded.config.defaultModel, undefined);
  } finally {
    await root.cleanup();
  }
});

test("config: merge by rule name, project overrides, defaults precedence", async () => {
  const user = {
    defaultModel: "a",
    defaultThinking: "low",
    rules: [
      { name: "shared", description: "user", model: "user-model" },
      { name: "user-only", description: "u", model: "u-model" },
    ],
  };
  const project = {
    defaultModel: "b",
    rules: [
      { name: "shared", description: "project", model: "project-model", thinking: "high" },
      { name: "project-only", description: "p", model: "p-model" },
    ],
  };
  const merged = mergeConfigs(user, project);
  assert.equal(merged.defaultModel, "b");
  assert.equal(merged.defaultThinking, "low"); // project unset -> user wins
  assert.deepEqual(
    merged.rules.map((r) => [r.name, r.model]),
    [
      ["shared", "project-model"],
      ["user-only", "u-model"],
      ["project-only", "p-model"],
    ],
  );
});

test("config: file-level errors block spawns but keep the valid file merged", async () => {
  const root = await makeTempDirs();
  try {
    await writeConfig(root, "user", JSON.stringify({
      rules: [{ name: "ok", description: "d", model: "m" }],
    }));
    await writeConfig(root, "project", "{ not json");
    const loaded = loadRoutingConfig(root.agentDir, root.cwd);
    assert.equal(loaded.fileErrors.length, 1);
    assert.match(loaded.fileErrors[0].error, /Invalid JSON/);
    assert.equal(loaded.fileErrors[0].path, loaded.projectPath);
    // Valid file still merged for /subagents config diagnostics.
    assert.equal(loaded.config.rules.length, 1);
    assert.equal(loaded.config.rules[0].name, "ok");
  } finally {
    await root.cleanup();
  }
});

test("config: duplicate rule names within a file are a file-level error", () => {
  const result = parseSubagentsConfig(
    JSON.stringify({ rules: [
      { name: "dup", description: "a", model: "m" },
      { name: "dup", description: "b", model: "m" },
    ] }),
    "test.json",
  );
  assert.ok(result.error);
  assert.match(result.error, /duplicate rule name "dup"/);
});

test("config: more than MAX_RULES rules is a file-level error", () => {
  const rules = Array.from({ length: 21 }, (_, i) => ({ name: `r${i}`, description: "d", model: "m" }));
  const result = parseSubagentsConfig(JSON.stringify({ rules }), "test.json");
  assert.ok(result.error);
  assert.match(result.error, /more than 20 rules/);
});

test("config: over-long description and bad thinking are file-level errors", () => {
  const long = parseSubagentsConfig(
    JSON.stringify({ rules: [{ name: "r", description: "x".repeat(201), model: "m" }] }),
    "test.json",
  );
  assert.match(long.error, /description.*200/);

  const badRuleThinking = parseSubagentsConfig(
    JSON.stringify({ rules: [{ name: "r", description: "d", model: "m", thinking: "ultra" }] }),
    "test.json",
  );
  assert.match(badRuleThinking.error, /thinking/);

  const badDefaultThinking = parseSubagentsConfig(
    JSON.stringify({ defaultThinking: "turbo" }),
    "test.json",
  );
  assert.match(badDefaultThinking.error, /defaultThinking/);
});

test("config: bad shapes are file-level errors", () => {
  assert.match(parseSubagentsConfig("[]", "t").error, /object/);
  assert.match(parseSubagentsConfig(JSON.stringify({ rules: "no" }), "t").error, /rules.*array/);
  assert.match(
    parseSubagentsConfig(JSON.stringify({ rules: [{ name: "r", description: "d" }] }), "t").error,
    /model/,
  );
  assert.match(
    parseSubagentsConfig(JSON.stringify({ rules: [{ name: "", description: "d", model: "m" }] }), "t").error,
    /name/,
  );
  // Empty rules array is fine.
  assert.deepEqual(parseSubagentsConfig(JSON.stringify({ rules: [] }), "t").config.rules, []);
});

test("config: unreadable file becomes a file error, not a throw", async () => {
  const root = await makeTempDirs();
  try {
    // A directory where the file should be makes readFileSync fail (EISDIR).
    await mkdir(join(root.cwd, ".pi", "subagents.json"), { recursive: true });
    const loaded = loadRoutingConfig(root.agentDir, root.cwd);
    assert.equal(loaded.fileErrors.length, 1);
    assert.match(loaded.fileErrors[0].error, /Could not read/);
  } finally {
    await root.cleanup();
  }
});

test("config: paths use the project config dir name", () => {
  const paths = routingConfigPaths("/agent", "/cwd");
  assert.equal(paths.userPath, "/agent/subagents.json");
  assert.equal(paths.projectPath, "/cwd/.pi/subagents.json");
});

// ── routing.ts ─────────────────────────────────────────────────────────────

test("routing: bare exact id resolves when unique", () => {
  const resolved = resolveModelRef("gemini-3.1-pro", fakeRegistry(MODELS, ["google/gemini-3.1-pro"]));
  assert.equal(resolved.model.provider, "google");
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.warning, undefined);
});

test("routing: bare exact id ambiguous across providers errors with candidates", () => {
  // "gpt-5.5" exists on openai and groq.
  const resolved = resolveModelRef("gpt-5.5", fakeRegistry(MODELS));
  assert.ok(resolved.error);
  assert.match(resolved.error, /multiple providers/);
  assert.ok(resolved.candidates.includes("openai/gpt-5.5"));
  assert.ok(resolved.candidates.includes("groq/gpt-5.5"));
});

test("routing: unique prefix match resolves", () => {
  const resolved = resolveModelRef("gemini", fakeRegistry(MODELS));
  assert.equal(resolved.model?.id, "gemini-3.1-pro");
});

test("routing: ambiguous prefix resolves to the single auth-configured candidate", () => {
  // "gpt-5.5-m" prefix-matches openai/gpt-5.5-mini and groq/gpt-5.5-mirror.
  const none = resolveModelRef("gpt-5.5-m", fakeRegistry(MODELS));
  assert.match(none.error, /ambiguous/);

  const openaiWins = resolveModelRef("gpt-5.5-m", fakeRegistry(MODELS, ["openai/gpt-5.5-mini"]));
  assert.equal(openaiWins.model?.id, "gpt-5.5-mini");
  assert.equal(openaiWins.error, undefined);

  // Auth beats registry order: the groq mirror wins although openai sorts first.
  const groqWins = resolveModelRef("gpt-5.5-m", fakeRegistry(MODELS, ["groq/gpt-5.5-mirror"]));
  assert.equal(groqWins.model?.id, "gpt-5.5-mirror");
});

test("routing: providers without auth list last among candidates", () => {
  // Exact "gpt-5.5" is ambiguous (openai + groq); auth-configured provider lists first.
  const registry = fakeRegistry(MODELS, ["groq/gpt-5.5"]);
  const ambiguous = resolveModelRef("gpt-5.5", registry);
  assert.ok(ambiguous.error);
  assert.equal(ambiguous.candidates[0], "groq/gpt-5.5");
});

test("routing: ambiguous prefix with no auth winner errors listing candidates", () => {
  const models = [
    { provider: "a", id: "model-x-1" },
    { provider: "b", id: "model-x-2" },
  ];
  const resolved = resolveModelRef("model-x", fakeRegistry(models));
  assert.match(resolved.error, /ambiguous/);
  assert.deepEqual(resolved.candidates, ["a/model-x-1", "b/model-x-2"]);
});

test("routing: slash reference resolves and unknown ones error with candidates", () => {
  const resolved = resolveModelRef("openai/gpt-5.5", fakeRegistry(MODELS));
  assert.equal(resolved.model?.provider, "openai");

  const missing = resolveModelRef("openai/nope", fakeRegistry(MODELS));
  assert.match(missing.error, /No model matches/);
});

test("routing: unresolved auth on the chosen model is a warning only", () => {
  const resolved = resolveModelRef("gemini-3.1-pro", fakeRegistry(MODELS)); // no auth configured
  assert.equal(resolved.model?.id, "gemini-3.1-pro");
  assert.match(resolved.warning, /No configured auth/);
});

test("routing: empty reference errors", () => {
  assert.match(resolveModelRef("   ", fakeRegistry(MODELS)).error, /Empty/);
});

test("routing: spawn chain — explicit model wins", () => {
  const parent = { model: MODELS[0], thinking: "medium" };
  const resolved = resolveSpawnRouting(
    { model: "gpt-5.5-mini", thinking: "high" },
    { defaultModel: "gemini-3.1-pro", defaultThinking: "low", rules: [] },
    fakeRegistry(MODELS, ["openai/gpt-5.5-mini"]),
    parent,
  );
  assert.equal(resolved.model.id, "gpt-5.5-mini");
  assert.equal(resolved.modelSource, "explicit");
  assert.equal(resolved.thinking, "high");
  assert.equal(resolved.thinkingSource, "explicit");
  assert.deepEqual(resolved.warnings, []);
  assert.equal(resolved.error, undefined);
});

test("routing: spawn chain — unresolvable explicit model is a hard error with candidates", () => {
  const parent = { model: MODELS[0], thinking: "medium" };
  const resolved = resolveSpawnRouting(
    { model: "gpt-5.5", thinking: "high" },
    null,
    fakeRegistry([]),
    parent,
  );
  assert.ok(resolved.error);
  assert.match(resolved.error, /model "gpt-5.5"/);
  // Error payload still reports what the spawn would fall back to.
  assert.equal(resolved.modelSource, "inherited");
});

test("routing: spawn chain — config default applies after explicit, before inherit", () => {
  const parent = { model: MODELS[0], thinking: "medium" };
  const config = { defaultModel: "gpt-5.5-mini", defaultThinking: "low", rules: [] };

  const byDefault = resolveSpawnRouting({}, config, fakeRegistry(MODELS), parent);
  assert.equal(byDefault.model.id, "gpt-5.5-mini");
  assert.equal(byDefault.modelSource, "config-default");
  assert.equal(byDefault.thinking, "low");
  assert.equal(byDefault.thinkingSource, "config-default");

  const inherited = resolveSpawnRouting({}, null, fakeRegistry(MODELS), parent);
  assert.equal(inherited.model.id, "claude-opus-4-8");
  assert.equal(inherited.modelSource, "inherited");
  assert.equal(inherited.thinking, "medium");
  assert.equal(inherited.thinkingSource, "inherited");
});

test("routing: spawn chain — unresolvable defaultModel warns and inherits", () => {
  const parent = { model: MODELS[0], thinking: "medium" };
  const resolved = resolveSpawnRouting(
    {},
    { defaultModel: "does-not-exist", rules: [] },
    fakeRegistry(MODELS),
    parent,
  );
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.modelSource, "inherited");
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /does-not-exist/);
});

test("routing: guidance block lists rules with truncated snippets", () => {
  const config = {
    rules: [
      { name: "reading files", description: "read, grep, search, and summarize code or docs; recon; quick lookups", model: "gemini-3.1-pro", thinking: "low" },
      { name: "broken", description: "d", model: "missing-model" },
    ],
  };
  const result = buildRoutingBlock(config, fakeRegistry(MODELS), {
    userPath: "/agent/subagents.json",
    projectPath: "/cwd/.pi/subagents.json",
  });
  assert.match(result.block, /- reading files → google\/gemini-3.1-pro \(thinking: low\)/);
  // ~60-char snippet truncation with ellipsis.
  assert.match(result.block, /— read, grep, search, and summarize code or docs; recon; quic…/);
  assert.match(result.block, /- broken → \(unavailable/);
  assert.deepEqual(result.disabledRules, [{ name: "broken", reason: 'No model matches "missing-model"' }]);
  assert.match(result.block, /model_reason/);
});

test("routing: guidance block default handling and empty config", () => {
  const withDefault = buildRoutingBlock(
    { defaultModel: "no-such-model", rules: [] },
    fakeRegistry(MODELS),
    { userPath: "u", projectPath: "p" },
  );
  assert.match(withDefault.block, /inherited/);
  assert.match(withDefault.defaultWarning ?? "", /no-such-model/);

  const empty = buildRoutingBlock(null, fakeRegistry(MODELS), { userPath: "u", projectPath: "p" });
  assert.equal(empty.block, "");

  assert.equal(SPAWN_TOOL_GUIDELINES.length, 1);
  assert.match(SPAWN_TOOL_GUIDELINES[0], /spawn_subagents/);
});

// ── context.ts ─────────────────────────────────────────────────────────────

test("context: trim rule excludes the current run", () => {
  // [u1, a1] = settled history; u2 = trigger; a2 = in-flight spawn call.
  const entries = [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2")];
  assert.equal(findTrimIndex(entries), 2);

  const result = buildSeedEntries({ mode: "all", entries });
  // Seed = everything strictly before the trigger user entry.
  assert.deepEqual(
    result.entries.map((e) => e.message.role),
    ["user", "assistant"],
  );
  assert.equal(result.trimmedEntries, 2);
  assert.equal(result.includedTurns, 1);
});

test("context: trim when the in-flight assistant has not landed yet", () => {
  const entries = [user("u1", null), assistant("a1", "u1"), user("u2", "a1")];
  assert.equal(findTrimIndex(entries), 2);
  const result = buildSeedEntries({ mode: "all", entries });
  assert.equal(result.entries.length, 2);
});

test("context: first-turn spawn seeds nothing; no user entries seeds nothing", () => {
  assert.equal(findTrimIndex([user("u1", null), assistant("a1", "u1")]), 0);
  assert.equal(findTrimIndex([assistant("a1", null)]), 0);
});

test("context: rebuilt seeds have a linear parent chain after orphan tool results are dropped", () => {
  const seeds = toSeedEntries([toolResult("t1", null), user("u1", null), assistant("a1", "u1")]);
  assert.deepEqual(seeds.map((entry) => [entry.id, entry.parentId]), [
    ["sa-seed-0", null],
    ["sa-seed-1", "sa-seed-0"],
  ]);
});

test("context: toolResults and custom messages in settled history are kept", () => {
  const entries = [
    user("u1", null),
    assistant("a1", "u1"),
    toolResult("t1", "a1"),
    customMessage("cm1", "t1"),
    assistant("a2", "cm1"),
    user("u2", "a2"),
    assistant("a3", "u2"),
  ];
  const result = buildSeedEntries({ mode: "all", entries });
  assert.deepEqual(
    result.entries.map((e) => (e.type === "message" ? e.message.role : e.type)),
    ["user", "assistant", "toolResult", "custom_message", "assistant"],
  );
});

test("context: last_n_turns slices from the Nth-last user entry inclusive", () => {
  const entries = [
    user("u1", null),
    assistant("a1", "u1"),
    user("u2", "a1"),
    assistant("a2", "u2"),
    toolResult("t2", "a2"),
    user("u3", "t2"),
    assistant("a3", "u3"),
    user("u4", "a3"), // trigger
    assistant("a4", "u4"),
  ];

  const two = buildSeedEntries({ mode: "last_n_turns", contextTurns: 2, entries });
  const toolOutput = [{ type: "text", text: "output" }];
  assert.deepEqual(
    two.entries.map((e) => e.message.content),
    ["hello", "hi", toolOutput, "hello", "hi"],
  );
  assert.equal(two.includedTurns, 2);

  const one = buildSeedEntries({ mode: "last_n_turns", contextTurns: 1, entries });
  assert.deepEqual(
    one.entries.map((e) => e.message.content),
    ["hello", "hi"],
  );

  // More turns requested than exist -> everything up to the trim point.
  const all = buildSeedEntries({ mode: "last_n_turns", contextTurns: 30, entries });
  assert.equal(all.entries.length, 7);
});

test("context: compaction entries count as one user turn and map to summary text", () => {
  const entries = [
    compaction("c1", null),
    user("k1", "c1"),
    assistant("k2", "k1"),
    user("u2", "k2"),
    assistant("a3", "u2"), // in-flight
  ];
  // Trim point is u2; compaction is one user turn, k-user is another.
  const one = buildSeedEntries({ mode: "last_n_turns", contextTurns: 1, entries });
  // Only the k1 turn fits within the trim window (compaction + k1 + k2).
  assert.deepEqual(
    one.entries.map((e) => e.message.content),
    ["hello", "hi"],
  );

  const two = buildSeedEntries({ mode: "last_n_turns", contextTurns: 2, entries });
  const first = two.entries[0];
  assert.equal(first.type, "message");
  assert.equal(first.message.role, "user");
  assert.match(first.message.content, /Summary of earlier conversation/);
  assert.match(first.message.content, /earlier stuff happened/);
});

test("context: compaction in all mode becomes a user summary; branch summaries drop", () => {
  const entries = [
    compaction("c1", null),
    branchSummary("bs1", "c1"),
    user("k1", "bs1"),
    assistant("k2", "k1"),
    user("u2", "k2"),
    assistant("a3", "u2"),
  ];
  const result = buildSeedEntries({ mode: "all", entries });
  assert.deepEqual(
    result.entries.map((e) => (e.type === "message" ? e.message.role : e.type)),
    ["user", "user", "assistant"],
  );
  assert.match(result.entries[0].message.content, /Summary of earlier conversation/);
});

test("context: ids are rebuilt as a fresh linear parent chain", () => {
  const entries = [
    user("u1", "something-not-in-list"),
    assistant("a1", "u1"),
    user("u2", "a1"),
    assistant("a2", "u2"),
  ];
  const seeds = toSeedEntries(entries.slice(0, 2));
  assert.equal(seeds[0].parentId, null);
  assert.equal(seeds[1].parentId, seeds[0].id);
  assert.notEqual(seeds[0].id, "u1");
  assert.deepEqual(
    seeds.map((e) => e.id),
    ["sa-seed-0", "sa-seed-1"],
  );
});

test("context: image parts are stripped from seed messages", () => {
  const entries = [
    msg("u1", "user", [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
    ], null),
    assistant("a1", "u1"),
    user("u2", "a1"),
    assistant("a2", "u2"),
  ];
  const result = buildSeedEntries({ mode: "all", entries });
  const seededUser = result.entries[0];
  assert.deepEqual(seededUser.message.content, [{ type: "text", text: "look" }]);
});

test("context: leading orphan toolResults are dropped", () => {
  // Compaction-kept slice starting at a toolResult whose assistant was compacted away.
  const slice = [toolResult("t1", "gone"), toolResult("t2", "gone"), user("k1", "t2"), assistant("k2", "k1")];
  const seeds = toSeedEntries(slice);
  assert.deepEqual(
    seeds.map((e) => e.message.role),
    ["user", "assistant"],
  );
});

test("context: none mode seeds nothing; invalid context_turns throws", () => {
  const entries = [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2")];
  const none = buildSeedEntries({ mode: "none", entries });
  assert.deepEqual(none.entries, []);
  assert.equal(none.trimmedEntries, entries.length);

  assert.throws(() => buildSeedEntries({ mode: "last_n_turns", entries }), /context_turns/);
  assert.throws(() => buildSeedEntries({ mode: "last_n_turns", contextTurns: 0, entries }), /context_turns/);
  assert.throws(
    () => buildSeedEntries({ mode: "last_n_turns", contextTurns: MAX_CONTEXT_TURNS + 1, entries }),
    /context_turns/,
  );
});

// ── constants ──────────────────────────────────────────────────────────────

test("constants: name regex matches assertValidSessionId subset", () => {
  for (const good of ["a", "researcher-1", "A_b-9", "x".repeat(40)]) {
    assert.ok(NAME_REGEX.test(good), `expected valid: ${good}`);
  }
  for (const bad of ["", "-foo", "foo-", "_foo", "a".repeat(41), "foo.bar", "foo bar", "é"]) {
    assert.ok(!NAME_REGEX.test(bad), `expected invalid: ${JSON.stringify(bad)}`);
  }
});

// ── manager.ts ─────────────────────────────────────────────────────────────

import {
  SubagentRegistry,
  childrenOf,
  findNearestLivingAncestor,
  mergeChildOutputs,
  ResultStore,
  subtreeOf,
} from "../extensions/subagents/manager.ts";
import { isAncestorOf, makeSubagentTools, validateSpawnItem } from "../extensions/subagents/tools.ts";
import { watchSession } from "../extensions/subagents/session.ts";
import {
  buildSelectRows,
  doneLine,
  formatDuration,
  formatSubagentStatus,
  getSubagentCounts,
  formatTokens,
} from "../extensions/subagents/render.ts";
import { SubagentPanel } from "../extensions/subagents/inspector/panel.ts";
import { ROOT_AGENT_NAME } from "../extensions/subagents/constants.ts";

function makeHandle() {
  return {
    aborts: 0,
    disposed: false,
    async abort() {
      this.aborts += 1;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

function reg(hooks = {}) {
  return new SubagentRegistry(hooks);
}

function spawn(r, name, parentName = ROOT_AGENT_NAME, extra = {}) {
  return r.register({
    name,
    parentName,
    contextMode: "none",
    onParentError: "adopt",
    ...extra,
  });
}

function run(r, name) {
  const handle = makeHandle();
  const node = r.nodes.get(name);
  node.startedAt ??= 0;
  r.markRunning(name, handle);
  return handle;
}

test("manager: mergeChildOutputs orders sections by spawn order, parent first", () => {
  const merged = mergeChildOutputs("parent text", [
    { name: "c1", status: "done", output: "one" },
    { name: "c2", status: "error", output: "two" },
  ]);
  assert.equal(merged.mergedChildren, 2);
  assert.equal(
    merged.output,
    "parent text\n\n## c1 (done)\none\n\n## c2 (error)\ntwo",
  );
});

test("manager: mergeChildOutputs truncates from the bottom, keeping parent text", () => {
  const children = [
    { name: "c1", status: "done", output: "x".repeat(10) },
    { name: "c2", status: "done", output: "y".repeat(10) },
    { name: "c3", status: "done", output: "z".repeat(10) },
  ];
  const merged = mergeChildOutputs("parent", children, 40);
  // Parent + c1 section (37 chars) survives; c2/c3 dropped from the bottom.
  assert.equal(merged.mergedChildren, 1);
  assert.ok(merged.output.startsWith("parent\n\n## c1 (done)\n"));
  assert.ok(!merged.output.includes("## c2"));
  assert.ok(merged.output.length <= 40);
});

test("manager: mergeChildOutputs truncates head when parent text alone exceeds cap", () => {
  const merged = mergeChildOutputs("a".repeat(50), [{ name: "c", status: "done", output: "x" }], 10);
  assert.equal(merged.output, "a".repeat(10));
  assert.equal(merged.mergedChildren, 0);
});

test("manager: merge-at-settle includes uncollected child usage", async () => {
  const r = reg();
  spawn(r, "parent");
  spawn(r, "child", "parent");
  run(r, "parent");
  run(r, "child");
  r.settle("parent", { status: "done", output: "parent", usage: { cost: 0.1 } });
  const merging = r.mergeAtSettle("parent");
  r.settle("child", { status: "done", output: "child", usage: { cost: 0.2 } });
  await merging;
  assert.ok(Math.abs(r.store.peek("parent").usage.cost - 0.3) < Number.EPSILON);
});

test("manager: result store fetch removes, peek keeps, LRU evicts, TTL expires", () => {
  let now = 1000;
  const store = new ResultStore(2, 500, () => now);
  const result = (name) => ({
    name,
    status: "done",
    output: "o",
    usage: { inputTokens: 1, outputTokens: 2, cost: 3 },
    turns: 1,
    durationSec: 1,
    contextMode: "none",
  });

  store.set("a", result("a"));
  store.set("b", result("b"));
  store.set("c", result("c")); // capacity 2 -> "a" evicted (LRU)
  assert.equal(store.has("a"), false);
  assert.ok(store.peek("b"));
  assert.ok(store.has("b"));
  assert.equal(store.fetch("b").name, "b");
  assert.equal(store.has("b"), false); // fetch removes

  now += 501;
  assert.equal(store.has("c"), false); // TTL expired
  assert.equal(store.size, 0);
});

test("manager: register computes depth and spawn order; duplicate names throw", () => {
  const r = reg();
  spawn(r, "child");
  spawn(r, "grand", "child");
  assert.equal(r.nodes.get("child").depth, 1);
  assert.equal(r.nodes.get("grand").depth, 2);
  assert.deepEqual(childrenOf(r.nodes, "child").map((n) => n.name), ["grand"]);
  assert.throws(() => spawn(r, "child"), /already used/);
});

test("manager: registry subscribers follow transitions and collection", () => {
  const r = reg();
  const notes = [];
  const unsubscribe = r.subscribe((note) => notes.push(note));
  spawn(r, "watched");
  run(r, "watched");
  r.settle("watched", { status: "done", output: "ready" });
  assert.ok(notes.some((note) => note.includes("queued")));
  assert.ok(notes.some((note) => note.includes("running")));
  assert.ok(notes.some((note) => note.includes("settled")));
  r.fetchResults(["watched"]);
  assert.ok(notes.some((note) => note.includes("collected")));
  unsubscribe();
  const noteCount = notes.length;
  spawn(r, "after-unsubscribe");
  assert.equal(notes.length, noteCount);
});

test("manager: collected child usage rolls into the caller result", () => {
  const r = reg();
  spawn(r, "parent");
  spawn(r, "child", "parent");
  r.settle("child", { status: "done", output: "child", usage: { inputTokens: 10, outputTokens: 5, cost: 0.25 } });
  r.fetchResults(["child"], "parent");
  r.settle("parent", { status: "done", output: "parent", usage: { inputTokens: 4, outputTokens: 2, cost: 0.1 } });
  assert.ok(Math.abs(r.store.peek("parent").usage.cost - 0.35) < Number.EPSILON);
  assert.equal(r.store.peek("parent").usage.inputTokens, 14);
});

test("manager: subtreeOf collects the whole subtree preorder", () => {
  const r = reg();
  spawn(r, "a");
  spawn(r, "b");
  spawn(r, "a1", "a");
  spawn(r, "a2", "a");
  spawn(r, "a2x", "a2");
  assert.deepEqual(
    subtreeOf(r.nodes, "a").map((n) => n.name),
    ["a1", "a2", "a2x"],
  );
  assert.deepEqual(subtreeOf(r.nodes, "b").map((n) => n.name), []);
});

test("manager: queue respects MAX_CONCURRENT and spawn order", () => {
  const r = reg();
  for (let i = 0; i < 6; i++) spawn(r, `q${i}`);
  assert.deepEqual(
    [r.dequeueNext().name, r.dequeueNext().name],
    ["q0", "q1"],
  );
  run(r, "q0");
  run(r, "q1");
  run(r, "q2"); // q2 was dequeued but not yet running
  run(r, "q3");
  // 4 running -> no more capacity.
  assert.equal(r.dequeueNext(), undefined);
  assert.equal(r.queuePosition("q4"), 0);
  assert.equal(r.queuePosition("q5"), 1);
  assert.equal(r.queuePosition("q2"), -1); // already dequeued/running
});

test("manager: settle records the payload and resolves done without live children", async () => {
  const r = reg();
  spawn(r, "solo");
  run(r, "solo");
  let settled = false;
  void r.nodes.get("solo").done.then(() => (settled = true));
  r.settle("solo", { status: "done", output: "answer", usage: { inputTokens: 10, outputTokens: 5, cost: 0.25 }, turns: 3 });
  await Promise.resolve();
  assert.ok(settled);
  const result = r.store.peek("solo");
  assert.equal(result.status, "done");
  assert.equal(result.output, "answer");
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.turns, 3);
  assert.ok(result.endTime);
});

test("manager: done stays pending until merge-at-settle finishes", async () => {
  const notes = [];
  const r = reg({ mergeTimeoutMs: 1000, onStateChange: (note) => notes.push(note) });
  spawn(r, "parent");
  spawn(r, "kid", "parent");
  run(r, "parent");
  run(r, "kid");

  // Parent settles while kid is still running -> merge required.
  r.settle("parent", { status: "done", output: "parent output" });

  let parentDone = false;
  void r.nodes.get("parent").done.then(() => (parentDone = true));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(parentDone, false); // merging in progress

  r.settle("kid", { status: "done", output: "kid output" });
  await r.mergeAtSettle("parent");
  assert.ok(parentDone);
  assert.ok(notes.some((n) => /merging: parent/.test(n)));
  const merged = r.store.fetch("parent");
  assert.equal(merged.mergedChildren, 1);
  assert.equal(merged.output, "parent output\n\n## kid (done)\nkid output");
  assert.equal(r.store.has("kid"), false); // consumed by the merge
  assert.equal(r.nodes.get("parent").status, "done");
});

test("manager: merge-at-settle cuts off stragglers after the timeout", async () => {
  const r = reg({ mergeTimeoutMs: 30 });
  spawn(r, "parent");
  spawn(r, "slow", "parent");
  run(r, "parent");
  const slowHandle = run(r, "slow");
  r.settle("parent", { status: "done", output: "parent output" });

  await r.mergeAtSettle("parent");
  const slow = r.nodes.get("slow");
  assert.equal(slow.status, "cancelled");
  assert.equal(slowHandle.aborts, 1);
  const merged = r.store.fetch("parent");
  assert.equal(merged.mergedChildren ?? 0, 0);
  assert.match(merged.output, /parent output/);
});

test("manager: findNearestLivingAncestor skips dead ancestors to the root", () => {
  const r = reg();
  spawn(r, "a");
  spawn(r, "b", "a");
  spawn(r, "c", "b");
  spawn(r, "d", "c");
  // All alive: c's ancestor is b.
  assert.equal(findNearestLivingAncestor(r.nodes, "c"), "b");
  // b and c die -> d's nearest living ancestor is a.
  r.cancelSubtree("b");
  assert.equal(findNearestLivingAncestor(r.nodes, "d"), "a");
  // a dies too -> root.
  r.cancelSubtree("a");
  assert.equal(findNearestLivingAncestor(r.nodes, "d"), ROOT_AGENT_NAME);
});

test("manager: adoption re-parents live children, kill cancels them", () => {
  const notes = [];
  const r = reg({ onStateChange: (note) => notes.push(note) });
  spawn(r, "p");
  spawn(r, "kid1", "p");
  spawn(r, "kid2", "p", { onParentError: "kill" });
  const kid1 = run(r, "kid1");
  run(r, "kid2");

  r.settle("p", { status: "error", error: "provider died" });
  r.onUnexpectedFailure("p");

  assert.equal(r.nodes.get("kid1").parentName, ROOT_AGENT_NAME);
  assert.equal(r.nodes.get("kid1").adoptedFrom, "p");
  assert.equal(r.nodes.get("kid1").depth, 2); // depth unchanged
  assert.equal(kid1.aborts, 0); // adopted, not aborted
  assert.equal(r.nodes.get("kid2").status, "cancelled");
  assert.ok(notes.some((n) => /adopted: kid1/.test(n)));
  // The main agent can now collect the adopted child.
  assert.equal(r.validateCollect(ROOT_AGENT_NAME, ["kid1"]), true);
});

test("manager: failure adopts uncollected terminal child results", () => {
  const r = reg();
  spawn(r, "parent");
  spawn(r, "finished", "parent", { onParentError: "kill" });
  run(r, "parent");
  run(r, "finished");
  r.settle("finished", { status: "done", output: "finished output" });

  r.settle("parent", { status: "error", error: "provider died" });
  r.onUnexpectedFailure("parent");

  assert.equal(r.nodes.get("finished").parentName, ROOT_AGENT_NAME);
  assert.equal(r.nodes.get("finished").adoptedFrom, "parent");
  assert.equal(r.validateCollect(ROOT_AGENT_NAME, ["finished"]), true);
});

test("manager: cancelSubtree cascades, aborts handles, keeps settled results", () => {
  const notes = [];
  const r = reg({ onStateChange: (note) => notes.push(note) });
  spawn(r, "p");
  spawn(r, "doneKid", "p");
  spawn(r, "runKid", "p");
  spawn(r, "queuedKid", "p");
  spawn(r, "grandKid", "runKid");
  run(r, "p");
  run(r, "doneKid");
  run(r, "runKid");
  r.settle("doneKid", { status: "done", output: "already finished" });

  const cancelled = r.cancelSubtree("p");
  assert.deepEqual(cancelled, ["p", "runKid", "grandKid", "queuedKid"]);
  assert.equal(r.nodes.get("doneKid").status, "done");
  assert.equal(r.store.fetch("doneKid").output, "already finished");
  assert.equal(r.nodes.get("queuedKid").status, "cancelled");
  assert.ok(r.store.peek("runKid"));
  // One batched note for the whole cascade.
  assert.equal(notes.filter((n) => /cancelled:/.test(n)).length, 1);
});

test("manager: validateCollect rejects unknown, foreign, and already-collected names", () => {
  const r = reg();
  spawn(r, "mine");
  spawn(r, "other");
  spawn(r, "notMine", "other");
  run(r, "mine");
  r.settle("mine", { status: "done", output: "x" });

  assert.match(r.validateCollect(ROOT_AGENT_NAME, []).error, /at least one/);
  assert.match(r.validateCollect(ROOT_AGENT_NAME, ["nope"]).error, /Unknown subagent "nope"/);
  assert.match(r.validateCollect(ROOT_AGENT_NAME, ["mine", "mine"]).error, /Duplicate subagent name/);
  assert.match(r.validateCollect(ROOT_AGENT_NAME, ["notMine"]).error, /not a direct child/);
  assert.equal(r.validateCollect(ROOT_AGENT_NAME, ["mine"]), true);
  r.fetchResults(["mine"]);
  assert.match(r.validateCollect(ROOT_AGENT_NAME, ["mine"]).error, /already collected/);
});

test("manager: fetchResults returns payloads in requested order with combined usage", () => {
  const r = reg();
  spawn(r, "a");
  spawn(r, "b");
  run(r, "a");
  run(r, "b");
  r.settle("a", { status: "done", output: "A", usage: { inputTokens: 10, outputTokens: 5, cost: 0.1 } });
  r.settle("b", { status: "error", error: "boom", partialOutput: "B-partial", usage: { inputTokens: 1, outputTokens: 2, cost: 0.02 } });

  const { results, usage } = r.fetchResults(["b", "a"]); // requested order, not spawn order
  assert.deepEqual(results.map((x) => x.name), ["b", "a"]);
  assert.match(results[0].partialOutput, /B-partial/);
  assert.match(results[0].error, /boom/);
  assert.equal(usage.inputTokens, 11);
  assert.equal(usage.outputTokens, 7);
  assert.ok(Math.abs(usage.cost - 0.12) < 1e-9);
});

test("manager: a merge waiting during teardown does not repopulate cleared results", async () => {
  const r = reg({ mergeTimeoutMs: 1000 });
  spawn(r, "parent");
  spawn(r, "child", "parent");
  run(r, "parent");
  run(r, "child");
  r.settle("parent", { status: "done", output: "parent" });
  const merging = r.mergeAtSettle("parent");
  r.teardown("quit");
  await merging;
  assert.equal(r.nodes.size, 0);
  assert.equal(r.store.size, 0);
});

test("manager: teardown cancels + disposes on quit, keeps everything on reload", () => {
  const r = reg();
  spawn(r, "a");
  const handle = run(r, "a");

  r.teardown("reload");
  assert.equal(r.nodes.size, 1);
  assert.equal(r.nodes.get("a").status, "running");

  r.teardown("quit");
  assert.equal(r.nodes.size, 0);
  assert.equal(r.store.size, 0);
  assert.ok(handle.disposed);
  assert.equal(handle.aborts, 1);

  spawn(r, "after-session");
  assert.equal(r.nodes.get("after-session").spawnIndex, 0);
});

// ── tools.ts ───────────────────────────────────────────────────────────────

test("tools: spawn validation enforces UTF-8 prompt bytes and conditional context turns", () => {
  assert.equal(validateSpawnItem({ name: "ok", prompt: "é".repeat(10_000), context: "none" }).error, undefined);
  assert.match(
    validateSpawnItem({ name: "ok", prompt: "é".repeat(11_000), context: "none" }).error,
    /longer than/,
  );
  assert.match(validateSpawnItem(null).error, /must be an object/);
  assert.match(
    validateSpawnItem({ name: "ok", prompt: "task", context: "last_n_turns" }).error,
    /context_turns/,
  );
  assert.match(
    validateSpawnItem({ name: "ok", prompt: "task", context: "none", context_turns: 1 }).error,
    /must be omitted/,
  );
  assert.equal(
    validateSpawnItem({ name: "ok", prompt: "task", context: "last_n_turns", context_turns: 2 }).contextTurns,
    2,
  );
});

test("tools: spawn returns per-item errors while starting valid items", async () => {
  const r = reg();
  const starts = [];
  const parentModel = { provider: "test", id: "model", name: "Test Model" };
  const parent = { model: parentModel, thinking: "low" };
  const engine = {
    registry: r,
    start(request) {
      starts.push(request);
    },
  };
  const caller = {
    name: ROOT_AGENT_NAME,
    depth: 0,
    cwd: "/tmp/subagents-test-cwd",
    agentDir: "/tmp/subagents-test-agent",
    historyEntries: () => [],
    parentModel: parent,
    modelRegistry: fakeRegistry([parentModel]),
  };
  const spawnTool = makeSubagentTools(() => caller, engine).find((tool) => tool.name === "spawn_subagents");
  const response = await spawnTool.execute("call", {
    subagents: [
      { name: "valid", prompt: "do it", context: "none" },
      { name: "bad name", prompt: "do it", context: "none" },
      { name: "valid", prompt: "again", context: "none" },
    ],
  }, undefined, undefined, {});

  assert.equal(starts.length, 1);
  assert.equal(r.nodes.get("valid").status, "queued");
  assert.match(response.content[0].text, /1\/3 spawned/);
  assert.match(response.content[0].text, /bad name/);
  assert.match(response.content[0].text, /already used/);
});

test("tools: collect waits without a signal and status-by-name is scoped", async () => {
  const r = reg();
  spawn(r, "mine");
  spawn(r, "other");
  const parentModel = { provider: "test", id: "model", name: "Test Model" };
  const parent = { model: parentModel, thinking: "low" };
  const engine = {
    registry: r,
    start(request) {
      setTimeout(() => r.settle(request.node.name, {
        status: "done",
        output: "result",
        usage: { inputTokens: 2, outputTokens: 3, cost: 0.01 },
        turns: 1,
      }), 5);
    },
  };
  const caller = {
    name: ROOT_AGENT_NAME,
    depth: 0,
    cwd: "/tmp/subagents-test-cwd",
    agentDir: "/tmp/subagents-test-agent",
    historyEntries: () => [],
    parentModel: parent,
    modelRegistry: fakeRegistry([parentModel]),
  };
  const tools = makeSubagentTools(() => caller, engine);
  const collect = tools.find((tool) => tool.name === "collect_subagents");
  const status = tools.find((tool) => tool.name === "subagent_status");

  engine.start({ node: r.nodes.get("mine") });
  const collected = await collect.execute("call", { names: ["mine"] }, undefined, undefined, {});
  assert.match(collected.content[0].text, /mine: done/);
  assert.match(collected.content[0].text, /result/);

  const statusResponse = await status.execute("call", { name: "other" }, undefined, undefined, {});
  assert.match(statusResponse.content[0].text, /other/);
  assert.doesNotMatch(statusResponse.content[0].text, /mine/);

  assert.equal(isAncestorOf(r, ROOT_AGENT_NAME, "other"), true);
});

// ── session.ts / render.ts ─────────────────────────────────────────────────

test("session: watchSession aggregates usage and marks max-turn termination partial", async () => {
  const r = reg();
  spawn(r, "watched", ROOT_AGENT_NAME, { maxTurns: 1 });
  run(r, "watched");
  let listener;
  let unsubscribed = false;
  const session = {
    messages: [],
    subscribe(callback) {
      listener = callback;
      return () => {
        unsubscribed = true;
      };
    },
    async abort() {},
  };
  let pumped = 0;
  const finish = watchSession(r, r.nodes.get("watched"), session, {
    registry: r,
    start() {},
    pump() {
      pumped += 1;
    },
  });

  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "aborted",
    usage: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.2 } },
  });
  listener({ type: "turn_end" });
  listener({ type: "agent_end", messages: session.messages });
  await finish("failed", new Error("aborted by max-turn guard"));

  const result = r.store.fetch("watched");
  assert.equal(result.status, "partial");
  assert.equal(result.stopReason, "max_turns");
  assert.equal(result.output, "partial answer");
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 6, cost: 0.2 });
  assert.equal(unsubscribed, true);
  assert.equal(pumped, 1);
});

test("session: timeout abort is classified as timeout error", async () => {
  const r = reg();
  spawn(r, "timed", ROOT_AGENT_NAME, { timeoutS: 0.01 });
  run(r, "timed");
  const session = {
    messages: [],
    subscribe() {
      return () => {};
    },
    async abort() {},
  };
  const finish = watchSession(r, r.nodes.get("timed"), session, { registry: r, start() {}, pump() {} });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await finish("failed", new Error("abort"));

  const result = r.store.fetch("timed");
  assert.equal(result.status, "error");
  assert.equal(result.stopReason, "timeout");
  assert.match(result.error, /timeout after/);
  assert.equal(result.partialOutput, "");
});

test("render: keeps the footer status minimal and hides it when idle", () => {
  const r = reg();
  assert.equal(formatSubagentStatus(r), undefined);
  spawn(r, "running");
  spawn(r, "queued");
  run(r, "running");
  assert.deepEqual(getSubagentCounts(r), { running: 1, queued: 1, toReview: 0 });
  assert.equal(formatSubagentStatus(r), "Subagents: 1 running · 1 queued · /subagents");
});

test("render: formats durations, tokens, and visible tree rows", () => {
  const r = reg();
  spawn(r, "parent");
  spawn(r, "child", "parent");
  run(r, "parent");
  r.settle("parent", { status: "done", output: "parent output", turns: 2 });
  r.settle("child", { status: "done", output: "child output" });

  const rows = buildSelectRows(r, Date.now());
  assert.equal(rows.length, 2);
  assert.match(rows[0].label, /parent \[done\].*\(\+1\)/);
  assert.match(rows[1].label, /^  ✓ child \[done\]/);
  assert.deepEqual(rows.map((row) => row.value), ["parent", "child"]);
  assert.deepEqual(getSubagentCounts(r), { running: 0, queued: 0, toReview: 2 });
  assert.equal(formatSubagentStatus(r), "Subagents: 2 awaiting collection · /subagents");
  assert.equal(formatDuration(61.2), "1m1s");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.match(doneLine({ name: "x", status: "partial", durationSec: 1, turns: 2, inputTokens: 2, outputTokens: 3, cost: 0.1 }), /^◐ x/);
});

test("render: inspector confirms cancellation and closes without aborting work", () => {
  const r = reg();
  spawn(r, "popup-agent");
  run(r, "popup-agent");
  let closed = false;
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const panel = new SubagentPanel(r, theme, () => { closed = true; }, () => {});
  assert.match(panel.render(60).join("\n"), /popup-agent · running/);
  panel.handleInput("c");
  assert.equal(r.nodes.get("popup-agent").status, "running");
  panel.handleInput("y");
  assert.equal(r.nodes.get("popup-agent").status, "cancelled");
  panel.handleInput("\u001b");
  assert.equal(closed, true);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import backgroundBashExtension, {
  defaultTaskDescription,
  formatDuration,
  parseBackgroundCommand,
  sanitizeTerminalOutput,
} from "../extensions/background-bash/index.ts";

const agentDir = await mkdtemp(join(tmpdir(), "pi-background-bash-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rm(agentDir, { force: true, recursive: true }));

function createPi(settings = {}) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const messages = [];

  return {
    handlers,
    tools,
    commands,
    messages,
    pi: {
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      getSettings() {
        return settings;
      },
      sendMessage(message, options) {
        messages.push({ message, options });
      },
    },
  };
}

function createContext({
  cwd = process.cwd(),
  sessionId = randomUUID(),
  hasUI = false,
  widgets = [],
  notifications = [],
} = {}) {
  return {
    cwd,
    hasUI,
    model: undefined,
    thinkingLevel: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
    },
    ui: {
      theme: {
        fg(_color, text) {
          return text;
        },
      },
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
}

async function createHarness(options = {}) {
  const state = createPi(options.settings);
  backgroundBashExtension(state.pi);
  const widgets = [];
  const notifications = [];
  const ctx = createContext({ ...options, widgets, notifications });
  await state.handlers.get("session_start")({ reason: "startup" }, ctx);

  let closed = false;
  return {
    ...state,
    ctx,
    widgets,
    notifications,
    async shutdown() {
      if (closed) return;
      closed = true;
      await state.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    },
    async tree(newLeafId, oldLeafId) {
      await state.handlers.get("session_tree")({ newLeafId, oldLeafId }, ctx);
    },
  };
}

async function harnessFor(t, options) {
  const harness = await createHarness(options);
  t.after(() => harness.shutdown());
  return harness;
}

function executeBash(harness, params, ctx = harness.ctx) {
  return harness.tools.get("bash").execute("test-call", params, undefined, undefined, ctx);
}

function executeBashKill(harness, taskId, ctx = harness.ctx) {
  return harness.tools
    .get("bash_kill")
    .execute("kill-call", { task_id: taskId }, undefined, undefined, ctx);
}

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCompletion(harness, taskId, timeoutMs = 8_000) {
  await waitFor(
    () => harness.messages.some(({ message }) => message.details?.task_id === taskId),
    `completion for ${taskId}`,
    timeoutMs,
  );
  const completion = harness.messages.find(({ message }) => message.details?.task_id === taskId);
  assert.ok(completion, `expected a completion message for ${taskId}`);
  return completion;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startBackground(harness, params) {
  const result = await executeBash(harness, { background: true, ...params });
  return {
    result,
    taskId: result.structuredContent.task_id,
    outputFile: result.structuredContent.output_file,
  };
}

function lastWidget(harness) {
  const widget = harness.widgets.findLast((entry) => entry.key === "bash-background");
  assert.ok(widget, "expected a bash-background widget update");
  return widget;
}

function lastNotification(harness) {
  const notification = harness.notifications.at(-1);
  assert.ok(notification, "expected a notification");
  return notification.message;
}

test("formats durations for short and long tasks", () => {
  assert.equal(formatDuration(1_234), "1.2s");
  assert.equal(formatDuration(59_960), "1m 0s");
  assert.equal(formatDuration(65_000), "1m 5s");
});

test("falls back to the first command line for descriptions", () => {
  assert.equal(defaultTaskDescription("  echo hi  \nsecond line"), "echo hi");
  assert.equal(defaultTaskDescription("x".repeat(100)).length, 80);
  assert.equal(defaultTaskDescription("\x1b[31mecho hi\x1b[0m"), "echo hi");
});

test("parses /bg arguments", () => {
  assert.deepEqual(parseBackgroundCommand(""), { action: "list" });
  assert.deepEqual(parseBackgroundCommand("stop bg-1"), { action: "stop", taskId: "bg-1" });
  assert.deepEqual(parseBackgroundCommand("path bg-1"), { action: "path", taskId: "bg-1" });
  assert.throws(() => parseBackgroundCommand("stop"), /Usage: \/bg/);
  assert.throws(() => parseBackgroundCommand("path bg-1 extra"), /Usage: \/bg/);
  assert.throws(() => parseBackgroundCommand("unknown"), /Usage: \/bg/);
});

test("sanitizes terminal output before it enters model context", () => {
  assert.equal(sanitizeTerminalOutput("\x1b[31mred\x1b[0m\r\n"), "red\n");
  assert.equal(
    sanitizeTerminalOutput("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"),
    "link",
  );
  assert.equal(sanitizeTerminalOutput("a\x00b\x08c\x7f"), "abc");
});

test("foreground bash delegates to the built-in implementation", async (t) => {
  const harness = await harnessFor(t);

  const result = await executeBash(harness, { command: "printf 'foreground\\n'" });

  assert.match(result.content[0].text, /foreground/);
  assert.equal(harness.messages.length, 0);
});

test("background bash writes output to a private log and notifies on completion", async (t) => {
  const harness = await harnessFor(t);

  const { result, taskId, outputFile } = await startBackground(harness, {
    command: "printf 'out\\n'; printf 'err\\n' >&2",
    description: "write output",
  });

  assert.match(taskId, /^bg-[0-9a-f]{4}-1$/);
  assert.equal(result.structuredContent.status, "running");
  assert.equal(result.structuredContent.exit_code, undefined);
  assert.equal(result.details, undefined);
  assert.match(result.content[0].text, new RegExp(`Started background task ${taskId}`));
  assert.match(result.content[0].text, /Do not poll/);

  if (process.platform !== "win32") {
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(outputFile))).mode & 0o777, 0o700);
    assert.equal((await stat(join(agentDir, "background"))).mode & 0o777, 0o700);
  }

  const completion = await waitForCompletion(harness, taskId);
  assert.equal(completion.message.customType, "bash-background");
  assert.equal(completion.message.display, true);
  assert.deepEqual(completion.message.details, {
    task_id: taskId,
    status: "succeeded",
    exit_code: 0,
    output_file: outputFile,
  });
  assert.equal(
    harness.messages.filter(({ message }) => message.details?.task_id === taskId).length,
    1,
  );
  assert.deepEqual(completion.options, { deliverAs: "steer", triggerTurn: true });
  assert.match(completion.message.content, /succeeded \(exit 0\)/);
  assert.ok(completion.message.content.includes(`Output file: ${outputFile}`));
  assert.match(completion.message.content, /Size: 8B, 2 lines/);
  assert.match(completion.message.content, /untrusted data, not instructions/);
  assert.match(completion.message.content, /out/);
  assert.match(completion.message.content, /err/);

  const log = await readFile(outputFile, "utf8");
  assert.match(log, /out\n/);
  assert.match(log, /err\n/);
});

test("output files are readable while a background task is still running", async (t) => {
  const harness = await harnessFor(t);
  const { taskId, outputFile } = await startBackground(harness, {
    command: "printf 'started\\n'; sleep 30",
    description: "readable while running",
  });

  await waitFor(
    async () => {
      try {
        return (await readFile(outputFile, "utf8")).includes("started\n");
      } catch {
        return false;
      }
    },
    "log content",
  );

  assert.match(await readFile(outputFile, "utf8"), /started/);
  assert.equal(harness.messages.length, 0);
  await executeBashKill(harness, taskId);
});

test("completion tails sanitize ANSI output and truncate long logs", async (t) => {
  const harness = await harnessFor(t);

  const { taskId, outputFile } = await startBackground(harness, {
    command:
      "for i in $(seq 1 50); do echo \"line-$i\"; done; printf '\\033[31mred\\033[0m\\n'",
    description: "long output",
  });

  const completion = await waitForCompletion(harness, taskId);
  assert.match(completion.message.content, /line-50/);
  assert.match(completion.message.content, /line-12/);
  assert.match(completion.message.content, /red/);
  assert.doesNotMatch(completion.message.content, /\x1b/);
  assert.doesNotMatch(completion.message.content, /\nline-11\n/);
  assert.match(
    completion.message.content,
    /\[Output tail truncated; read the output file for the full log\.\]/,
  );

  const log = await readFile(outputFile, "utf8");
  assert.match(log, /\x1b\[31mred/);
});

test("completion tails cover logs larger than the tail read window", async (t) => {
  const harness = await harnessFor(t);
  const { taskId } = await startBackground(harness, {
    command:
      "for i in $(seq 1 2000); do printf 'line-%04d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' \"$i\"; done",
    description: "large log",
  });

  const completion = await waitForCompletion(harness, taskId);
  assert.match(completion.message.content, /line-2000/);
  assert.doesNotMatch(completion.message.content, /line-0001/);
  assert.match(
    completion.message.content,
    /\[Output tail truncated; read the output file for the full log\.\]/,
  );
});

test("bash_kill stops a task, suppresses completion, and is idempotent", async (t) => {
  const harness = await harnessFor(t);
  const { taskId } = await startBackground(harness, {
    command: "sleep 30",
    description: "long sleep",
  });

  const stopped = await executeBashKill(harness, taskId);
  assert.equal(stopped.structuredContent.status, "cancelled");
  assert.match(stopped.content[0].text, new RegExp(`Task ${taskId} stopped: cancelled`));

  await delay(200);
  assert.equal(harness.messages.length, 0);

  const stoppedAgain = await executeBashKill(harness, taskId);
  assert.equal(stoppedAgain.structuredContent.status, "cancelled");
  assert.match(stoppedAgain.content[0].text, new RegExp(`Task ${taskId} is already cancelled`));
});

test("bash_kill terminates the command's process tree", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process signalling is required");
    return;
  }

  const cwd = await mkdtemp(join(agentDir, "process-tree-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const harness = await harnessFor(t, { cwd });
  const pidFile = join(cwd, "child.pid");
  const { taskId } = await startBackground(harness, {
    command: "sleep 30 & pid=$!; echo $pid > child.pid; wait $pid",
    description: "process tree",
  });

  await waitFor(() => existsSync(pidFile), "child pid file");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "expected a valid child pid");

  await executeBashKill(harness, taskId);
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }, "child process exit");
});

test("unknown task ids are tool errors", async (t) => {
  const harness = await harnessFor(t);

  await assert.rejects(
    () => executeBashKill(harness, "bg-dead-99"),
    /Unknown background task: bg-dead-99/,
  );
});

test("timeouts produce a timed_out completion", async (t) => {
  const harness = await harnessFor(t);

  const { taskId } = await startBackground(harness, {
    command: "sleep 5",
    timeout: 0.5,
    description: "short timeout",
  });

  const completion = await waitForCompletion(harness, taskId);
  assert.equal(completion.message.details.status, "timed_out");
  assert.match(completion.message.content, /timed out after 0\.5s/);
});

test("non-zero exits produce a failed completion", async (t) => {
  const harness = await harnessFor(t);
  const { taskId } = await startBackground(harness, {
    command: "exit 7",
    description: "failing command",
  });

  const completion = await waitForCompletion(harness, taskId);
  assert.equal(completion.message.details.status, "failed");
  assert.equal(completion.message.details.exit_code, 7);
  assert.match(completion.message.content, /failed \(exit 7\)/);
});

test("the log limit stops the command and reports log_limit", async (t) => {
  const harness = await harnessFor(t);
  const previousLimit = process.env.PI_BACKGROUND_BASH_LOG_LIMIT_BYTES;
  process.env.PI_BACKGROUND_BASH_LOG_LIMIT_BYTES = "256";

  try {
    const { taskId, outputFile } = await startBackground(harness, {
      command: "yes x",
      description: "spew output",
    });

    const completion = await waitForCompletion(harness, taskId);
    assert.equal(completion.message.details.status, "log_limit");
    assert.match(completion.message.content, /log limit exceeded \(256B\)/);

    const log = await readFile(outputFile, "utf8");
    assert.match(log, /background output limit of 256B exceeded/);
    assert.ok((await stat(outputFile)).size > 256);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_BACKGROUND_BASH_LOG_LIMIT_BYTES;
    else process.env.PI_BACKGROUND_BASH_LOG_LIMIT_BYTES = previousLimit;
  }
});

test("invalid working directories are rejected before a task starts", async (t) => {
  const harness = await harnessFor(t);
  const missingCwd = join(agentDir, "does-not-exist");
  const fileCwd = join(agentDir, "not-a-directory");
  await writeFile(fileCwd, "file");

  await assert.rejects(
    () =>
      executeBash(
        harness,
        { command: "echo hi", background: true },
        createContext({ cwd: missingCwd }),
      ),
    /Working directory does not exist/,
  );
  await assert.rejects(
    () =>
      executeBash(
        harness,
        { command: "echo hi", background: true },
        createContext({ cwd: fileCwd }),
      ),
    /Working directory is not a directory/,
  );
  assert.equal(harness.messages.length, 0);
});

test("spawn failures produce an error completion", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable permissions are required");
    return;
  }

  const badShell = join(agentDir, "not-executable-shell");
  await writeFile(badShell, "#!/bin/sh\n", { mode: 0o644 });
  const harness = await harnessFor(t, { settings: { shellPath: badShell } });

  const { taskId } = await startBackground(harness, {
    command: "echo hi",
    description: "bad shell",
  });

  const completion = await waitForCompletion(harness, taskId);
  assert.equal(completion.message.details.status, "error");
  assert.match(completion.message.content, /finished: error —/);
});

test("the background task cap cannot be overrun by parallel starts", async (t) => {
  const harness = await harnessFor(t);

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) =>
      startBackground(harness, { command: "sleep 30", description: `parallel ${index}` }),
    ),
  );

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 8);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  for (const result of results) {
    if (result.status === "rejected")
      assert.match(result.reason.message, /Too many background tasks running \(maximum 8\)/);
  }

  await assert.rejects(
    () => executeBash(harness, { command: "true", background: true }),
    /Too many background tasks running \(maximum 8\)/,
  );
});

test("retained terminal records are capped", async (t) => {
  const harness = await harnessFor(t);

  for (let index = 0; index < 33; index++) {
    const { taskId } = await startBackground(harness, {
      command: "true",
      description: `quick task ${index}`,
    });
    await waitForCompletion(harness, taskId);
  }

  await harness.commands.get("bg").handler("", harness.ctx);
  const list = lastNotification(harness);
  assert.equal(list.split("\n").filter((line) => line.startsWith("bg-")).length, 32);
});

test("session shutdown kills tasks, suppresses completions, and removes logs", async (t) => {
  const harness = await harnessFor(t, { hasUI: true });
  const { taskId, outputFile } = await startBackground(harness, {
    command: "sleep 30",
    description: "shutdown task",
  });

  await harness.shutdown();
  await delay(200);

  assert.equal(harness.messages.length, 0);
  assert.equal(lastWidget(harness).content, undefined);
  assert.equal(existsSync(dirname(outputFile)), false);
  await assert.rejects(() => executeBashKill(harness, taskId), /Unknown background task/);
});

test("session tree navigation kills old branch tasks", async (t) => {
  const harness = await harnessFor(t, { hasUI: true });
  const { taskId, outputFile } = await startBackground(harness, {
    command: "sleep 30",
    description: "tree task",
  });

  await harness.tree("same-leaf", "same-leaf");
  assert.deepEqual(lastWidget(harness).content, ["⏳ 1 background command running"]);

  await harness.tree("new-leaf", "old-leaf");
  await delay(200);

  assert.equal(harness.messages.length, 0);
  assert.equal(existsSync(outputFile), true);
  assert.equal(lastWidget(harness).content, undefined);
  await assert.rejects(() => executeBashKill(harness, taskId), /Unknown background task/);
});

test("the below-editor indicator tracks running tasks", async (t) => {
  const harness = await harnessFor(t, { hasUI: true });
  assert.equal(lastWidget(harness).content, undefined);

  const first = await startBackground(harness, { command: "sleep 30", description: "first" });
  const second = await startBackground(harness, { command: "sleep 30", description: "second" });

  assert.deepEqual(lastWidget(harness).content, ["⏳ 2 background commands running"]);
  assert.deepEqual(lastWidget(harness).options, { placement: "belowEditor" });

  await executeBashKill(harness, first.taskId);
  assert.deepEqual(lastWidget(harness).content, ["⏳ 1 background command running"]);

  await executeBashKill(harness, second.taskId);
  assert.equal(lastWidget(harness).content, undefined);
});

test("no-UI sessions do not render the indicator", async (t) => {
  const harness = await harnessFor(t);
  const { taskId } = await startBackground(harness, { command: "sleep 30" });

  assert.equal(harness.widgets.length, 0);
  await executeBashKill(harness, taskId);
  assert.equal(harness.widgets.length, 0);
});

test("/bg lists, shows paths, and stops tasks", async (t) => {
  const harness = await harnessFor(t, { hasUI: true });

  await harness.commands.get("bg").handler("", harness.ctx);
  assert.equal(lastNotification(harness), "No background tasks in this session.");

  const { taskId, outputFile } = await startBackground(harness, {
    command: "sleep 30",
    description: "listed task",
  });

  await harness.commands.get("bg").handler("", harness.ctx);
  let message = lastNotification(harness);
  assert.match(message, new RegExp(`${taskId} \\[running\\]`));
  assert.match(message, /listed task/);
  assert.match(message, new RegExp(outputFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await harness.commands.get("bg").handler(`path ${taskId}`, harness.ctx);
  assert.equal(lastNotification(harness), `${taskId}: ${outputFile}`);

  await harness.commands.get("bg").handler(`stop ${taskId}`, harness.ctx);
  assert.equal(lastNotification(harness), `Task ${taskId} stopped: cancelled.`);

  await harness.commands.get("bg").handler(`stop ${taskId}`, harness.ctx);
  assert.equal(lastNotification(harness), `Task ${taskId} is already cancelled.`);

  await harness.commands.get("bg").handler("", harness.ctx);
  message = lastNotification(harness);
  assert.match(message, new RegExp(`${taskId} \\[cancelled\\]`));
  assert.equal(harness.messages.length, 0);

  await harness.commands.get("bg").handler("stop bg-dead-1", harness.ctx);
  assert.equal(lastNotification(harness), "Unknown background task: bg-dead-1");

  await harness.commands.get("bg").handler("nope", harness.ctx);
  assert.match(lastNotification(harness), /Usage: \/bg/);
});

test("session start cleans up stale log directories", async (t) => {
  const root = join(agentDir, "background");
  const stale = join(root, "stale-session");
  const fresh = join(root, "fresh-session");
  await mkdir(stale, { recursive: true });
  await mkdir(fresh, { recursive: true });
  await writeFile(join(stale, "old.log"), "old");
  const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(stale, oldTime, oldTime);

  await harnessFor(t, { sessionId: "cleanup-session" });

  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  t.after(() => rm(fresh, { force: true, recursive: true }));
});

test("custom command prefixes apply to background commands", async (t) => {
  const harness = await harnessFor(t, {
    settings: { shellCommandPrefix: "echo prefix" },
  });

  const { taskId, outputFile } = await startBackground(harness, {
    command: "echo body",
    description: "prefixed",
  });

  await waitForCompletion(harness, taskId);
  assert.equal(await readFile(outputFile, "utf8"), "prefix\nbody\n");
});

test("descriptions fall back to the command when omitted", async (t) => {
  const harness = await harnessFor(t);
  const { taskId } = await startBackground(harness, { command: "echo body" });

  const completion = await waitForCompletion(harness, taskId);
  assert.match(completion.message.content, /\(echo body\)/);
});

test("invalid background commands and timeouts are rejected", async (t) => {
  const harness = await harnessFor(t);

  await assert.rejects(
    () => executeBash(harness, { command: "   ", background: true }),
    /Invalid command/,
  );
  await assert.rejects(
    () => executeBash(harness, { command: "true", background: true, timeout: 0 }),
    /Invalid timeout/,
  );
  await assert.rejects(
    () =>
      executeBash(harness, {
        command: "true",
        background: true,
        timeout: Number.MAX_SAFE_INTEGER,
      }),
    /maximum/,
  );
});

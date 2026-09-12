import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import worktreeExtension, {
	createWorktreeSession,
	ensureWorktree,
	formatWorktreeResumeCommand,
	parseLaunchFlags,
	parseWorktreeCommandArguments,
	removeWorktreeArguments,
} from "../extensions/worktree.ts";

function runGit(arguments_, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ stdout, stderr, code: code ?? 1, killed: false });
		});
	});
}

async function runGitSuccessfully(arguments_, cwd) {
	const result = await runGit(arguments_, cwd);
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
}

async function createRepository() {
	const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-worktree-extension-"));
	await runGitSuccessfully(["init", "--initial-branch", "main"], repositoryRoot);
	await runGitSuccessfully(["-c", "user.name=Pi", "-c", "user.email=pi@example.com", "commit", "--allow-empty", "-m", "Initial commit"], repositoryRoot);
	return runGitSuccessfully(["rev-parse", "--show-toplevel"], repositoryRoot);
}

test("removes worktree flags before relaunching Pi", () => {
	assert.deepEqual(
		removeWorktreeArguments([
			"--model",
			"gpt-5",
			"--worktree",
			"feature/example",
			"--worktree-base",
			"main",
			"--worktree-session",
			"ignored-session",
			"prompt",
			"--worktree=ignored-duplicate",
			"--worktree-base=ignored-duplicate",
			"--worktree-session=ignored-duplicate",
		]),
		["--model", "gpt-5", "prompt"],
	);
});

test("reads the worktree launch flags from the CLI", () => {
	assert.deepEqual(
		parseLaunchFlags([
			"--model",
			"gpt-5",
			"--worktree",
			"feature/example",
			"--worktree-base",
			"main",
			"--worktree-session",
			"session.jsonl",
		]),
		{ branch: "feature/example", baseBranch: "main", worktreeSession: "session.jsonl" },
	);
	assert.deepEqual(
		parseLaunchFlags(["--worktree=feature/example", "--worktree-base=main"]),
		{ branch: "feature/example", baseBranch: "main", worktreeSession: undefined },
	);
	assert.deepEqual(parseLaunchFlags(["--worktree-base", "main"]), {
		branch: undefined,
		baseBranch: "main",
		worktreeSession: undefined,
	});
});

test("replaces the parent session when resuming inside a worktree", () => {
	assert.deepEqual(
		removeWorktreeArguments(
			[
				"--session",
				"parent-session",
				"--worktree",
				"feature/example",
				"--worktree-session=worktree-session",
				"prompt",
			],
			"worktree-session",
		),
		["--session", "worktree-session", "prompt"],
	);
});

test("formats a worktree-aware resume command", () => {
	assert.equal(
		formatWorktreeResumeCommand("feature/example", "/tmp/session file's.jsonl"),
		"pi --worktree feature/example --worktree-session '/tmp/session file'\\''s.jsonl'",
	);
});

test("parses a base branch option for the slash command", () => {
	assert.deepEqual(parseWorktreeCommandArguments("feature/example --base release"), {
		baseBranch: "release",
		branch: "feature/example",
	});
	assert.deepEqual(parseWorktreeCommandArguments("--base=release feature/example"), {
		baseBranch: "release",
		branch: "feature/example",
	});
});

test("parses the internal continuation option for the slash command", () => {
	assert.deepEqual(parseWorktreeCommandArguments("feature/example --continue"), {
		baseBranch: undefined,
		branch: "feature/example",
		continueAgent: true,
	});
});

test("creates a branch and nested worktree from the current branch", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	await runGitSuccessfully(["switch", "-c", "base-branch"], repositoryRoot);
	await runGitSuccessfully(["-c", "user.name=Pi", "-c", "user.email=pi@example.com", "commit", "--allow-empty", "-m", "Base branch commit"], repositoryRoot);
	const baseCommit = await runGitSuccessfully(["rev-parse", "HEAD"], repositoryRoot);

	const result = await ensureWorktree("feature/example", repositoryRoot, runGit);

	assert.equal(result.created, true);
	assert.equal(result.path, `${repositoryRoot}/.agents/worktrees/feature/example`);
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], result.path), "feature/example");
	assert.equal(await runGitSuccessfully(["rev-parse", "HEAD"], result.path), baseCommit);
});

test("creates a new branch from the requested base branch", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const baseCommit = await runGitSuccessfully(["rev-parse", "main"], repositoryRoot);
	await runGitSuccessfully(["switch", "-c", "current-branch"], repositoryRoot);
	await runGitSuccessfully(
		["-c", "user.name=Pi", "-c", "user.email=pi@example.com", "commit", "--allow-empty", "-m", "Current branch commit"],
		repositoryRoot,
	);

	const result = await ensureWorktree("from-base", repositoryRoot, runGit, "main");

	assert.equal(await runGitSuccessfully(["rev-parse", "HEAD"], result.path), baseCommit);
});

test("creates worktrees under the main checkout when invoked from another worktree", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const anotherWorktree = await ensureWorktree("another-worktree", repositoryRoot, runGit);
	await runGitSuccessfully(
		["-c", "user.name=Pi", "-c", "user.email=pi@example.com", "commit", "--allow-empty", "-m", "Another worktree commit"],
		anotherWorktree.path,
	);
	const sourceCommit = await runGitSuccessfully(["rev-parse", "HEAD"], anotherWorktree.path);

	const result = await ensureWorktree("my-worktree", anotherWorktree.path, runGit);

	assert.equal(result.path, `${repositoryRoot}/.agents/worktrees/my-worktree`);
	assert.equal(await runGitSuccessfully(["rev-parse", "HEAD"], result.path), sourceCommit);
});

test("materializes an empty worktree session with the target cwd", async (context) => {
	const worktreePath = await mkdtemp(join(tmpdir(), "pi-worktree-session-"));
	context.after(() => rm(worktreePath, { force: true, recursive: true }));
	const sessionDirectory = join(worktreePath, ".sessions");

	const sessionFile = createWorktreeSession(worktreePath, undefined, sessionDirectory);
	const session = SessionManager.open(sessionFile);

	assert.equal(session.getCwd(), worktreePath);
});

test("creates a worktree session that preserves the current conversation", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const worktree = await ensureWorktree("session-worktree", repositoryRoot, runGit);
	const sourceSessionDirectory = join(repositoryRoot, ".sessions", "source");
	const targetSessionDirectory = join(repositoryRoot, ".sessions", "target");
	const sourceSession = SessionManager.create(repositoryRoot, sourceSessionDirectory);
	const sourceSessionFile = sourceSession.getSessionFile();
	assert.ok(sourceSessionFile);
	sourceSession.appendMessage({ role: "user", content: "Keep this context", timestamp: Date.now() });
	sourceSession.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });

	const targetSessionFile = createWorktreeSession(
		worktree.path,
		sourceSessionFile,
		targetSessionDirectory,
	);
	const targetSession = SessionManager.open(targetSessionFile);

	assert.equal(targetSession.getCwd(), worktree.path);
	assert.equal(targetSession.getHeader()?.parentSession, sourceSessionFile);
	assert.equal(targetSession.buildSessionContext().messages[0]?.role, "user");
});

test("the CLI flag shuts down the parent TUI before relaunching", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const baseCommit = await runGitSuccessfully(["rev-parse", "main"], repositoryRoot);
	await runGitSuccessfully(["switch", "-c", "current-branch"], repositoryRoot);
	await runGitSuccessfully(
		["-c", "user.name=Pi", "-c", "user.email=pi@example.com", "commit", "--allow-empty", "-m", "Current branch commit"],
		repositoryRoot,
	);
	let sessionStartHandler;

	worktreeExtension({
		exec(command, arguments_, options) {
			assert.equal(command, "git");
			return runGit(arguments_, options.cwd);
		},
		getFlag(name) {
			if (name === "worktree") return "tui-worktree";
			if (name === "worktree-base") return "main";
		},
		on(event, handler) {
			if (event === "session_start") sessionStartHandler = handler;
		},
		registerCommand() {},
		registerFlag() {},
		registerTool() {},
	});
	assert.ok(sessionStartHandler);

	let shutdownCalls = 0;
	await sessionStartHandler(
		{ reason: "startup" },
		{
			cwd: repositoryRoot,
			mode: "tui",
			shutdown: () => shutdownCalls++,
			ui: { notify() {} },
		},
	);

	assert.equal(shutdownCalls, 1);
	const worktreePath = `${repositoryRoot}/.agents/worktrees/tui-worktree`;
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], worktreePath), "tui-worktree");
	assert.equal(await runGitSuccessfully(["rev-parse", "HEAD"], worktreePath), baseCommit);
});

test("the slash command switches Pi to a session in the worktree", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const baseCommit = await runGitSuccessfully(["rev-parse", "main"], repositoryRoot);
	await runGitSuccessfully(["switch", "-c", "current-branch"], repositoryRoot);
	await runGitSuccessfully(
		["-c", "user.name=Pi", "-c", "user.email=pi@example.com", "commit", "--allow-empty", "-m", "Current branch commit"],
		repositoryRoot,
	);
	const sourceSession = SessionManager.create(repositoryRoot, join(repositoryRoot, ".sessions"));
	let worktreeCommand;
	const notifications = [];

	worktreeExtension({
		exec(command, arguments_, options) {
			assert.equal(command, "git");
			return runGit(arguments_, options.cwd);
		},
		on() {},
		registerCommand(name, command) {
			if (name === "worktree") worktreeCommand = command;
		},
		registerFlag() {},
		registerTool() {},
	});
	assert.ok(worktreeCommand);

	let switchedCwd;
	let targetSessionDirectory;
	await worktreeCommand.handler("command-worktree --base main", {
		cwd: repositoryRoot,
		sessionManager: sourceSession,
		switchSession: async (sessionFile, options) => {
			const targetSession = SessionManager.open(sessionFile);
			switchedCwd = targetSession.getCwd();
			targetSessionDirectory = dirname(sessionFile);
			await options.withSession({
				ui: { notify: (message, type) => notifications.push({ message, type }) },
			});
			return { cancelled: false };
		},
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	});
	context.after(() => rm(targetSessionDirectory, { force: true, recursive: true }));

	assert.equal(switchedCwd, `${repositoryRoot}/.agents/worktrees/command-worktree`);
	assert.deepEqual(notifications, []);
	notifications.push({ message: "Resumed session", type: "info" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(notifications.at(-1), {
		message: `Created worktree: ${repositoryRoot}/.agents/worktrees/command-worktree`,
		type: "info",
	});
	assert.equal(await runGitSuccessfully(["rev-parse", "HEAD"], switchedCwd), baseCommit);
});

test("the slash command can continue the agent after switching sessions", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	await runGitSuccessfully(["switch", "-c", "current-branch"], repositoryRoot);
	const sourceSession = SessionManager.create(repositoryRoot, join(repositoryRoot, ".sessions"));
	let worktreeCommand;
	let kickoffMessage;

	worktreeExtension({
		exec(command, arguments_, options) {
			assert.equal(command, "git");
			return runGit(arguments_, options.cwd);
		},
		on() {},
		registerCommand(name, command) {
			if (name === "worktree") worktreeCommand = command;
		},
		registerFlag() {},
		registerTool() {},
	});
	assert.ok(worktreeCommand);

	let targetSessionDirectory;
	await worktreeCommand.handler("continued-worktree --continue", {
		cwd: repositoryRoot,
		sessionManager: sourceSession,
		switchSession: async (sessionFile, options) => {
			targetSessionDirectory = dirname(sessionFile);
			await options.withSession({
				ui: { notify() {} },
				sendUserMessage: async (message) => {
					kickoffMessage = message;
				},
			});
			return { cancelled: false };
		},
		ui: { notify() {} },
	});
	context.after(() => rm(targetSessionDirectory, { force: true, recursive: true }));

	assert.equal(kickoffMessage, "Continue working on the task in this worktree.");
});

async function assertWorktreeToolSwitch(context, reuseExisting) {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const targetPath = join(repositoryRoot, ".agents/worktrees", reuseExisting ? "original-branch" : "tool-worktree");
	if (reuseExisting)
		await runGitSuccessfully(["worktree", "add", "-b", "tool-worktree", targetPath, "main"], repositoryRoot);
	const sentMessages = [];
	let switchedCwd;
	let agentSettledHandler;
	let kickoffMessage;
	let targetSessionDirectory;
	let worktreeCommand;
	let worktreeTool;
	const sourceSession = SessionManager.create(repositoryRoot, join(repositoryRoot, ".sessions", "source"));
	const commandContext = {
		cwd: repositoryRoot,
		sessionManager: sourceSession,
		switchSession: async (sessionFile, options) => {
			switchedCwd = SessionManager.open(sessionFile).getCwd();
			targetSessionDirectory = dirname(sessionFile);
			await options.withSession({
				ui: { notify() {} },
				sendUserMessage: async (message) => {
					kickoffMessage = message;
				},
			});
			return { cancelled: false };
		},
		ui: { notify() {} },
	};

	worktreeExtension({
		exec(command, arguments_, options) {
			assert.equal(command, "git");
			return runGit(arguments_, options.cwd);
		},
		on(event, handler) {
			if (event === "agent_settled") agentSettledHandler = handler;
		},
		registerCommand(name, command) {
			if (name === "worktree") worktreeCommand = command;
		},
		registerFlag() {},
		registerTool(tool) {
			if (tool.name === "worktree_switch") worktreeTool = tool;
		},
		sendUserMessage(content, options) {
			sentMessages.push({ content, options });
			return worktreeCommand.handler(content.slice("/worktree ".length), commandContext);
		},
	});
	assert.ok(worktreeCommand);
	assert.ok(worktreeTool);
	assert.ok(agentSettledHandler);

	const result = await worktreeTool.execute(
		"tool-call",
		{ branch: "tool-worktree", baseBranch: "main" },
		undefined,
		undefined,
		{ cwd: repositoryRoot, ui: { notify() {} } },
	);

	assert.equal(result.terminate, true);
	assert.equal(
		result.content[0].text,
		`Queued a switch to worktree ${targetPath}. Pi will continue in that worktree after this turn.`,
	);
	assert.deepEqual(sentMessages, []);

	await agentSettledHandler();
	assert.deepEqual(sentMessages, [
		{
			content: "/worktree tool-worktree --base main --continue",
			options: { expandPromptTemplates: true },
		},
	]);
	assert.equal(kickoffMessage, "Continue working on the task in this worktree.");
	context.after(() => rm(targetSessionDirectory, { force: true, recursive: true }));
	assert.equal(switchedCwd, targetPath);
	assert.deepEqual(result.details, { branch: "tool-worktree", created: !reuseExisting, path: targetPath });
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], targetPath), "tool-worktree");
}

for (const reuseExisting of [false, true]) {
	const worktreeKind = reuseExisting ? "differently named existing" : "new";
	test(`the worktree tool queues a ${worktreeKind} worktree switch until the agent settles`, async (context) => {
		await assertWorktreeToolSwitch(context, reuseExisting);
	});
}

test("reuses the requested worktree idempotently", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));

	await ensureWorktree("existing-worktree", repositoryRoot, runGit);
	const result = await ensureWorktree("existing-worktree", repositoryRoot, runGit);

	assert.equal(result.created, false);
	assert.equal(result.path, `${repositoryRoot}/.agents/worktrees/existing-worktree`);
});

test("reuses a dirty worktree after switching to a stacked branch without moving it", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const original = await ensureWorktree("stack-base", repositoryRoot, runGit);
	await runGitSuccessfully(["switch", "-c", "stack-top"], original.path);
	const stagedPath = join(original.path, "staged.txt");
	const untrackedPath = join(original.path, "untracked.txt");
	await writeFile(stagedPath, "staged work\n");
	await runGitSuccessfully(["add", "staged.txt"], original.path);
	await writeFile(stagedPath, "unstaged work\n");
	await writeFile(untrackedPath, "untracked work\n");
	const beforeStatus = await runGitSuccessfully(["status", "--porcelain"], original.path);
	const beforeWorktrees = await runGitSuccessfully(["worktree", "list", "--porcelain"], repositoryRoot);
	const beforeCommit = await runGitSuccessfully(["rev-parse", "HEAD"], original.path);

	const result = await ensureWorktree("stack-top", repositoryRoot, runGit);

	assert.deepEqual(result, { branch: "stack-top", created: false, path: original.path });
	assert.equal(await runGitSuccessfully(["status", "--porcelain"], original.path), beforeStatus);
	assert.equal(await runGitSuccessfully(["worktree", "list", "--porcelain"], repositoryRoot), beforeWorktrees);
	assert.equal(await runGitSuccessfully(["rev-parse", "HEAD"], original.path), beforeCommit);
	assert.equal(await runGitSuccessfully(["show", ":staged.txt"], original.path), "staged work");
	assert.equal(await readFile(stagedPath, "utf8"), "unstaged work\n");
	assert.equal(await readFile(untrackedPath, "utf8"), "untracked work\n");
});

test("prefers the checked-out branch over an occupied conventional path", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const branchPath = join(repositoryRoot, "custom worktrees", "actual checkout");
	const conventionalPath = join(repositoryRoot, ".agents/worktrees/requested-branch");
	await runGitSuccessfully(["worktree", "add", "-b", "requested-branch", branchPath, "main"], repositoryRoot);
	await runGitSuccessfully(["worktree", "add", "-b", "other-branch", conventionalPath, "main"], repositoryRoot);

	const result = await ensureWorktree("requested-branch", conventionalPath, runGit);

	assert.deepEqual(result, { branch: "requested-branch", created: false, path: branchPath });
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], conventionalPath), "other-branch");
});

test("can return to the main checkout and reuse the current checkout", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const worktree = await ensureWorktree("feature", repositoryRoot, runGit);

	assert.deepEqual(await ensureWorktree("main", worktree.path, runGit), {
		branch: "main", created: false, path: repositoryRoot,
	});
	assert.deepEqual(await ensureWorktree("main", repositoryRoot, runGit), {
		branch: "main", created: false, path: repositoryRoot,
	});
});

test("rejects a locked worktree with a missing directory", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const targetPath = join(repositoryRoot, "custom-checkout");
	await runGitSuccessfully(["worktree", "add", "-b", "missing", targetPath, "main"], repositoryRoot);
	await runGitSuccessfully(["worktree", "lock", targetPath], repositoryRoot);
	await rm(targetPath, { force: true, recursive: true });

	await assert.rejects(
		ensureWorktree("missing", repositoryRoot, runGit),
		/registered with Git but its directory does not exist/,
	);
});

test("recreates a worktree whose directory was deleted", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const firstResult = await ensureWorktree("deleted-worktree", repositoryRoot, runGit);
	await rm(firstResult.path, { force: true, recursive: true });

	const result = await ensureWorktree("deleted-worktree", repositoryRoot, runGit);

	assert.equal(result.created, true);
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], result.path), "deleted-worktree");
});

test("uses an existing branch when creating the worktree", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	await runGitSuccessfully(["branch", "existing-branch", "main"], repositoryRoot);

	const result = await ensureWorktree("existing-branch", repositoryRoot, runGit);

	assert.equal(result.created, true);
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], result.path), "existing-branch");
});

test("rejects a target path occupied by another branch", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const targetPath = `${repositoryRoot}/.agents/worktrees/requested-branch`;
	await runGitSuccessfully(["worktree", "add", "-b", "other-branch", targetPath, "main"], repositoryRoot);

	await assert.rejects(
		ensureWorktree("requested-branch", repositoryRoot, runGit),
		/already checked out on branch other-branch/,
	);
});

test("resumes a session when its worktree has switched branches", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
	const targetPath = `${repositoryRoot}/.agents/worktrees/original-branch`;
	await runGitSuccessfully(["worktree", "add", "-b", "current-branch", targetPath, "main"], repositoryRoot);

	const result = await ensureWorktree("original-branch", repositoryRoot, runGit, undefined, true);

	assert.equal(result.created, false);
	assert.equal(result.path, targetPath);
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], targetPath), "current-branch");
});

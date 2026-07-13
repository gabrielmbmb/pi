import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import worktreeExtension, {
	createWorktreeSession,
	ensureWorktree,
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
			"prompt",
			"--worktree=ignored-duplicate",
		]),
		["--model", "gpt-5", "prompt"],
	);
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
	let sessionStartHandler;

	worktreeExtension({
		exec(command, arguments_, options) {
			assert.equal(command, "git");
			return runGit(arguments_, options.cwd);
		},
		getFlag(name) {
			return name === "worktree" ? "tui-worktree" : undefined;
		},
		on(event, handler) {
			if (event === "session_start") sessionStartHandler = handler;
		},
		registerCommand() {},
		registerFlag() {},
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
	assert.equal(
		await runGitSuccessfully(
			["branch", "--show-current"],
			`${repositoryRoot}/.agents/worktrees/tui-worktree`,
		),
		"tui-worktree",
	);
});

test("the slash command switches Pi to a session in the worktree", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
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
	});
	assert.ok(worktreeCommand);

	let switchedCwd;
	let targetSessionDirectory;
	await worktreeCommand.handler("command-worktree", {
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
});

test("reuses the requested worktree idempotently", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));

	await ensureWorktree("existing-worktree", repositoryRoot, runGit);
	const result = await ensureWorktree("existing-worktree", repositoryRoot, runGit);

	assert.equal(result.created, false);
	assert.equal(result.path, `${repositoryRoot}/.agents/worktrees/existing-worktree`);
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

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureWorktree } from "../extensions/worktree.ts";

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

test("creates a branch and nested worktree from main", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));

	const result = await ensureWorktree("feature/example", repositoryRoot, runGit);

	assert.equal(result.created, true);
	assert.equal(result.path, `${repositoryRoot}/.agents/worktrees/feature/example`);
	assert.equal(await runGitSuccessfully(["branch", "--show-current"], result.path), "feature/example");
});

test("reuses the requested worktree idempotently", async (context) => {
	const repositoryRoot = await createRepository();
	context.after(() => rm(repositoryRoot, { force: true, recursive: true }));

	await ensureWorktree("existing-worktree", repositoryRoot, runGit);
	const result = await ensureWorktree("existing-worktree", repositoryRoot, runGit);

	assert.equal(result.created, false);
	assert.equal(result.path, `${repositoryRoot}/.agents/worktrees/existing-worktree`);
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

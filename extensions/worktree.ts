import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_BRANCH = "main";
const WORKTREE_DIRECTORY = ".agents/worktrees";
const GIT_COMMAND_TIMEOUT_MILLISECONDS = 30_000;

type GitRunner = (arguments_: string[], cwd: string) => Promise<ExecResult>;

interface WorktreeRecord {
  path: string;
  branch?: string;
}

export interface WorktreeResult {
  branch: string;
  created: boolean;
  path: string;
}

function gitFailure(arguments_: string[], result: ExecResult): Error {
  const output = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`git ${arguments_.join(" ")} failed: ${output}`);
}

async function runGit(gitRunner: GitRunner, arguments_: string[], cwd: string): Promise<string> {
  const result = await gitRunner(arguments_, cwd);
  if (result.code !== 0) {
    throw gitFailure(arguments_, result);
  }
  return result.stdout.trim();
}

function parseWorktrees(output: string): WorktreeRecord[] {
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0");
      const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
      const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch refs/heads/".length);
      if (!path) {
        throw new Error("Git returned a worktree record without a path");
      }
      return { path, branch };
    });
}

async function localBranchExists(gitRunner: GitRunner, branch: string, repositoryRoot: string): Promise<boolean> {
  const arguments_ = ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`];
  const result = await gitRunner(arguments_, repositoryRoot);
  if (result.code === 0) {
    return true;
  }
  if (result.code === 1) {
    return false;
  }
  throw gitFailure(arguments_, result);
}

async function validateBranchName(gitRunner: GitRunner, branch: string, repositoryRoot: string): Promise<void> {
  if (!branch) {
    throw new Error("--worktree requires a non-empty branch name");
  }
  await runGit(gitRunner, ["check-ref-format", "--branch", branch], repositoryRoot);
}

export async function ensureWorktree(
  branch: string,
  cwd: string,
  gitRunner: GitRunner,
): Promise<WorktreeResult> {
  const repositoryRoot = await runGit(gitRunner, ["rev-parse", "--show-toplevel"], cwd);
  await validateBranchName(gitRunner, branch, repositoryRoot);

  const targetPath = `${repositoryRoot}/${WORKTREE_DIRECTORY}/${branch}`;
  const worktreeOutput = await runGit(gitRunner, ["worktree", "list", "--porcelain", "-z"], repositoryRoot);
  const worktrees = parseWorktrees(worktreeOutput);
  const targetWorktree = worktrees.find((worktree) => worktree.path === targetPath);

  if (targetWorktree) {
    if (targetWorktree.branch !== branch) {
      throw new Error(
        `Worktree path ${targetPath} is already checked out on branch ${targetWorktree.branch ?? "detached HEAD"}`,
      );
    }
    return { branch, created: false, path: targetPath };
  }

  const branchWorktree = worktrees.find((worktree) => worktree.branch === branch);
  if (branchWorktree) {
    throw new Error(`Branch ${branch} is already checked out at ${branchWorktree.path}`);
  }

  const branchExists = await localBranchExists(gitRunner, branch, repositoryRoot);
  if (branchExists) {
    await runGit(gitRunner, ["worktree", "add", targetPath, branch], repositoryRoot);
  } else {
    if (!(await localBranchExists(gitRunner, BASE_BRANCH, repositoryRoot))) {
      throw new Error(`Base branch ${BASE_BRANCH} does not exist`);
    }
    await runGit(gitRunner, ["worktree", "add", "-b", branch, targetPath, BASE_BRANCH], repositoryRoot);
  }

  return { branch, created: true, path: targetPath };
}

export default function worktreeExtension(pi: ExtensionAPI) {
  pi.registerFlag("worktree", {
    description: `Create a Git worktree and branch from ${BASE_BRANCH}`,
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const branch = pi.getFlag("worktree");
    if (typeof branch !== "string") return;

    const gitRunner: GitRunner = (arguments_, cwd) =>
      pi.exec("git", arguments_, { cwd, timeout: GIT_COMMAND_TIMEOUT_MILLISECONDS });

    try {
      const result = await ensureWorktree(branch, ctx.cwd, gitRunner);
      const action = result.created ? "Created" : "Using existing";
      ctx.ui.notify(`${action} worktree: ${result.path}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Unable to prepare worktree: ${message}`, "error");
      throw error;
    }
  });
}

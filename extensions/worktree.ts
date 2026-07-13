import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";

import {
  SessionManager,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

export function removeWorktreeArguments(arguments_: readonly string[]): string[] {
  const remainingArguments: string[] = [];

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--worktree") {
      index++;
      continue;
    }
    if (argument.startsWith("--worktree=")) continue;
    remainingArguments.push(argument);
  }

  return remainingArguments;
}

export function createWorktreeSession(
  worktreePath: string,
  sourceSessionFile?: string,
  sessionDirectory?: string,
): string {
  const sourceSessionIsPersisted =
    sourceSessionFile && existsSync(sourceSessionFile) && statSync(sourceSessionFile).size > 0;
  const sessionManager = sourceSessionIsPersisted
    ? SessionManager.forkFrom(sourceSessionFile, worktreePath, sessionDirectory)
    : SessionManager.create(worktreePath, sessionDirectory);
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error(`Unable to create a session in ${worktreePath}`);

  if (!sourceSessionIsPersisted) {
    const header = sessionManager.getHeader();
    if (!header) throw new Error(`Unable to create a session header in ${worktreePath}`);
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
  }

  return sessionFile;
}

function runPiInWorktree(worktreePath: string): Promise<number> {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("Unable to determine the Pi CLI entrypoint");

  const arguments_ = [entrypoint, ...removeWorktreeArguments(process.argv.slice(2))];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: worktreePath,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function gitFailure(arguments_: string[], result: ExecResult): Error {
  const output = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`git ${arguments_.join(" ")} failed: ${output}`);
}

async function runGit(gitRunner: GitRunner, arguments_: string[], cwd: string): Promise<string> {
  const result = await gitRunner(arguments_, cwd);
  if (result.code !== 0) throw gitFailure(arguments_, result);
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
      if (!path) throw new Error("Git returned a worktree record without a path");
      return { path, branch };
    });
}

async function localBranchExists(gitRunner: GitRunner, branch: string, repositoryRoot: string): Promise<boolean> {
  const arguments_ = ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`];
  const result = await gitRunner(arguments_, repositoryRoot);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw gitFailure(arguments_, result);
}

async function validateBranchName(gitRunner: GitRunner, branch: string, repositoryRoot: string): Promise<void> {
  if (!branch) throw new Error("--worktree requires a non-empty branch name");
  await runGit(gitRunner, ["check-ref-format", "--branch", branch], repositoryRoot);
}

async function getCurrentBranch(gitRunner: GitRunner, repositoryRoot: string): Promise<string> {
  const branch = await runGit(gitRunner, ["branch", "--show-current"], repositoryRoot);
  if (!branch) throw new Error("Cannot create a worktree from a detached HEAD");
  return branch;
}

export async function ensureWorktree(
  branch: string,
  cwd: string,
  gitRunner: GitRunner,
): Promise<WorktreeResult> {
  const currentWorktreeRoot = await runGit(gitRunner, ["rev-parse", "--show-toplevel"], cwd);
  await validateBranchName(gitRunner, branch, currentWorktreeRoot);
  await runGit(gitRunner, ["worktree", "prune", "--expire", "now"], currentWorktreeRoot);

  const worktreeOutput = await runGit(
    gitRunner,
    ["worktree", "list", "--porcelain", "-z"],
    currentWorktreeRoot,
  );
  const worktrees = parseWorktrees(worktreeOutput);
  const repositoryRoot = worktrees[0]?.path;
  if (!repositoryRoot) throw new Error("Git returned no worktrees");
  const targetPath = `${repositoryRoot}/${WORKTREE_DIRECTORY}/${branch}`;
  const targetWorktree = worktrees.find((worktree) => worktree.path === targetPath);

  if (targetWorktree) {
    if (!existsSync(targetPath))
      throw new Error(`Worktree ${targetPath} is registered with Git but its directory does not exist`);
    if (targetWorktree.branch !== branch)
      throw new Error(
        `Worktree path ${targetPath} is already checked out on branch ${targetWorktree.branch ?? "detached HEAD"}`,
      );
    return { branch, created: false, path: targetPath };
  }

  const branchWorktree = worktrees.find((worktree) => worktree.branch === branch);
  if (branchWorktree) throw new Error(`Branch ${branch} is already checked out at ${branchWorktree.path}`);

  const branchExists = await localBranchExists(gitRunner, branch, repositoryRoot);
  if (branchExists) await runGit(gitRunner, ["worktree", "add", targetPath, branch], repositoryRoot);
  else {
    const baseBranch = await getCurrentBranch(gitRunner, currentWorktreeRoot);
    if (!(await localBranchExists(gitRunner, baseBranch, repositoryRoot)))
      throw new Error(`Current branch ${baseBranch} has no commits`);
    await runGit(gitRunner, ["worktree", "add", "-b", branch, targetPath, baseBranch], repositoryRoot);
  }

  return { branch, created: true, path: targetPath };
}

export default function worktreeExtension(pi: ExtensionAPI) {
  pi.registerFlag("worktree", {
    description: "Start Pi in a Git worktree created from the current branch",
    type: "string",
  });

  const gitRunner: GitRunner = (arguments_, cwd) =>
    pi.exec("git", arguments_, { cwd, timeout: GIT_COMMAND_TIMEOUT_MILLISECONDS });
  let pendingRelaunchPath: string | undefined;

  const prepareWorktree = async (branch: string, ctx: ExtensionContext): Promise<WorktreeResult> => {
    try {
      return await ensureWorktree(branch, ctx.cwd, gitRunner);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Unable to prepare worktree: ${message}`, "error");
      throw error;
    }
  };

  const switchToWorktree = async (
    branch: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const result = await prepareWorktree(branch, ctx);
    const sourceSessionFile = ctx.sessionManager.getSessionFile();
    const targetSessionFile = createWorktreeSession(result.path, sourceSessionFile);
    const action = result.created ? "Created" : "Using existing";
    const switchResult = await ctx.switchSession(targetSessionFile, {
      withSession: async (replacementContext) => {
        // Pi reports every switchSession call as "Resumed session" after this callback returns.
        setTimeout(() => {
          replacementContext.ui.notify(`${action} worktree: ${result.path}`, "info");
        }, 0);
      },
    });

    if (switchResult.cancelled)
      ctx.ui.notify(`${action} worktree, but the session switch was cancelled: ${result.path}`, "warning");
  };

  pi.on("session_start", async (event, ctx) => {
    const branch = pi.getFlag("worktree");
    if (event.reason !== "startup" || typeof branch !== "string") return;

    const result = await prepareWorktree(branch, ctx);
    if (ctx.mode === "tui" || ctx.mode === "rpc") {
      // Release Pi's terminal input and restore cooked mode before the child inherits the TTY.
      pendingRelaunchPath = result.path;
      ctx.shutdown();
      return;
    }

    const exitCode = await runPiInWorktree(result.path);
    process.exit(exitCode);
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "quit" || !pendingRelaunchPath) return;
    const worktreePath = pendingRelaunchPath;
    pendingRelaunchPath = undefined;
    await runPiInWorktree(worktreePath);
  });

  pi.registerCommand("worktree", {
    description: "Create or switch to a Git worktree from the current branch",
    handler: async (arguments_, ctx) => {
      const branch = arguments_.trim();
      if (!branch) {
        ctx.ui.notify("Usage: /worktree <name>", "warning");
        return;
      }
      await switchToWorktree(branch, ctx);
    },
  });
}

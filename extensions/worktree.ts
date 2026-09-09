import { spawn, type ChildProcess } from "node:child_process";
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

interface WorktreeCommandArguments {
  baseBranch?: string;
  branch: string;
}

export interface WorktreeResult {
  branch: string;
  created: boolean;
  path: string;
}

export function removeWorktreeArguments(
  arguments_: readonly string[],
  worktreeSession?: string,
): string[] {
  const remainingArguments: string[] = [];

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (
      argument === "--worktree" ||
      argument === "--worktree-base" ||
      argument === "--worktree-session" ||
      (worktreeSession !== undefined && argument === "--session")
    ) {
      index++;
      continue;
    }
    if (
      argument.startsWith("--worktree=") ||
      argument.startsWith("--worktree-base=") ||
      argument.startsWith("--worktree-session=") ||
      (worktreeSession !== undefined && argument.startsWith("--session="))
    )
      continue;
    remainingArguments.push(argument);
  }

  if (worktreeSession !== undefined)
    remainingArguments.unshift("--session", worktreeSession);
  return remainingArguments;
}

function readCliFlag(arguments_: readonly string[], name: string): string | undefined {
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === name) {
      const value = arguments_[index + 1];
      return value && !value.startsWith("-") ? value : undefined;
    }
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  }
  return undefined;
}

export function parseLaunchFlags(arguments_: readonly string[]): {
  branch?: string;
  baseBranch?: string;
  worktreeSession?: string;
} {
  return {
    branch: readCliFlag(arguments_, "--worktree"),
    baseBranch: readCliFlag(arguments_, "--worktree-base"),
    worktreeSession: readCliFlag(arguments_, "--worktree-session"),
  };
}

export function parseWorktreeCommandArguments(arguments_: string): WorktreeCommandArguments {
  const tokens = arguments_.trim() ? arguments_.trim().split(/\s+/) : [];
  let baseBranch: string | undefined;
  let branch: string | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--base") {
      const value = tokens[++index];
      if (!value || value.startsWith("--") || baseBranch)
        throw new Error("Usage: /worktree <name> [--base <branch>]");
      baseBranch = value;
      continue;
    }
    if (token.startsWith("--base=")) {
      const value = token.slice("--base=".length);
      if (!value || baseBranch) throw new Error("Usage: /worktree <name> [--base <branch>]");
      baseBranch = value;
      continue;
    }
    if (token.startsWith("-") || branch)
      throw new Error("Usage: /worktree <name> [--base <branch>]");
    branch = token;
  }

  if (!branch) throw new Error("Usage: /worktree <name> [--base <branch>]");
  return { baseBranch, branch };
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

function spawnPiInWorktree(worktreePath: string, worktreeSession?: string): ChildProcess {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("Unable to determine the Pi CLI entrypoint");

  const arguments_ = [
    entrypoint,
    ...removeWorktreeArguments(process.argv.slice(2), worktreeSession),
  ];
  return spawn(process.execPath, arguments_, {
    cwd: worktreePath,
    env: process.env,
    stdio: "inherit",
  });
}

function waitForPi(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function runPiInWorktree(worktreePath: string, worktreeSession?: string): Promise<number> {
  // The parent's TUI leaves its rendered frame on the terminal when it shuts
  // down, and Pi's first render assumes a clean screen (it does not clear).
  // Without this, the relaunched worktree session paints below the parent's
  // leftover frame, stacking two Pi UIs on top of one another.
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
  return waitForPi(spawnPiInWorktree(worktreePath, worktreeSession));
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
  requestedBaseBranch?: string,
  allowBranchMismatch = false,
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
    if (targetWorktree.branch !== branch && !allowBranchMismatch)
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
    const baseBranch = requestedBaseBranch ?? (await getCurrentBranch(gitRunner, currentWorktreeRoot));
    await validateBranchName(gitRunner, baseBranch, repositoryRoot);
    if (!(await localBranchExists(gitRunner, baseBranch, repositoryRoot))) {
      if (requestedBaseBranch !== undefined)
        throw new Error(`Base branch ${baseBranch} does not exist or has no commits`);
      throw new Error(`Current branch ${baseBranch} has no commits`);
    }
    await runGit(gitRunner, ["worktree", "add", "-b", branch, targetPath, baseBranch], repositoryRoot);
  }

  return { branch, created: true, path: targetPath };
}

export default async function worktreeExtension(pi: ExtensionAPI) {
  pi.registerFlag("worktree", {
    description: "Start Pi in a Git worktree",
    type: "string",
  });
  pi.registerFlag("worktree-base", {
    description: "Branch from which to create a new worktree branch",
    type: "string",
  });
  pi.registerFlag("worktree-session", {
    description: "Resume a session after starting Pi in the worktree",
    type: "string",
  });

  const gitRunner: GitRunner = (arguments_, cwd) =>
    pi.exec("git", arguments_, { cwd, timeout: GIT_COMMAND_TIMEOUT_MILLISECONDS });

  // Start Pi directly in the worktree instead of flashing the parent session
  // first. Extension flag values are only populated after all extensions load,
  // so read the CLI arguments here at factory time, before Pi's TUI paints its
  // first frame in the original directory. Interactive sessions have TTY stdin
  // and stdout, so that also excludes RPC (stdio pipes) and piped print runs.
  const launchFlags = parseLaunchFlags(process.argv.slice(2));
  if (typeof launchFlags.branch === "string" && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const result = await ensureWorktree(
        launchFlags.branch,
        process.cwd(),
        gitRunner,
        launchFlags.baseBranch,
        launchFlags.worktreeSession !== undefined,
      );
      // Keep the bootstrap process alive until the child exits. The child
      // shares the parent's foreground process group; exiting immediately
      // would orphan that group and make the child's terminal ioctls fail
      // with EIO when the shell reclaims the terminal.
      const exitCode = await waitForPi(spawnPiInWorktree(result.path, launchFlags.worktreeSession));
      process.exit(exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to start Pi in worktree: ${message}`);
      process.exit(1);
    }
  }

  let pendingRelaunch: { path: string; session?: string } | undefined;

  const prepareWorktree = async (
    branch: string,
    ctx: ExtensionContext,
    baseBranch?: string,
    allowBranchMismatch = false,
  ): Promise<WorktreeResult> => {
    try {
      return await ensureWorktree(branch, ctx.cwd, gitRunner, baseBranch, allowBranchMismatch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Unable to prepare worktree: ${message}`, "error");
      throw error;
    }
  };

  const switchToWorktree = async (
    branch: string,
    ctx: ExtensionCommandContext,
    baseBranch?: string,
  ): Promise<void> => {
    const result = await prepareWorktree(branch, ctx, baseBranch);
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
    const baseBranch = pi.getFlag("worktree-base");
    const worktreeSession = pi.getFlag("worktree-session");

    const session = typeof worktreeSession === "string" ? worktreeSession : undefined;
    const result = await prepareWorktree(
      branch,
      ctx,
      typeof baseBranch === "string" ? baseBranch : undefined,
      session !== undefined,
    );
    if (ctx.mode === "tui" || ctx.mode === "rpc") {
      // Release Pi's terminal input and restore cooked mode before the child inherits the TTY.
      pendingRelaunch = { path: result.path, session };
      ctx.shutdown();
      return;
    }

    const exitCode = await runPiInWorktree(result.path, session);
    process.exit(exitCode);
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "quit" || !pendingRelaunch) return;
    const relaunch = pendingRelaunch;
    pendingRelaunch = undefined;
    await runPiInWorktree(relaunch.path, relaunch.session);
  });

  pi.registerCommand("worktree", {
    description: "Create or switch to a Git worktree",
    handler: async (arguments_, ctx) => {
      let parsedArguments: WorktreeCommandArguments;
      try {
        parsedArguments = parseWorktreeCommandArguments(arguments_);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      await switchToWorktree(parsedArguments.branch, ctx, parsedArguments.baseBranch);
    },
  });
}

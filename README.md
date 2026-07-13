# Pi Extensions Workspace

A pnpm workspace of independently installable Pi extension packages.

## Packages

| Package | Description |
| --- | --- |
| [`@gabrielmbmb/pi-worktree`](packages/worktree) | Creates or reuses `.agents/worktrees/<name>` from the current checkout branch, then starts or switches Pi to it via `--worktree <name>` or `/worktree <name>`. |

Each package owns its extension source, tests, Pi manifest, and release metadata. See the package README for installation and usage.

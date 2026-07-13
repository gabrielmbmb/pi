# @gabrielmbmb/pi-worktree

Pi extension that creates or reuses `.agents/worktrees/<name>` from the current checkout branch and starts or switches Pi to that worktree.

## Install

Once published to npm:

```bash
pi install npm:@gabrielmbmb/pi-worktree
```

From a local checkout of this workspace:

```bash
pi install ./packages/worktree
```

## Usage

Start Pi in a worktree:

```bash
pi --worktree my-worktree
```

Switch the current Pi session to a worktree:

```text
/worktree my-worktree
```

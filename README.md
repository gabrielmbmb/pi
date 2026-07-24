# Pi Resources

Personal extensions, skills, prompts, and themes for Pi.

## Install

Install the repository as one Pi package:

```bash
pi install git:github.com/gabrielmbmb/pi
```

Pi clones the package once. To load only selected resources, run `pi config` and disable the extensions you do not want. The equivalent package filter in `~/.pi/agent/settings.json` is:

```json
{
  "packages": [
    {
      "source": "git:github.com/gabrielmbmb/pi",
      "extensions": ["extensions/banner.ts", "extensions/worktree.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Extensions

| Extension | Description |
| --- | --- |
| [`banner`](extensions/banner.ts) | Replaces Pi's startup header with an animated rainbow `Pi` banner, loaded-extension names, and loaded context files. |
| [`usage-monitor`](extensions/usage-monitor/index.ts) | Shows provider usage / balance below the prompt line. OpenRouter support included; extensible for other providers. |
| [`worktree`](extensions/worktree.ts) | Creates or reuses `.agents/worktrees/<name>` from the current branch or a selected base via `--worktree <name> --worktree-base <branch>` or `/worktree <name> --base <branch>`, then starts or switches Pi to it. Resume a worktree session from another checkout with `--worktree <name> --worktree-session <session-id>`. |

The banner expects Pi's native startup listing to be disabled with `"quietStartup": true` in `~/.pi/agent/settings.json` (or via `/settings`).

## Prompts

| Prompt | Description |
| --- | --- |
| [`subagent`](prompts/subagent.md) | Self-spawns an isolated `pi` subprocess to own a task end-to-end, asking for model/reasoning if omitted, e.g. `/subagent --model sonnet --reasoning high check the PR review and address the comments`. |

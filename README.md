# Pi Resources

Personal Pi extensions, skills, prompts, and themes.

## Install

```bash
pi install git:github.com/gabrielmbmb/pi
```

Use `pi config` to enable only the resources you want.

## Extensions

| Extension | Description |
| --- | --- |
| [`background-bash`](extensions/background-bash/index.ts) | Adds `background:true` to `bash`, private output logs, completion messages, `bash_kill`, and `/bg` task management. |
| [`banner`](extensions/banner.ts) | Replaces Pi's startup header with an animated rainbow `Pi` banner. |
| [`usage-monitor`](extensions/usage-monitor/index.ts) | Shows provider usage / balance below the prompt line. |
| [`vi-mode`](extensions/vi-mode/index.ts) | Vim-style prompt editing. See the [shortcut guide](extensions/vi-mode/README.md). |
| [`worktree`](extensions/worktree.ts) | Creates or reuses Git worktrees and switches Pi into them via flags, `/worktree`, or `worktree_switch`. |

The banner expects `"quietStartup": true` in `~/.pi/agent/settings.json`.

## Prompts

No prompt templates are currently included.

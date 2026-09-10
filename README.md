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
| [`usage-monitor`](extensions/usage-monitor/index.ts) | Shows provider usage / balance below the prompt line. Supports OpenRouter, OpenAI Codex, and OpenCode Go (5h / weekly / monthly quota windows). |
| [`subagents`](extensions/subagents/index.ts) | Delegates self-contained tasks to in-process subagents with parallel spawning, context seeding, model routing, collection, cancellation, and nested delegation. Includes a live `/subagents` tree-and-preview picker, Pi-native conversation views with tool cards and edit diffs, retained history, and confirmed subtree cancellation. See the [inspector guide](extensions/subagents/README.md). |
| [`vi-mode`](extensions/vi-mode/index.ts) | Adds Insert, Normal, character-wise Visual, and line-wise Visual prompt editing with Vim motions, operators, text objects, counts, registers, undo/redo, and a Pi-aware Ex command bridge. See the [shortcut guide](extensions/vi-mode/README.md). |
| [`worktree`](extensions/worktree.ts) | Creates or reuses `.agents/worktrees/<name>` from the current branch or a selected base via `--worktree <name> --worktree-base <branch>`, `/worktree <name> --base <branch>`, or the model-callable `worktree_switch` tool, then starts or switches Pi to it. Resume a worktree session from another checkout with `--worktree <name> --worktree-session <session-id>`. |

The banner expects Pi's native startup listing to be disabled with `"quietStartup": true` in `~/.pi/agent/settings.json` (or via `/settings`).

## Prompts

No prompt templates are currently included.

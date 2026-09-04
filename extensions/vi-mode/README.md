# Vi mode

Modal editing for Pi's prompt, powered by [`pi-vim`](https://github.com/lajarre/pi-vim). The editor starts in **INSERT** mode so normal typing, completion, submission, and Pi shortcuts keep working.

## Quick start

| Goal | Keys |
| --- | --- |
| Enter Normal mode | `Esc` |
| Return to Insert mode | `i`, `a`, `I`, `A`, `o`, or `O` |
| Move | `h` `j` `k` `l`, `w` `b` `e`, `0` `^` `$`, `gg` `G` |
| Select characters / lines | `v` / `V` |
| Delete, change, or yank a selection | `d` / `c` / `y` |
| Delete or change with a motion | `dw`, `d$`, `ciw`, `ci"`, `3dd`, etc. |
| Put, undo, redo, repeat | `p` / `P`, `u`, `Ctrl-r`, `.` |
| Run a Pi command without losing the draft | `:tree`, `:model opus`, etc. |
| Run a shell command without losing the draft | `:!git status` |
| Show the short in-app reference | `/vi-help` |

If autocomplete is open, the first `Esc` closes it and remains in Insert mode; press `Esc` again for Normal mode. In Normal mode, `Esc` is delegated back to Pi, preserving its interrupt behavior.

Character-wise and line-wise Visual modes support motions and counts. The selected span is highlighted with the active theme's selection colors; the `VISUAL` / `V-LINE` label identifies the selection kind.

## Settings

`pi-vim` reads optional `piVim` settings from `~/.pi/agent/settings.json` and `.pi/settings.json`. For example, keep deletes internal instead of mirroring them to the system clipboard, and color the border by mode:

```json
{
  "piVim": {
    "clipboardMirror": "yank",
    "borderSync": {
      "insert": "mode",
      "normal": "mode",
      "visual": "mode",
      "ex": "mode"
    }
  }
}
```

See the [upstream reference](https://github.com/lajarre/pi-vim#full-reference) for all motions, operators, text objects, clipboard policies, mode colors, and documented Vim differences.

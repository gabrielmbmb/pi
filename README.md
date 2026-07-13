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
      "extensions": ["extensions/worktree.ts"],
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
| [`worktree`](extensions/worktree.ts) | Creates or reuses `.agents/worktrees/<name>` from the current checkout branch, then starts or switches Pi to it via `--worktree <name>` or `/worktree <name>`. |

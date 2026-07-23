---
description: Delegate a task to an isolated pi subagent by self-spawning a new pi process
argument-hint: "[--model <pattern>] [--reasoning <level>] <task>"
---
The user wants the following task delegated to a subagent (a separate, isolated `pi` process with its own context window):

$@

## Step 1 — Resolve model and reasoning

Parse the user's input for an explicit model and reasoning/thinking level:

- Model: a `--model <pattern>` flag (e.g. `--model sonnet`, `--model openai/gpt-4o`, `--model sonnet:high`). The `:<thinking>` suffix counts as the reasoning level.
- Reasoning: a `--reasoning <level>` flag, where level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

If the user did **not** specify both a model and a reasoning level, ask them using the `ask_question` tool before spawning. Suggest reasonable defaults (e.g. a strong general model with `medium` reasoning) but let them choose. Do not guess silently.

Once a model pattern is known (whether supplied by the user or chosen as a default), resolve it to a concrete, available model before spawning. Run, via the bash tool:

```bash
pi --list-models | grep <pattern>
```

- `pi --list-models` prints every configured model with its exact provider/model ID. Pipe it through `grep` (use `grep -i` for case-insensitive, or a more specific pattern as needed) to filter for the requested model.
- If exactly one model matches, use that exact model ID (or the original pattern) in Step 2.
- If multiple models match, pick the most relevant one (prefer an exact or closest ID match) and proceed — you do not need to ask the user to disambiguate unless the matches are genuinely ambiguous or span different providers in a way that matters.
- If **no** models match, report this to the user and ask whether to retry with a different model, log in to the relevant provider, or give up. Do not attempt to spawn with a model that is not configured.

## Step 2 — Self-spawn the subagent

Run a non-interactive `pi` process in the current working directory via the bash tool. Use the resolved model and reasoning level. Example shape:

```bash
pi -p --no-session --model "<pattern>" --thinking <level> "<task>"
```

- Use `-p` (`--print`) so the child runs to completion and prints its response, then exits.
- Use `--no-session` so the child is ephemeral and doesn't pollute session history.
- Pass the task verbatim as the final positional argument (the full `$@` task, minus any `--model`/`--reasoning` flags you consumed in step 1).
- Quote the task and any flag values so shell metacharacters are safe. Prefer a single-quoted heredoc or `printf '%s'` if the task contains quotes or backticks.
- Do **not** add `--approve`/`-a`; let the child inherit the normal project-trust behavior. Only add it if the user explicitly asks to trust project-local resources for the subagent.

## Step 3 — Report back

Once the child exits:

- If it succeeded, summarize what the subagent did (files touched, commands run, key findings) and surface its final output. Do not redo the work yourself.
- If it failed (non-zero exit) or produced an error, report the exit code and the child's stderr/error output verbatim, and ask the user whether to retry, change model/reasoning, or give up. Do not blindly retry.

You are the delegator, not the implementer. Only spawn the subagent, relay its results, and ask clarifying questions — never perform the task in your own context unless the user explicitly tells you to.

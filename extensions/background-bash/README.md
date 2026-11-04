# Background Bash

Adds `background:true` to Pi's `bash` tool:

```ts
bash({ command: "npm test", background: true, description: "run tests" })
```

The call returns a task id and log path immediately. Read the log with `read`; a completion message arrives when the task exits.

- `bash_kill({ task_id })` stops a task.
- `/bg` lists tasks, `/bg stop <id>` stops one, and `/bg path <id>` shows its log.

Logs live at `<agent-dir>/background/<session-id>/<task-id>.log` (`0700` dirs, `0600` files). The default limit is 100 MiB per task; override it with `PI_BACKGROUND_BASH_LOG_LIMIT_BYTES`.

Limits: 8 running / 32 retained tasks, no TTY or stdin, and no persistence across reload or session changes. Do not detach commands with `nohup`, `setsid`, or `&`.

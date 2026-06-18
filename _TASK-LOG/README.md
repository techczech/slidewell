# Task Log

One Markdown file per resumable request. `RESUME.md` = current session entry point.

Use `TEMPLATE.md` for new tasks. Create with:
```bash
python3 _AGENT-INSTRUCTIONS/scripts/new-task.py "Short task title"
```

## Open Tasks

| Task | Status | Next action |
|---|---|---|
| [2026-06-16-compiler-integration.md](2026-06-16-compiler-integration.md) | in-progress | Wire `prepareSource()` from html-presentations into main process IPC; replace client-side strip parse with real compiled HTML |

## Done

| Task | Completed | Result |
|---|---|---|
| Initial scaffold | 2026-06-16 | Electron + React + TS + CodeMirror 6 shell; vault setup; Talk list; editor + slide strip (client-side parse) |

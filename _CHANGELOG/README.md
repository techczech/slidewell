# Changelog

Project history and operational notes for this repository.

## Buckets

- `changes/` — narrative implementation and migration notes
- `decisions/` — durable architecture and policy decisions (ADR-style)
- `phases/` — staged milestones grouping multiple changes (optional)
- `backlog/` — deferred or upcoming work with explicit status; also the
  canonical home for fine-grained executable tickets
- `logs/worklog.jsonl` — append-only log of repeatable pipeline runs
- `INDEX.md` — generated overview of all entries (built by `build_index.py`)

External planning docs such as PRDs, architecture notes, phased plans, or
source ticket packs may live outside `changelog/` in `reports/`, `docs/`, or
another repo-local folder. Link them from backlog, phase, or decision entries
via the optional `artifacts` frontmatter field instead of copying them into a
new changelog bucket.

## Contribution rules

- Every entry file has YAML frontmatter. See
  `~/.claude/skills/project-changelog/references/frontmatter-schema.md`.
- Pick the correct bucket using the routing rules in `AGENTS.md`.
- Backlog items follow a fixed state machine; use
  `close_backlog.py` rather than hand-editing `status: done`.
- The worklog is for one-line JSON summaries only. Never paste warning
  arrays into it.

## Helper scripts

Invoke from the repo root:

```bash
SCRIPTS="$HOME/.claude/skills/project-changelog/scripts"
python3 "$SCRIPTS/new_entry.py" --type <type> --title "..."
python3 "$SCRIPTS/close_backlog.py" <id> --resolved-by <change_id>
python3 "$SCRIPTS/build_index.py"
python3 "$SCRIPTS/import_backlog.py" --source path/to/backlog.md
python3 "$SCRIPTS/archive_done.py" --older-than 90d
python3 "$SCRIPTS/append_worklog.py" --action <a> --status <s> --run-id <id>
```

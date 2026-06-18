# Changelog Agent Guide

Agents writing into `changelog/` must follow these routing rules. Project-
specific overrides can be appended below.

## Routing (deterministic, top-down)

1. Locks a design or policy choice → `decisions/`
2. Something shipped, migrated, or was executed → `changes/`
3. Named milestone grouping multiple entries → `phases/`
4. Not-yet-done work (proposed, active, in-progress, deferred) → `backlog/`
5. One-line summary of a pipeline run → append to `logs/worklog.jsonl`

If multiple apply, earlier bucket wins. If a change also locks a decision,
write both and cross-link via `refs`.

External planning docs such as PRDs, architecture notes, phased plans, and
ticket-source markdown stay outside `changelog/`. Convert executable work into
`backlog/` entries and link the source planning artefacts via `artifacts`.

## Frontmatter

Every entry starts with YAML frontmatter. Required: `title`, `id`, `date`,
`type`, `status`. Status values are type-specific. Full schema lives in the
project-changelog skill under `references/frontmatter-schema.md`.

Backlog entries may also carry optional ticket fields such as `priority`,
`owner`, `depends_on`, and `artifacts`.

## Backlog status is a state machine

Never hand-edit a backlog item to `status: done`. Use:

```bash
python3 "$HOME/.claude/skills/project-changelog/scripts/close_backlog.py" \
  <backlog_id> --resolved-by <change_id>
```

This writes both sides of the ref and stamps `updated`.

To convert a structured markdown backlog or ticket source into canonical
backlog entries, use:

```bash
python3 "$HOME/.claude/skills/project-changelog/scripts/import_backlog.py" \
  --source path/to/backlog.md
```

## Worklog hygiene

- One JSON object per line, ≤ 2 KB
- No warning arrays — use `warning_count` and `warnings_path` instead
- Detailed run artefacts live outside `changelog/`, usually in
  `derived/run-logs/<run_id>/`

## Do not

- Invent a new bucket
- Rewrite old worklog lines
- Put code, generated reports, or chat transcripts in `changelog/`
- Delete entries — archive them with `archive_done.py`

## Project-specific overrides

<!-- Append project-specific rules below this line -->

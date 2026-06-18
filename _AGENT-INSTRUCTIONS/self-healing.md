# Self-Healing

Protocol when the user gives corrective or directive feedback during a task.
Goal: mutate the rules, not accumulate notes.

## First Move

Restate the rule you think the user is asserting. Confirm before editing.

## Classify

- Standing rule for this repo -> `AGENTS.md` or relevant `_AGENT-INSTRUCTIONS/*.md`.
- Standing rule for a skill used here -> that skill's `SKILL.md` (and `HISTORY.md`).
- Project policy / architectural call -> `_CHANGELOG/decisions/` ADR.
- Task-local note -> active `_TASK-LOG/<task>.md`.
- Cannot compress to a rule edit -> fallback note in `_AGENT-INSTRUCTIONS/lessons/` using `TEMPLATE.md`. Revisit and promote or retire later.

Default: rule edit. Lessons are the escape hatch, not the destination.

## Edit

- Style: telegraph per `agents-md-streamline`.
- Place at smallest scope that holds the rule (nested over root, scoped section over top-level).
- Match the destination file's existing register: agent-facing telegraph; human-facing prose.
- Commit with `self-healing:` prefix so the trail is greppable.

## Propagate

- If the rule generalises beyond this repo: edit the source skill in `~/gitrepos/02_workskills/<name>/`.
- Append a dated paragraph to `<name>/HISTORY.md`: what / why / triggering repo.
- If the skill has no `AGENTS.md` or `HISTORY.md` yet, create them now (lazy bootstrap).

## Verify

- Summarise the change in one line.
- Confirm with the user before moving on.
- Re-run any audit script the destination skill provides.

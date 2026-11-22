---
title: SlideWell upkeep tickets, 21 November 2026
register: FOR AGENTS
date: 2026-11-21
---

# SlideWell upkeep tickets, 21 November 2026

Eight build tickets from a codebase-health pass over the last eight weeks of SlideWell (128 commits since 26 September; hot spots `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, the cloud sorter and its store, Triage). Each ticket is sized for one fresh builder session.

## Live line

- Installed: `/Applications/SlideWell.app` 0.4.0-alpha.19 (20 October).
- Built from `feat/shared-settings` (`34d4a16`), which is **not merged into `main`**. `main` is at alpha.15 plus three website commits. Ticket 01 merges it; after that, branch every ticket from `main`. This tickets branch and its pull request are based on `feat/shared-settings`.
- Fresh checkouts need `node scripts/fetch-app-patterns.mjs` before `npm ci` (the App Patterns tarballs are fetched from the public release and checked against `package-lock.json`).
- Care level: Normal (an ordinary app). Tickets marked **Opus review** touch a write path or consent records.

## Builder rules

- Build the ticket's purpose.
- Where the ticket's wording conflicts with the code on a detail, take the reading that keeps existing behaviour and meets the purpose, record it in the pull request and carry on. Stop only for a choice that changes behaviour, a write path or a security boundary beyond the ticket.
- Single targeted test files may be run directly (`npx vitest run test/<file>.test.ts`). Anything heavier — the whole unit suite, `npm run build`, any `e2e/` spec, `npm ci` — goes through `~/.local/bin/agent-run`, started detached with a long wait (the slot is shared across the machine and was queued for over an hour on 21 November).
- No delete commands. List any scratch you created in your report instead.
- No version bump.
- Headless browsers: Playwright's headless shell only, never real Chrome. Never point a test at the real archive, well or `userData`.

## Tickets, ranked

| # | Ticket | Blocked by | Opus review |
|---|---|---|---|
| 01 | main catches up with the installed line | — | no |
| 02 | The typecheck actually checks the main process and the renderer | 01 | no |
| 03 | A half-written well copy can no longer cause the inbox original to be removed | 01 | yes (write path) |
| 04 | config.json is written safely and an unreadable one is never overwritten | 01 | yes (write path: keys, consent) |
| 05 | Every end-to-end spec can be run by name and has run once | 01 | no |
| 06 | The main process is split by area | 04 | no, unless what is deleted changes |
| 07 | The renderer root is split by view | 02 | no |
| 08 | SlideWell tells you when a newer version exists | 01 | no |

Frontier now: 01. After 01 lands: 02, 03, 04, 05, 08. Two of eight need an Opus review.

## Baseline

Not run on 21 November: the unit suite needs `npm ci` in a fresh worktree and the machine's `agent-run` slot was queued for over an hour, so the job was withdrawn. There is no CI for tests (`.github/workflows/release.yml` packages only). The last recorded full run is on the unmerged `codex/slidewell-real-typecheck` branch (17 October, alpha.15): 1,100 passed, one skipped.

## Follow-ups

- 11 — Reproduce the four Studio failures in `test/source-watcher.test.ts` and make the filesystem-event tests reliable. Preserve the accept filter, max-wait, image-pool change and symlink retargeting assertions.

## Excluded: needs Dominik's choice

- Lean Mac archive from R2 (`_DTC/slidewell/roadmap/lean-mac-archive-from-r2.md`): spec first; the R2 layout and cache size are his.
- Early AI explanation repository (`early-ai-explanation-repository.md`): waits on his review of the proposed collection design.
- Sorter learns from descriptions and his reasons (`sorter-learns-from-descriptions-and-your-reasons.md`): still an idea; design first.

## Leftovers for the driver

- `origin/codex/slidewell-real-typecheck` (17 October) is superseded by ticket 02 once that lands.
- No other worktrees for this repository.

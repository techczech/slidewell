---
title: "Others' Library: import & search other people's slides in a separate store"
id: others-library
date: 2026-06-23
type: change
status: shipped
tags: [others-library, import, search, archive, scope, separation, external, adr-0031]
---

# Others' Library: import & search other people's slides in a separate store

SlideWell can now import and search **other people's** decks in a library that is **physically separate** from the personal archive — never mixed into `ppt-archive`, badged OTHERS, purgeable as a whole (Scenario A). Solves "I want to bring in collaborators' slides without incorporating them into my archive." Design: `docs/superpowers/specs/2026-06-23-others-library-scenario-a-design.md`; decision: presentation-system **ADR-0031** (DRAFT, pending grill).

- **`src/main/ingest.ts`** — the pipeline now separates **engineRoot** (the user's `ppt-archive`, where Core A's `tools/` live — cwd + PYTHONPATH) from **dataRoot** (where `extracted/`+`registry/`+`media-store/` are written, created on demand). "My archive" import has them equal; "Others'" keeps the same engine but writes to a separate `othersArchiveRoot` (default `~/SlideWell/others-library`).
- **`src/main/index.ts`** — `othersArchiveRoot` config + resolvers + `allowedRoots`; `archive:search` / `archive:list-decks` query mine and/or others by `filters.library` and tag results; `rootForDeck()` auto-routes inspect/context (structure, images, deck-slides, deck-detail) to whichever store holds the deck; `ingest:run-path` takes a `library` arg; `settings:choose-others-folder` (guarded so it can't overlap the archive) + `settings:clear-others-library` (purge, never touches `ppt-archive`).
- **Search**: `SearchFilters.library: 'mine' | 'others' | 'all'` (default mine); results carry `library`; an **OTHERS** badge on cards/decks.
- **UI**: Import panel gains a **My archive | Others' library** destination toggle (reflected in "Where it goes"); a **Library** scope selector (Mine · Others · All) in the filter bar; Settings gains an Others' Library folder chooser + Clear-library button.

**Verified**: `npm run build` green; 17/17 unit tests; per-project type-checks show only the pre-existing `well.ts:108` + web `TS6307` baselines. End-to-end: importing `govie-project-progress-report.pptx` to a temp others-root built `extracted/<id>/presentation.json` + `registry/media.db` **in that store**, with the personal `ppt-archive` left untouched.

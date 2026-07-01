---
title: "Triage: stage-then-import, 2–6 column grid, S/X/E/Space keys"
id: triage-stage-then-import
date: 2026-06-30
type: change
status: shipped
tags: [triage, stage, import, well, grid, keyboard, adr-0029]
refs: [screenshot-video-triage, triage-grid-fit-keys-date-sort]
---

# Triage stage-then-import (revises ADR-0029)

Reworks the Triage screen so selecting a screenshot **stages** it instead of copying it into the well immediately, and a new **Import** button promotes the whole staged batch at once. Also makes the preview grid resizable and adopts an `S`/`X`/`E`/`Space` keyboard model.

- **New `selected` state.** ADR-0029's "include IS the keep decision" splits into `undecided → selected → included`, with `excluded` as a side branch. `selected` is a real persisted state in `triage.db` (`triage_decisions.state` is plain TEXT — no migration), so the staged pile survives closing the panel and is a filterable tab. Selecting no longer ingests anything.
- **`importSelectedTriage`** (new IPC `triage:import-selected`) promotes every `selected` item into the well via the existing `ingestScreenshot`/`ingestVideo` path, stamps `well_id`, and moves it to `included`. The staged query uses `GROUP BY hash` so duplicate-content files aren't double-ingested; **offline** OneDrive placeholders and **missing** files are skipped and counted; videos over the 20 MB gate are skipped unless explicitly forced (one `confirm()` per staged large video in view); ingest failures are logged and counted rather than silently dropped. Idempotent.
- **Keyboard:** `S` select · `X` unselect (→ undecided) · `E` exclude · `Space` toggles selected ⇄ undecided. Works in the grid and the lightbox preview. `i`/`u` kept as silent aliases.
- **Resizable grid:** a 2–6 column stepper (persisted to `localStorage`), driving CSS variables `--triage-cols` and `--triage-thumb-h` — fewer columns give taller, larger previews. The Arrow Up/Down row-jump now reads the live column count (fixes the old hardcoded `±6`).
- **Import button + tabs:** `⤓ Import N → well` in the panel header (enabled only when `N > 0`); tabs become **Undecided · Selected · Excluded · All**. Staged cards get an Oxford-blue accent distinct from the green "in well" state.
- **Pure logic seam:** decision logic (`tallyTriageStates`, `planSelectedImport`) lives in a dependency-free `src/main/triage-logic.ts`, unit-tested in isolation.

**Known edge (pre-existing count semantics):** `triageCounts` counts source *paths*, not unique content hashes, so duplicate-content screenshots can show a higher "Selected N" on the button than the number of unique files `Import` actually writes (the toast reports the deduped count). Rare; surfaced now only because the explicit count is visible.

Verified: `npx vitest run` → 32/32 across 4 files (incl. the new `triage-logic` suite); `e2e/triage.mjs` extended to prove the staging boundary — `pass: true` (well's `images/` is empty after select, populated after import; `included` is 0 before import; staged count exact for the duplicate-hash fixture). Reinstall to `/Applications/SlideWell.app` happens at branch merge.

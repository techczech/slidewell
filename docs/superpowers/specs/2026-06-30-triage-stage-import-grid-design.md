# Triage: stage-then-import, configurable grid, S/X/E/Space keys

**Status:** design — approved 2026-06-30; pending spec review, then plan + build.
**Repo:** slidewell (execution).
**Revises:** **ADR-0029** (Screenshot & video triage). ADR-0029's rule "include IS the keep decision — selecting promotes the file straight into the well" is the thing changing: selecting now only *stages*, and a separate **Import** step promotes all staged items. The clipboard-paste path ("paste IS the keep decision") is unchanged. This split warrants a follow-up note on ADR-0029 in the presentation-system direction layer; flagged, not blocking.

## Problem

The triage screen (a folder SlideWell *reads but never owns*; keepers are copied into the well) has three usability gaps Dominik hit:

1. **No import step.** "Select" silently copied the file into the well immediately (`setTriageDecision(..., 'include')` → `ingestScreenshot`/`ingestVideo`). There was no way to review a batch of picks before committing, and no button labelled "import" — so the action felt invisible.
2. **Fixed preview size.** The grid is hardcoded to 6 columns (`repeat(6, …)` in CSS), so thumbnails are always small. No way to trade column count for bigger previews.
3. **Keyboard model.** Space = include only (never un-picks); keys were `i`/`x`/`u` (include / exclude / reset). Dominik wants `S`/`X` for select/unselect, Space as a real toggle, and exclude kept.

## Decisions (from the 2026-06-30 brainstorm)

- **Stage, then import (persisted).** Selecting marks a card without copying. A new **`⤓ Import N → well`** button promotes every staged item at once. Staging is a **persisted 4th triage state** (survives closing the panel; is a real countable/filterable pile), *not* ephemeral client state.
- **State machine:** `undecided → selected → included`, with `excluded` as a side branch.
  - `selected` = staged (chosen, **not** yet in the well; `well_id` is NULL).
  - `included` = promoted into the well (carries `well_id`) — the post-import resting state.
  - `excluded` = rejected; remembered by hash so it never reappears on rescan.
- **No DB migration.** `triage_decisions.state` is plain TEXT; `selected` is just a new allowed value.
- **Keyboard (keep all three keys):** `S` select · `X` unselect (→ undecided) · `E` exclude · `Space` toggle (selected ⇄ undecided). `i`→select and `u`→unselect kept as silent aliases for muscle memory. Same keys inside the lightbox preview.
- **Configurable grid:** a 2–6 column stepper, default 6, persisted to `localStorage`. **Fewer columns → taller thumbnails** (preview genuinely grows). Arrow up/down row-jump reads the *same* column count (fixes the hardcoded `±6` coupling bug).

## Non-goals

- No change to the clipboard-`paste` path — it still ingests straight into the well (it is its own keep decision).
- No change to `scan`, the triage index/FTS, OCR, the offline/OneDrive handling, the 20 MB video gate value, or R2.
- No multi-select drag, no "import to archive" (screenshots go to the well only).
- No per-machine sync of staged state (it lives in the local `triage.db` like every other decision).

## Architecture

### State & backend — `src/main/triage.ts`

`setTriageDecision(archiveRoot, wellRoot, sourceRoot, hash, action, force)` — action vocabulary changes from `include | exclude | reset` to **`select | exclude | reset`**:

- `select` → `INSERT OR REPLACE … state='selected', well_id=NULL`. **No ingest.** Returns `{ state: 'selected' }`.
- `exclude` → unchanged (`state='excluded'`).
- `reset` → unchanged (deletes the row → `undecided`).
- The old `include` branch (ingest + `well_id`) **moves into a new bulk function** and is removed from `setTriageDecision`.

New **`importSelectedTriage(archiveRoot, wellRoot, sourceRoot, { forceHashes })`**:
- Selects all rows where `state='selected'`.
- For each: skip if the source file is missing or **offline** (not downloaded) → counted as skipped with a reason. If a **video > 20 MB** and its hash is **not** in `forceHashes` → skip as `gated`. Otherwise `ingestScreenshot`/`ingestVideo`, then `state='included', well_id=<id>`.
- Returns `{ imported, skipped, gated, reasons: {hash → reason} }`.

`triageCounts` gains a `selected` bucket. **Watch the existing fall-through:** the counts loop ends with `else out.undecided += n`, which would silently miscount `selected` rows as undecided — so an explicit `else if (r.state === 'selected') out.selected = n` branch must be added *before* the `else`. `listTriage`'s state filter already accepts any `[a-z]` value, so `'selected'` works as a tab filter unchanged.

### IPC & types — `src/main/index.ts`, `src/preload/index.ts`

- `triage:decide` handler: action type → `'select' | 'exclude' | 'reset'`.
- New handler **`triage:import-selected`** → `importSelectedTriage(...)`, resolving `screenshotRootResolved()` like the others.
- `triageToWire` / the `empty` fallback counts object: add `selected: 0`.
- Preload `TriageItem.state` union: add `'selected'`. `TriageCounts`: add `selected: number`. `triage.decide` action type updated. New `triage.importSelected(forceHashes?: string[]): Promise<{ imported; skipped; gated; reasons }>`.

### Frontend — `src/renderer/src/App.tsx` (`TriagePanel`, `TriageCard`, `TriagePreview`)

- **`decide` helper:** actions `select | exclude | reset`. Drop the "added to the well" toast on select; toasts become `Selected` / `Excluded` / `Unselected`. Keep the optimistic in-place card update + counts bump (now bumping the `selected` bucket).
- **`importSelected` handler:** if any staged item is a `large` video, `confirm()` once per such video to build `forceHashes`; call `window.sw.triage.importSelected(forceHashes)`; toast `Imported N → well` (+ skipped/gated detail); `refresh()` + `onChanged()`.
- **Keyboard (grid + preview):** `s`→select, `x`→reset, `e`→exclude, `Space`→toggle (`cur.state === 'selected' ? 'reset' : 'select'`). `i`→select, `u`→reset as aliases. `Enter`/`⌘Y` preview unchanged. Arrow up/down jump `±cols` (not `±6`).
- **Grid columns:** `cols` state initialised from `localStorage['sw.triage.cols']` (default 6, clamped 2–6), written back on change. A stepper in `.triage-controls` (`Size ‹2 3 4 5 6›`). The grid container gets `style={{ '--triage-cols': cols }}`; thumb height derives from `cols`.
- **Tabs:** `Undecided · Selected · Excluded · All` (counts show `selected`). Imported items surface under All.
- **Import button:** in `.triage-head-actions`, primary style, label `⤓ Import {counts.selected} → well`, `disabled={counts.selected === 0}`.
- **`TriageCard`:** badge `✓` for `selected` (staged) and a distinct mark for `included` (in well); `✗` for excluded. Buttons relabel: **Select** (state≠selected/included) · **Exclude** (state≠excluded) · **Unselect** (state≠undecided).
- **`TriagePreview`:** buttons `Select (Space)` · `Exclude (E)` · `Unselect (X)`.

### Styles — `src/renderer/src/styles.css`

- `.triage-grid { grid-template-columns: repeat(var(--triage-cols, 6), minmax(0, 1fr)); }`.
- `.triage-thumb { height: var(--triage-thumb-h, 150px); }` — `--triage-thumb-h` set alongside `--triage-cols` (≈150px at 6 cols up to ≈320px at 2 cols).
- New: `.state-selected` accent (distinct from the green `state-included`), the column stepper, the primary import button.

### Tests

- **Backend (vitest):** `setTriageDecision('select')` writes `selected` + NULL `well_id` and **does not** ingest; `importSelectedTriage` promotes all `selected` → `included` with `well_id`, skips offline, gates large videos unless forced, and is idempotent (re-running imports nothing new). Confirm `triageCounts` reports the `selected` bucket.
- **Frontend:** if a render test harness exists, assert Space toggles selected⇄undecided and the Import button reflects `counts.selected`; otherwise cover the toggle/force-list logic as a pure helper.

## Risks

- **Lost-staging perception:** staged state persists in `triage.db`, so closing the panel keeps picks — the Import button's live count is the reassurance that nothing's committed yet.
- **Row-jump regression:** the `±cols` change must read the live column count or ArrowUp/Down skips wrong; covered by making `cols` the single source for both CSS and the handler.
- **Bulk import of a large video:** handled by the per-video `confirm()` → `forceHashes`, preserving today's gate semantics without N blocking prompts for normal images.

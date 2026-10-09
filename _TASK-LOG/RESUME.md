# SlideWell — RESUME (session entry point)

**FOR ME.** Last updated 2026-10-09.

## State

Electron + React + TS (electron-vite), mirrored from `talk-weaver`. Shipped (see `_CHANGELOG/INDEX.md`): search + full filter/cluster/lightbox surface, archive **Import** (Core A pipeline), the **well** + screenshot/video **Triage**, Stats, Settings + dependency detection. Newest: **Convert** — sideband throwaway PPTX→Outline (a distinct verb from Import; never catalogued into archive/vault; `origin: external` stamp). Direction layer in `presentation-system` (ADR-0026, CONTEXT.md, ROADMAP P7).

**Convert internals** (2026-06-23): `src/main/outline.ts` (pure transform, 17 vitest tests in `test/`), `src/main/convert.ts` (sideband extract → optional OCR → emit), `convert:*` IPC + `conversionsRoot`/`convertOcrByDefault` settings, `⇄ Convert` titlebar panel. Verified end-to-end on a real third-party deck. **Unit tests now exist**: `npm test` (vitest). Note: repo `tsc --noEmit` is a no-op (root tsconfig `files:[]`); real type-check is `tsc -p tsconfig.node.json/--web` (baseline reds: `well.ts:108`, web `TS6307` preload→main/stats).

## Screenshot sorter, local part (2026-10-09)

Code: `src/main/sorter/` — `rules.ts` (app/window/OCR → lean + reason), `classifier.ts` (class-weighted L2 logistic regression on picture-search embeddings, L2 by 5-fold CV; trained in a worker thread), `calibration.ts` (Platt vs isotonic on out-of-fold scores, the lower cross-validated Brier wins), `groups.ts` (related screenshots kept together in the split and the folds), `decide.ts` (log-odds combination + keep-bias thresholds → keep/throwaway/doubtful + reason), `accuracy.ts` (stratified 20% hold-out + report), `store.ts`, `service.ts`; Settings › Screenshot sorter (`SorterSettings.tsx`). Proposals only: `sorter_proposals` + `sorter_models` in triage.db (never `triage_decisions`); triage embeddings in picture-search.db, kind `triage`, id `triage:<hash>` (left out of search unless a query names the kind). No nightly schedule yet: Settings has "Sort undecided screenshots now", refused until a model trained under the current sorter version has a held-back report with at least 20 items and 5 of each label; training fails with "not enough independent examples to calibrate" when fewer than 3 folds or 20 out-of-fold scores (5 per label) are usable. Grouping and fitting run in a worker thread.

**Accuracy on his real labelled history** (calibrated, near-duplicates grouped; copy taken 2026-10-09 night, `e2e/sorter.mjs`, sorter-local-2, thresholds unchanged: throwaway ≥ 0.90 (floor 0.85), keep ≥ 0.70; all e2e checks passed, no network request, his decisions unchanged). **Accuracy is measured on a held-back fifth; the model in use was then retrained on all his choices**, its calibration again from out-of-fold scores (group k-fold over all data, never in-sample).

- Labelled: 251 kept and 156 binned; 251 + 154 have their picture on disk.
- Grouping before the split (cosine ≥ 0.95, or same app + window title within 5 minutes; connected components): **373 groups, largest 4**. The app/window rule never fires on this history (no screenshot carries an app or window title yet); all links are near-copies.
- Held back, whole groups, about 20% per label: **82** (51 kept, 31 binned); fitting and calibration use only the other 323 (L2 = 0.001 and the calibrator chosen by group 5-fold CV inside that split).
- Calibration, cross-validated Brier inside the training split: raw 0.198, **Platt 0.187 (chosen)**, isotonic 0.190 (ties pooled before pool-adjacent-violators).
- **Throwaway precision 100%** (2 of 2). **Keep precision 80%** (32 of 40). **Doubtful 49%** (40 of 82). Kept proposed as throwaway: 0. Binned proposed as keep: 8.
- Calibrated classifier alone on the held-back 82: AUC 0.843, Brier 0.153. Reliability of p(throwaway):

  | p(throwaway) | n | mean predicted | share binned |
  |---|---|---|---|
  | 0.0–0.1 | 4 | 0.09 | 0.00 |
  | 0.1–0.3 | 33 | 0.19 | 0.18 |
  | 0.3–0.5 | 20 | 0.39 | 0.25 |
  | 0.5–0.7 | 16 | 0.60 | 0.69 |
  | 0.7–0.9 | 7 | 0.79 | 1.00 |
  | 0.9–1.0 | 2 | 0.92 | 1.00 |

- Rules alone on the same 82: keep 67% (4 of 6), throwaway none, doubtful 93%.
- Full sort of the copy: 11,928 undecided pictures → 7,235 keep, 464 throwaway, 4,229 doubtful.
- Caveat: throwaway precision rests on 2 held-back proposals, too few to confirm the 0.95 bar either way.
- An earlier copy that embedded most kept pictures from the well's re-encoded copies looked better than it was (file format); disregard it.

## Review screen (ticket 08, 2026-10-09; review fixes same night)

Code: `src/main/review/` — `piles.ts` (pure state machine: doubtful / kept / throwaway / bin / gone, 30-day clock, keep/throwaway/rescue plans; also compiled into the renderer via `tsconfig.web.json`), `store.ts` (read model; `hiddenFromLists` = Bin + emptied by the same clock, used by the Triage list), `service.ts` (action layer: act, page, undo, emptyBin), `ipc.ts`. Renderer: `Review.tsx` + `review.css`; title bar Search | Review switch in `App.tsx`; browser mock `review-mock.ts` uses the real `piles.ts` (`?reviewBin=N` adds a large Bin).

- **Review deletes no file and no record.** Decided by the driver after an independent review reproduced deletion of an original through a symlinked copy root: the capability was removed, not guarded. Empty Bin writes a permanent `emptied` decision and the items are hidden everywhere (Review, Triage list, well search for a kept-then-binned item's well row via its kept well id). UI wording: "Emptying the Bin hides these for good. SlideWell never deletes your files." Undo of a Keep leaves the well copy and well row in place.
- Piles are derived, never stored. His decision (triage_decisions) wins: selected/included = kept by you; excluded = throwaway, clock from decided_at; emptied = gone. Without one, the proposal: doubtful = queue, keep = kept, throwaway = throwaway, clock from `sorter_proposals.throwaway_since` (first throwaway proposal, kept across re-sorts). 30 days on → Bin. Missing or unreadable date → stays in Throwaway and findable (when unsure, keep).
- Keep = `selected` then `promoteTriageHashes` (the Triage Import path, one hash) → `included` + well id. Throwaway = `excluded`. Both via `putTriageDecision` in triage.ts; the proposal gets `answer` + `answered_at`. Skip writes nothing (session-only reorder).
- Empty Bin: needs the token of the Bin shown; `writeEmptiedMarkers` writes all markers in one transaction, each only if the item is still in the Bin at write time (decision unchanged since the snapshot, clock still run out); changed rows are left alone and reported.
- `emptied` is permanent: every triage_decisions write (Triage reset/select/exclude, review's own writes) is conditioned on it in SQL; Triage says so when refused.
- Undo (⌘Z): in-memory stack; restores the exact prior decision row and answer; the entry is popped only after the restore succeeded.
- Paging: `review.piles` returns first pages + totals; `review.page(pile, offset, limit)` returns any further page (≤ 500 per request, no cap overall). Kept, Throwaway and Bin all have "Show more".
- Triage IPC handlers (scan, list, decide, import-selected, paste) answer the main window only (`ipc-guard.ts`).
- Tests: `test/review-piles.test.ts`, `test/review-actions.test.ts`; `npm run test:review-ui` (renderer mock, headless shell); `npm run test:review` (hidden Electron, `SLIDEWELL_REVIEW_SCRATCH`).

## Decided (2026-06-18 grill — presentation-system)

- App-face of Core A (`ppt-archive`): reuse engine, redesign storage.
- Layered authority: owns archive *extractions* + *added images* (well); catalogues current Talks (Outlines canonical, ADR-0001). Originals extracted-in-place, hash-referenced, preserved cold.
- One Image Node (shared w/ TalkWeaver) + `provenance` (extracted|added). Tags + search, no folders.
- ADR-0026: `{#id}`-only in Outline; lineage/drift/versioning external, lightweight, git-referenced, full+partial hashing. Files named `{slug}--{hash}.ext`.
- Shared-disk boundary: both apps read DBs; SlideWell owns writes + heavy work.

## Build order

1. ~~**Read path over Core A**~~ — **DONE** (`archive-read-path-search`): ported sqlite3 shell-out query layer, swarchive:// render thumbnails, results grid.
1b. ~~**Full search surface**~~ — **DONE** (`search-filters-actions-clustering`): separate filter bar (Owner/Date/Category/Slides + Group toggle), power tokens, near-identical clustering + expand, per-result action menu (open full size, copy image/text/structure/reference, reveal, details), lightbox. Ported deckmeta + searchlib (tokens/filter/cluster) faithfully.
   - Remaining follow-ups: image-search FTS upgrade (still LIKE on media.db); per-OCR role filter (skipped for speed); presentation_id→folder map for renders (works today as pid==folder name, make robust); native macOS Quick Look (currently in-app lightbox); keyboard shortcuts for actions.
2. ~~**Import**~~ — **DONE** (`archive-ingest`): Core A pipeline as streamed subprocesses; progress UI; extract-in-place.
3. ~~**The well + Triage**~~ — **DONE** (`image-well-and-sources`, `screenshot-video-triage`): `provenance=added` Image Nodes; paste/screenshot/vault ingest; triage a source folder.
3b. ~~**Convert (Scenario B)**~~ — **DONE** (`convert-pptx-to-outline`): throwaway PPTX→Outline, sideband, fire-and-forget. Mechanical only; OCR optional.
3c. ~~**Others' Library (Scenario A)**~~ — **DONE** (`others-library`): import + search other people's decks in a SEPARATE Core A store (`othersArchiveRoot`, default `~/SlideWell/others-library`); same engine, separate data root; `library: mine|others|all` scope + OTHERS badge; Settings chooser + Clear. Decision: presentation-system **ADR-0031** (DRAFT branch `adr-0031-others-library`, pending grill). Deferred: lineage/reuse from others→Talks; multiple others' stores; others "ingest pending".
3d. **R2 storage backend (per-store Local|R2)** — spec design specs `2026-06-24-r2-storage-backend-design.md` (removed from the public tree; in git history); pending presentation-system **ADR-0032**. **Inc 1 DONE** (`r2-client-and-credentials`): `r2.ts` (aws4fetch SigV4), creds via `safeStorage` (write-only), Settings test-connection. **Inc 2 DONE** (`r2-per-store-backend-read-through`): `storage.ts` (pickStore/keyForPath/fetchFromR2/syncDirToR2), `swarchive://` local-or-R2 fetch-on-miss, per-store toggle + Sync. R2 keys path-mirrored `<prefix>/<store>/<relPath>` (prefix `slidewell`, bucket `ppt-archive-media`). **No eviction yet** (full-mirror; nothing auto-deleted). **PENDING Inc 3**: write-on-add + bounded-cache eviction (verify-before-evict). **PENDING Inc 4**: `well.db`/`triage.db` versioned R2 backup (closes the last data-loss gap; until then well metadata is local-only). SQLite indexes stay local by design (D1 considered & rejected — no offline search).
4. **Tracking index** — lightweight git-referenced slide index (full + partial/SimHash) for lineage/drift/versioning (ADR-0026).
5. **Semantic search** — unified text+image over MLX embeddings (qwen3-embeddings-mlx; Qwen3-VL scaffold), served by SlideWell's local process; FTS-degraded when off. **2026-10-09:** model + runtime replaced by EmbeddingGemma 2, ONNX fp16 on WebGPU in a hidden Electron window (no Python; 0.27 s/slide, 11/11 vs text 5/11 on a 392-slide sample). See presentation-system ROADMAP P7 and `_LEARNINGLOG/tools/local-ai-models/20261009-103000-embeddinggemma2-webgpu-in-electron.md`. Next: design how results surface, then ticket.

## Open (lower-stakes, from the grill)

- Semantic-search surfacing + ranking (how text-image vs scene-image blend).
- Enrichment local-vs-cloud AI (privacy) — default local (MLX / LM Studio).
- Ingestion surfaces (paste / drag / watch-folder / screenshot).
- Windows OCR fallback (macOS Vision is Mac-only) — Mac-first defers it.
- Prune unused devDeps (CodeMirror carried from the talk-weaver mirror).

## Reuse map

- Engine + DBs: the `ppt-archive` repository (extracted/, registry/{slides,images,media}.db, media-store/, tools/unified_extractor).
- Query layer to port: the `raycast-slide-search` repository, `src/lib/` (query.ts, cluster.ts, reference.ts, sqlite.ts).
- App template: the `talk-weaver` repository (same stack, shared Image Node).

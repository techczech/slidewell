# SlideWell — RESUME (session entry point)

**FOR ME.** Last updated 2026-10-09.

## State

Electron + React + TS (electron-vite), mirrored from `talk-weaver`. Shipped (see `_CHANGELOG/INDEX.md`): search + full filter/cluster/lightbox surface, archive **Import** (Core A pipeline), the **well** + screenshot/video **Triage**, Stats, Settings + dependency detection. Newest: **Convert** — sideband throwaway PPTX→Outline (a distinct verb from Import; never catalogued into archive/vault; `origin: external` stamp). Direction layer in `presentation-system` (ADR-0026, CONTEXT.md, ROADMAP P7).

**Convert internals** (2026-06-23): `src/main/outline.ts` (pure transform, 17 vitest tests in `test/`), `src/main/convert.ts` (sideband extract → optional OCR → emit), `convert:*` IPC + `conversionsRoot`/`convertOcrByDefault` settings, `⇄ Convert` titlebar panel. Verified end-to-end on a real third-party deck. **Unit tests now exist**: `npm test` (vitest). Note: repo `tsc --noEmit` is a no-op (root tsconfig `files:[]`); real type-check is `tsc -p tsconfig.node.json/--web` (baseline reds: `well.ts:108`, web `TS6307` preload→main/stats).

## Screenshot sorter, local part (2026-10-09)

Code: `src/main/sorter/` — `rules.ts` (app/window/OCR → lean + reason), `classifier.ts` (class-weighted L2 logistic regression on picture-search embeddings, L2 by 5-fold CV), `decide.ts` (log-odds combination + keep-bias thresholds → keep/throwaway/doubtful + reason), `accuracy.ts` (stratified 20% hold-out + report), `store.ts`, `service.ts`; Settings › Screenshot sorter (`SorterSettings.tsx`). Proposals only: `sorter_proposals` + `sorter_models` in triage.db (never `triage_decisions`); triage embeddings in picture-search.db, kind `triage`, id `triage:<hash>` (left out of search unless a query names the kind). No nightly schedule yet: Settings has "Sort undecided screenshots now", refused until a held-back report exists.

**Accuracy on his real labelled history** (copy taken 2026-10-09 evening, `e2e/sorter.mjs`, sorter-local-1, thresholds throwaway ≥ 0.90 / keep ≥ 0.70; all e2e checks passed, no network request, his decisions unchanged):

- Labelled: 251 kept (well screenshots, all triage `included`) and 156 binned (triage `excluded`); 251 + 154 have their picture on disk (7 kept pictures come from the well's re-encoded copy).
- Held back 20% per label: **82** (51 kept, 31 binned); classifier trained on the other 323; L2 = 0.001, picked by 5-fold cross-validation on the training part only.
- **Keep precision 93%** (13 of 14 proposed keeps were kept). **Throwaway precision: none proposed** (0 of 31 binned reached the band). **Doubtful 83%** (68 of 82). Kept proposed as throwaway: 0. Binned proposed as keep: 1.
- Rules alone on the same 82: keep 75% (3 of 4), throwaway none, doubtful 95%.
- Full sort of the copy: 8,337 undecided pictures → 1,628 keep, 0 throwaway, 6,709 doubtful (p(keep) never below 0.10).
- Reading: the keep-bias holds and the classifier ranks well (held-back AUC ≈ 0.86), but its probabilities sit between about 0.1 and 0.8, so the 0.90 throwaway band is never reached. Moving the thresholds or calibrating the probabilities is a keep-bias decision for Dominik, not taken here.
- Earlier copy (same day, before the triage index found the originals of most kept screenshots): keep 97% (35/36), throwaway 100% (1/1), doubtful 46% on 68. That run embedded 160 keeps from the well's re-encoded copies against binned originals; treat it as inflated by file format.

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

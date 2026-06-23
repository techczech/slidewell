# SlideWell — RESUME (session entry point)

**FOR ME.** Last updated 2026-06-23.

## State

Electron + React + TS (electron-vite), mirrored from `talk-weaver`. Shipped (see `_CHANGELOG/INDEX.md`): search + full filter/cluster/lightbox surface, archive **Import** (Core A pipeline), the **well** + screenshot/video **Triage**, Stats, Settings + dependency detection. Newest: **Convert** — sideband throwaway PPTX→Outline (a distinct verb from Import; never catalogued into archive/vault; `origin: external` stamp). Direction layer in `presentation-system` (ADR-0026, CONTEXT.md, ROADMAP P7).

**Convert internals** (2026-06-23): `src/main/outline.ts` (pure transform, 17 vitest tests in `test/`), `src/main/convert.ts` (sideband extract → optional OCR → emit), `convert:*` IPC + `conversionsRoot`/`convertOcrByDefault` settings, `⇄ Convert` titlebar panel. Verified end-to-end on a real third-party deck. **Unit tests now exist**: `npm test` (vitest). Note: repo `tsc --noEmit` is a no-op (root tsconfig `files:[]`); real type-check is `tsc -p tsconfig.node.json/--web` (baseline reds: `well.ts:108`, web `TS6307` preload→main/stats).

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
4. **Tracking index** — lightweight git-referenced slide index (full + partial/SimHash) for lineage/drift/versioning (ADR-0026).
5. **Semantic search** — unified text+image over MLX embeddings (qwen3-embeddings-mlx; Qwen3-VL scaffold), served by SlideWell's local process; FTS-degraded when off.

## Open (lower-stakes, from the grill)

- Semantic-search surfacing + ranking (how text-image vs scene-image blend).
- Enrichment local-vs-cloud AI (privacy) — default local (MLX / LM Studio).
- Ingestion surfaces (paste / drag / watch-folder / screenshot).
- Windows OCR fallback (macOS Vision is Mac-only) — Mac-first defers it.
- Prune unused devDeps (CodeMirror carried from the talk-weaver mirror).

## Reuse map

- Engine + DBs: `~/gitrepos/05_ppt-tools/ppt-archive` (extracted/, registry/{slides,images,media}.db, media-store/, tools/unified_extractor).
- Query layer to port: `~/gitrepos/14_apps-and-utilities/raycast-slide-search/src/lib/` (query.ts, cluster.ts, reference.ts, sqlite.ts).
- App template: `~/gitrepos/14_apps-and-utilities/talk-weaver` (same stack, shared Image Node).

# SlideWell — RESUME (session entry point)

**FOR ME.** Last updated 2026-06-18 (scaffold).

## State

Electron + React + TS (electron-vite), mirrored from `talk-weaver`. **Search works**: type a query → results grid of real slides from the Core A archive (render thumbnail + title + snippet + deck + used-in-decks + copy-ref). Verified via `npm run test:smoke` ("dyslexia" → 60 hits, 55/60 thumbnails render). No import or well yet. Direction layer in `presentation-system` (ADR-0026, CONTEXT.md, ROADMAP P7).

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
2. **Import** — single PPTX / folder → invoke Core A `unified_extractor` from main (child process); progress UI; extract-in-place, hash-reference originals.
3. **The well** — `provenance=added` Image Nodes: paste/drag/drop/screenshot capture → auto-enrich (OCR + AI description/tags + embedding via Core A) → `{slug}--{hash}` files + sidecar.
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

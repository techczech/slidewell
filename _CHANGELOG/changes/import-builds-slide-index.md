---
title: "Import now builds the slide/image index (search actually works from scratch)"
id: import-builds-slide-index
date: 2026-06-23
type: change
status: shipped
tags: [import, ingest, search, index, dedup, core-a, bug, others-library]
---

# Import now builds the slide/image index (search actually works from scratch)

The import pipeline ran extract → OCR → media-store but **never built the slide registry** (`slides`/`slide_locations`/`slides_fts`), so slide & deck **search over a freshly-built store returned nothing** — the queries hit missing tables and the errors were swallowed as "empty". Surfaced while building the Others' Library (Scenario A): a from-scratch others store had OCR + media but no slide index. The personal archive only worked because its index was built long ago by the legacy `ppt-to-learning` bulk process, not by SlideWell's per-file import.

- **`src/main/ingest.ts`** — add `tools.dedup.migrate <dataRoot>` after extract (before OCR, so `slides_fts` exists for OCR mirroring). This populates `slides`/`slide_locations`/`slides_fts` + the image registry with perceptual hashes. Fixes both the Others' Library AND single-file imports into the personal archive (same pre-existing gap).
- A new `reindex` mode of `runIngest` rebuilds the index from the extractions already on disk (no extract step) — used after a delete.

**Verified**: importing a deck into a fresh store now yields working slide/deck/browse search (was empty before); end-to-end test imports `govie-project-progress-report.pptx` → browse returns the deck.

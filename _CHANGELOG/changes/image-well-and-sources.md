---
title: "The image well: screenshots, TalkWeaver vault auto-ingest, search merge"
id: image-well-and-sources
date: 2026-06-19
type: change
status: shipped
tags: [well, ingest, ocr, talkweaver, vault, search, scope]
---

# The image well: screenshots, TalkWeaver vault auto-ingest, search merge

SlideWell now has an authoritative image **well** (survives Core A registry rebuilds — it's not derived from `extracted/`), fed by multiple sources and merged into search.

- **`src/main/well.ts`** — well store + `well.db` (FTS5 via the `sqlite3` CLI, no native module). Ingest = normalise to WebP (sharp), content-address `{slug}--{id}.{ext}` (ADR-0026, slug from OCR), OCR via Core A's macOS Vision binary (`tools/ocr/vision_ocr`), `.yml` sidecar, FTS upsert. Default store `~/SlideWell/well` (NOT inside Core A's repo; the multi-root `swarchive://` guard serves it anywhere).
- **`src/main/sqlite.ts`** — shared sqlite3-CLI wrapper (read + write + FTS sanitise), no native dep.
- **Sources** (well_fts.source): `screenshot` (copied + owned) and `talkweaver` (vault `_assets`, **indexed in place — never copied**, since the vault owns the file). The PPTX archive remains the `extracted` source.
- **Watched inbox** — `~/SlideWell/well/_inbox/`: SlideWell drains it on launch and watches it live (`fs.watch`), so a Raycast hotkey can ingest by simply dropping a file (even while SlideWell is closed — processed next launch).
- **TalkWeaver vault auto-ingest** — on launch SlideWell auto-detects the vault (from TalkWeaver's own config) and indexes new `_assets/img-*` images (OCR + sidecar tags). A `well:scan-vault` IPC re-scans on demand.
- **Search merge + Source scope** — a new All / Archive / Well control. Well results render as `well-image` cards (WELL tag, `![](img-{id})` reference) merged with archive hits; Well-scope browses the well newest-first.
- **Copy/reveal actions** now resolve the file from its thumbnail URL, so they work uniformly for archive renders, well images, and vault images.

**Verified** (Playwright `_electron`, real env): a screenshot dropped in the inbox is OCR'd, stored, and found under Well (`slidewell` → 1 hit); the inbox is drained; the TalkWeaver vault auto-indexed 9 images on launch. Build clean; smoke green (46 grouped, 9-action menu, lightbox, filter re-run).

Next in this feature: the Raycast quick-add command, and archive batch-ingest (crawl/extract/render/OCR orchestration with progress).

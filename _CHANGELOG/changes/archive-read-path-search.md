---
title: "Archive read-path: slide + OCR search with render thumbnails"
id: archive-read-path-search
date: 2026-06-19
type: change
status: shipped
tags: [search, core-a, fts, sqlite, thumbnails]
refs:
  resolves: [read-path-over-core-a]
updated: 2026-06-19
---

# Archive read-path: slide + OCR search with render thumbnails

First real capability: SlideWell now searches the Core A archive and shows results, not just a status pill.

- **Ported the proven query layer** from `raycast-slide-search` into `src/main/archive.ts`: shell-out to the system `sqlite3` binary (`/usr/bin/sqlite3`, no native module → no electron-rebuild), READ-ONLY, with hardened literal binding + FTS5 MATCH sanitisation. `searchSlides` merges `slides_fts` + `ocr_fts` (slide text and OCR'd text from renders/embedded images), content-role filtered; `searchImages` does media.db OCR LIKE. (v1 skips the per-OCR-row role filter for snappiness.)
- **IPC**: `archive:search-slides` / `archive:search-images` on `window.sw.archive`; results carry a `swarchive://` thumbnail URL (render `extracted/<pid>/renders/slide_NNNN.webp`, or `media-store/<sha>.<ext>` for images) and a copy-ready `[use: ppt:…]` / `r2://…` reference.
- **Protocol fix**: `swarchive://` now carries the base64url path in the URL *path*, not the host (URL hosts are lowercased by spec, which corrupted case-sensitive base64url). Path-guarded to the archive root.
- **UI**: debounced search → responsive results grid (16:9 render thumbnail, title, snippet, deck, "in N decks" badge, OCR tag, copy-ref). Scope tabs: All/Archive search the corpus; Well shows an empty-state (added images not built yet).

**Verified** (`npm run test:smoke`, Playwright `_electron` against the real archive): launches, searches "dyslexia" → 60 results, top hit "Dyslexia simulation"; 55/60 render thumbnails load (the rest are render-less hits). Build clean (tsc + electron-vite).

Resolves the `read-path-over-core-a` backlog item. Next: import (PPTX → Core A extractor) and the image well.

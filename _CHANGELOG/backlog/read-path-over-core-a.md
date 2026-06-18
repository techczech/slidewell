---
title: Read path over Core A (slide + image search)
id: read-path-over-core-a
date: 2026-06-18
type: backlog
status: done
priority: high
tags: [search, core-a, fts]
refs:
  resolved_by: [archive-read-path-search]
updated: 2026-06-19
---

# Read path over Core A (slide + image search)

Wire the main process to `ppt-archive/registry/{slides,images,media}.db` (read-only, WAL) and expose `archive:search-slides` (FTS5) + `archive:search-images`. Upgrade image search from the Raycast extension's `LIKE` to a real FTS index on `media.db`. Render a virtualized results grid with Quick Look and Copy Reference. Port the proven query/cluster/reference logic from `raycast-slide-search/src/lib/` rather than rewriting. First slice of "SlideWell as the archive's app-face" (ROADMAP P7).

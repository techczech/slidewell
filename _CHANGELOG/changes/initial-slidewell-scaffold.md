---
title: "Initial SlideWell scaffold"
id: initial-slidewell-scaffold
date: 2026-06-18
type: change
status: shipped
tags: [scaffold, electron, slidewell]
---

# Initial SlideWell scaffold

Created the SlideWell repo as a mirror of `talk-weaver`: Electron + React + TS (electron-vite 5, Electron 42.4.0), same vetted dependency tree (`package-lock.json` copied verbatim, root identity rewritten, deps left intact so `npm ci` stays release-gate-compliant). Plain CSS + the shared ecosystem palette (warm paper / Oxford blue), no Tailwind — matches the sibling app for component reuse.

App shell builds and launches: titlebar wordmark, search bar, provenance scope tabs (All / Archive / Well), and an archive-connected status pill that auto-detects `~/gitrepos/05_ppt-tools/ppt-archive` and offers a folder picker. Main process registers SlideWell's `sw*` privileged schemes (`swasset` / `swthumb` / `swarchive`) and serves read-only archive files via `swarchive://` (path-guarded to the archive root). Preload exposes the typed `window.sw` bridge and the shared `ImageNode` shape (`provenance` = extracted | added, plus `slug`/`notes` per ADR-0026).

No search, import, well, or embeddings yet — build order in `_TASK-LOG/RESUME.md`. Direction layer (glossary + binding decisions) is central in `presentation-system`: ADR-0026, CONTEXT.md (`SlideWell`, `Added image`, `Image Node`), ROADMAP P7.

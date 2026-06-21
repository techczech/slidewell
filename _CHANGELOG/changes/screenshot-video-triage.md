---
title: "Screenshot & video triage — scan a source folder, keep/skip into the well"
id: screenshot-video-triage
date: 2026-06-21
type: change
status: shipped
tags: [triage, screenshots, video, well, ocr, ffmpeg, adr-0029]
---

# Screenshot & video triage (ADR-0029)

A dedicated **Triage** screen (toolbar button) over a configurable source folder — e.g. a OneDrive screenshots folder — that turns a packed folder into a small set of curated keepers.

- **Triage source** is read but never owned. A recursive scan (`src/main/triage.ts`) hashes + OCRs every image/video into a *separate* index (`well/triage.db` — `triage_fts` scan records + a `triage_decisions` table keyed by content hash), incremental by path+size+mtime. Nothing reaches normal library search until it is included.
- **Include / Exclude / Reset**, three states keyed by hash so a later pass remembers what was decided even if OneDrive moves/renames the file. **Include** promotes the file into the well via the existing owned/enriched path (images → `ingestScreenshot`; videos → new `ingestVideo`, copied as `videos/{slug}--{id}` + poster + sidecar). **Exclude** records only the hash; the original is left untouched.
- **OCR on scan, enrich on include** — whole-folder text is searchable during triage; AI enrichment runs only on keepers.
- **Video**: ffmpeg poster frame (`findFfmpeg`/`makePoster` in `well.ts`), poster-frame OCR so on-screen text is searchable, inline playback in the preview. **20 MB gate** — over that shows a size warning and `decide(include)` refuses without an explicit confirm (`force`).
- **Paste-to-include** (⌘V in the panel): reads a clipboard image straight into the well (`well:add-from-clipboard`).
- Settings gains `screenshotRoot` (added to the protocol `allowedRoots` so source files + posters render via `swarchive://`). New IPC: `triage:scan/list/decide`, `triage:progress` stream, `settings:choose-screenshot-folder`. Typed `window.sw.triage` + `TriageItem`/`TriageCounts` in preload.

**Scoped boundary (not a silent cap):** included *videos* are stored owned + sidecar'd (discoverable on disk per ADR-0026, reusable by TalkWeaver 0.6) but are not yet indexed into SlideWell's own image search (`well_fts` has no kind column); they surface in the Triage screen as `included`. Included *images* enter `well_fts` and normal Images search as today. Indexing owned videos into SlideWell's main search is a follow-up.

Verified: `e2e/triage.mjs` (isolated temp userData + well + fixture) exercises the real scan→list→include→exclude flow — recursive scan finds 2 across a subfolder, include returns a well id and moves the item out of `undecided`, exclude is remembered (included 1 / undecided 1 / excluded 1). `e2e/smoke.mjs` gains `triageOpensOk`; full smoke green. Rebuilt + reinstalled to `/Applications/SlideWell.app`.

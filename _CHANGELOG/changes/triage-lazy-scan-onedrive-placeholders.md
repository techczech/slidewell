---
title: "Triage scan: lazy/incremental progress + OneDrive placeholder handling"
id: triage-lazy-scan-onedrive-placeholders
date: 2026-06-21
type: change
status: shipped
tags: [triage, onedrive, scan, performance, sqlite, adr-0029]
refs: [screenshot-video-triage]
---

# Triage scan — lazy load + OneDrive placeholders

Scanning a OneDrive folder appeared "stuck on nothing": the scanner hashed + OCR'd every file before the UI listed anything, and reading an online-only (not-downloaded) file forced a slow hydrate or hung.

- **Two-phase scan** (`scanTriageSource`): phase 0 enumerates with `stat` only (never hydrates placeholders) and emits a running `found N` count; phase 1 processes new/changed files one at a time, committing each row and emitting `processed i/N · read · not downloaded`.
- **Lazy load**: the Triage panel re-lists on each progress tick (throttled ~600 ms), so rows appear as they land instead of after the whole scan — you can see it move or see exactly where it's stuck.
- **OneDrive placeholders**: online-only files (size > 0 but `stat.blocks === 0`) are indexed from their stat alone and **never read**, flagged `offline`. The UI shows them dimmed with a ☁︎ "not downloaded" tile, no thumbnail (loading one would trigger a download), and Include is disabled until the file is downloaded. Exclude still works, so you can dismiss the bulk without downloading anything.
- **Stall guard**: `hashFile` has a 15 s read timeout — a file that slips past the placeholder check and stalls degrades to a "not downloaded" row rather than freezing the scan.
- **SQLite concurrency**: reads/writes set the busy timeout via the CLI `.timeout` dot-command (a `PRAGMA busy_timeout` emits a result row that corrupted `-json` output — that bug made every mid-scan read fail). No WAL (our reads are `mode=ro` and can't see un-checkpointed WAL frames); the busy timeout + the UI's retry-next-tick cover the brief write locks. `triage_fts` gained an `offline` column (table is rebuildable; auto-migrates by drop+recreate, decisions preserved).

Verified: `e2e/triage.mjs` green (scan → include → exclude); full `e2e/smoke.mjs` green (the shared `.timeout` change didn't disturb archive/well queries). Rebuilt + reinstalled to `/Applications/SlideWell.app`.

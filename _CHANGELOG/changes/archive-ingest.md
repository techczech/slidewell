---
title: "Archive ingest: Core A pipeline orchestration with live progress"
id: archive-ingest
date: 2026-06-19
type: change
status: shipped
tags: [import, ingest, core-a, subprocess, ocr, progress]
---

# Archive ingest: Core A pipeline orchestration with live progress

SlideWell can now ingest PowerPoint into the archive by driving Core A's Python pipeline as streamed subprocesses (the heavy work stays in ppt-archive's tools; SlideWell orchestrates + shows progress). Idempotent (done decks skipped), cancellable.

- **`src/main/ingest.ts`** — spawns the pipeline, streams stdout/stderr lines.
  - **Ingest pending** (whole archive): crawl → extract `from-manifest --skip-duplicates` → `renders render-all` → `ocr ingest-all` → `media_store migrate`.
  - **Import a file / folder**: `unified_extractor extract <path> [--batch] --screenshots` → OCR → media-store.
- **Python**: defaults to `/opt/anaconda3/bin/python3` (verified to have python-pptx/lxml/PIL; a packaged app's PATH lacks Homebrew/conda), config-overridable via `pythonPath`. `PYTHONPATH` set to `archiveRoot:archiveRoot/tools` so both `tools.*` and the bare `embeddings` package resolve (unified_extractor needs the latter).
- **IPC + UI**: `ingest:pending` / `ingest:import-path` / `ingest:cancel`, streaming `ingest:line` to the renderer. An **Import…** panel shows the two actions, a live log, and Cancel; on success the current search refreshes so new slides appear.

**Verified**: every pipeline CLI module loads and exposes the expected subcommands (`extract`/`from-manifest`, `render-all`, `ingest-all`, `migrate`) under the corrected PYTHONPATH; the Import panel opens with its actions + log (smoke). A full batch extraction wasn't run in CI (it mutates the archive + is slow) — it's a real run for the user; the streamed log surfaces any issue.

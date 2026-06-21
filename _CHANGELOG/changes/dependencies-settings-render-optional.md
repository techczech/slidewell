---
title: "Document dependencies; render auto-skips when LibreOffice absent; Settings panel"
id: dependencies-settings-render-optional
date: 2026-06-21
type: change
status: shipped
tags: [dependencies, settings, ingest, render, graceful-degrade, adr-0030]
refs: [distribution-foundation]
---

# Dependency docs + optional renders + Settings panel

So users know what to install and the app never hard-fails on a missing external tool.

- **`REQUIREMENTS.md`** — a public guide: each external tool (the ppt-archive Core A engine, Python + `python-pptx`/`Pillow`/`lxml`, the `vision_ocr` helper, `ffmpeg`, LibreOffice + Poppler), what it's for, the one-line install, and how each degrades when absent.
- **Renders auto-skip when LibreOffice/Poppler are missing** (`ingest.ts`): `findRenderTools()` checks `soffice` + `pdftoppm` (incl. `/Applications/LibreOffice.app`); if absent, the import drops the `--screenshots` flag (path mode) and skips the `renders` step (crawl mode) with a clear log line — import still does text, structure, images & OCR. The Python subprocess also gets an **augmented PATH** (`/opt/homebrew/bin`, `/usr/local/bin`, the LibreOffice bundle) so it can find these when present (a Finder-launched app otherwise has a bare PATH).
- **Settings panel** (⚙ in the toolbar): folder roots (archive/well/vault/triage-source, with Choose…), plus **live dependency status** — each tool shows ✓ found / ⚠ missing, where it was found, what it's for, and the install command — and a **link to `REQUIREMENTS.md` on GitHub** (`settings:dependencies` IPC). The panel owns the keyboard while open (Esc closes).

Verified: `e2e/smoke.mjs` gains `settingsOk` (panel opens, ≥4 dependency rows, requirements link present); triage e2e + full smoke green. Reinstalled to `/Applications/SlideWell.app`.

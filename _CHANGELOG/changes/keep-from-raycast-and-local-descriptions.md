---
title: "Keep screenshots from Raycast + local-LLM descriptions on top of OCR"
id: keep-from-raycast-and-local-descriptions
date: 2026-10-01
type: change
status: shipped
tags: [well, screenshots, raycast, inbox, enrichment, local-ai, describe, triage, performance]
refs: [image-well-and-sources, screenshot-video-triage, triage-stage-then-import, image-well-added-images]
---

# Keep screenshots from Raycast + local-LLM descriptions

Screenshots are taken automatically (CleanShot) and only a few are worth keeping. The keep decision
now happens at capture time instead of in a later triage session, and kept screenshots get a
description from a local vision model so they are findable even when they contain little text.
No tagging: the description plus OCR is the search surface.

- **Raycast script commands** (`raycast/`): *Keep Last Screenshot* (newest N files from the screenshot
  folder) and *Keep Clipboard Image*. Both drop into the existing watched inbox with an atomic
  dot-file → rename, so SlideWell never reads a half-written file. Works with SlideWell closed.
- **Inbox** (`drainInbox`): videos now go through `ingestVideo` (previously treated as images);
  files modified in the last 2 s are deferred and retried; each kept file is recorded as `included`
  in `triage.db` under the source file's 12-char content hash, so Triage won't offer it again.
  The watcher no longer drops files that arrive during a drain (dirty flag + loop instead of a busy flag).
- **Local descriptions** (`src/main/describe.ts`): OpenAI-compatible endpoint (LM Studio default
  `http://localhost:1234/v1`; Ollama works), model auto-picked from `/models` (prefers a VL model)
  unless set. The image is downscaled to 1280 px and sent with the OCR text as context. The
  description goes into well_fts `notes` (searchable, shown as the card snippet) and the sidecar's
  `description:` (self-describing on disk, ADR-0026). One serial runner, kicked after every ingest
  path (inbox, paste, triage import) and from Settings → *Describe missing*. Best-effort: server off
  → images wait for the next pass. Vault images are skipped (TalkWeaver owns their sidecars).
- **Settings**: new *Screenshot descriptions (local AI)* section — on/off, server, model, *Save & test*,
  *Describe missing* with a pending count. Config key `describe` in `config.json`.
- **Triage fixes from the optimisation review**: a rescan now forgets files deleted from the source
  folder (they lingered in Undecided with broken thumbnails); triage import reuses the scan's OCR
  instead of running Vision a second time.

Verified (Linux cloud session): `npx vitest run` → 64/64 across 8 files, incl. new `describe.test.ts`
(pure helpers + runner coalescing) and `well-inbox-describe.test.ts` (real sqlite3 + sharp + a fake
OpenAI server: inbox ingest/defer/dot-file/video routing, triage marker, description into search +
sidecar, idempotent rerun, triage stale-row removal). `npm run build` clean; `e2e/triage.mjs` passes
under Xvfb; `e2e/smoke.mjs` launches (no archive here, so its archive checks are vacuous). Type-check
shows only the known baseline errors.
**Not verified**: macOS Vision OCR, the Raycast scripts on macOS (only `bash -n` + the drop helper on
Linux), a real LM Studio/Ollama model.

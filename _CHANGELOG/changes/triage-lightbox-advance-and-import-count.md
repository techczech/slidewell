---
title: "Triage: lightbox decide-and-advance, import count by unique hash, smoke test skips without an archive (0.3.2)"
id: triage-lightbox-advance-and-import-count
date: 2026-10-09
type: change
status: shipped
tags: [triage, lightbox, keyboard, import, smoke-test]
refs: [triage-stage-then-import]
---

# Triage 0.3.2

- **Lightbox advances.** In the triage full-size preview, select (S/Space/I) and exclude (X/E) record the decision and show the next card; the preview stays open. Unselect (U) records and stays on the same card. On the last card the decision is recorded and the preview stays on it. Escape closes. Pure index logic: `nextPreviewIndex` in `src/main/triage-logic.ts`.
- **Import N matches what imports.** `triageCounts` now counts distinct content hashes for the selected bucket, so two selected paths with one hash show as 1, matching `importSelectedTriage` (which groups by hash).
- **Smoke test.** `e2e/smoke.mjs` prints `{ pass: null, skipped: true, reason: "archive not connected" }` and exits 0 when no archive is connected, instead of `pass: true`.

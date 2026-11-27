---
entity_type: task
id: 2026-11-27-repoint-triage-folder
title: "Re-point the Triage source at the renamed OneDrive Screenshots folder (MacBook Pro)"
status: done
created_at: 2026-11-27T08:00:00Z
updated_at: 2026-11-27T08:15:00Z
requested_by: dominik
request_source: coordinator thread (T3 3212f315), his answer "can you do it" (26 Nov)
audit:
  agent: Claude Opus 5.5
  machine: MacBook Pro
scope: [real-data, settings]
---

# Re-point the Triage source

- Old: `OneDrive-Nexus365(2)/Screenshots` (gone since OneDrive renamed that account folder on 29 Oct). New: `~/Library/CloudStorage/OneDrive-Nexus365/Screenshots` (macOS saves screenshots to its `ScreenRecordings` subfolder).
- Backup first: `~/SlideWell/backups/data-2026-11-27-before-screenshots-repoint/` (userData + well, 1,536 files, SHA256SUMS files beside them, copy verified).
- Pre-check on the backup: 12,643 of the 12,644 rows of the old source match a file in the new folder by path, size and time, so the relocation keeps them (and their hash, which keys the decision). All 13,112 files in the new folder are online-only placeholders.
- Change made through the app's own path: installed alpha.22 launched hidden through Playwright, Triage notice "Choose folder…" clicked, the native picker answered with the new folder (as `e2e/capture-folders.mjs` does). Result: `capture.triageRoot` changed in settings.json with a change record; `captureSourceHistory` records the old path; the legacy duplicate captureSources entry was dropped.
- After: triage_decisions identical to the backup (601 excluded, 652 included); decided rows 2,048 before and after; rows 22,555 → 23,024 (469 newer screenshots added); 12,643 relocation observations; 1 old row has no file and stays as it was (undecided). App counts: undecided 20,976, included 1,160, excluded 888.
- Arrival: an 80×80 black PNG cropped from a `screencapture` image was placed as `MacOS Screenshots/Screenshot 2026-11-27 at 08.10.38.png`; it appeared in Triage in 21 s, with a thumbnail. Left in place. (`screencapture -R` fails in this shell: "could not create image from rect".)
- Visible change: the re-pointed rows are online-only on this Mac, so Triage shows them without pictures (the app never loads placeholders) until OneDrive downloads them (4.3 GB for the whole folder).
- Scripts: `e2e/out/repoint-real.mjs`, `e2e/out/arrival-real.mjs` (ignored output).

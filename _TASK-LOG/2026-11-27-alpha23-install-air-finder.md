---
entity_type: task
id: 2026-11-27-alpha23-install-air-finder
title: "Cut and install 0.4.0-alpha.23 on the MacBook Pro; turn on the Air finder"
status: done
created_at: 2026-11-27T11:30:00Z
updated_at: 2026-11-27T15:30:00Z
requested_by: dominik
request_source: coordinator thread (T3 3212f315); his answer of 26 Nov "Take the recommended options and build the Air finder"
audit:
  agent: Claude Opus 5.5
  machine: MacBook Pro
scope: [release, install, real-data, air-finder]
---

# alpha.23 install and Air finder

## Release
- PR 38 rebased on main after PRs 33 to 36 (PR 39 left out), What's new reworded into two plain notes, merged as 5d6dbc9.
- Built by the release workflow from 5d6dbc9 (workflow_dispatch, run 45992429601; tests, build, signed and notarised package, feed-entry check all green). The local package from this morning (not notarised) was not used.
- Not included: PR 39 (merged 9a28f52 after 5d6dbc9) and PRs 40 to 42 (merged about 12:45).
- Downloaded zip: Gatekeeper "accepted, source=Notarized Developer ID", stapler valid, codesign valid, 0.4.0-alpha.23, net.dominiklukes.slidewell. Feed entry checked against it with `scripts/update-feed-entry.mjs check`.

## Proof (made-up data, notarised app, laptop slot)
- Packaged e2e with `SLIDEWELL_E2E_EXECUTABLE`: smoke, capture-folders, triage and review pass. Results for the rest are in the coordinator report.
- Screens looked at: search, What's new for alpha.23, Triage, Settings › Watched folders with the refusal of the well and archive folders, finder page at desktop width and 390 px. One top bar on every app screen.
- Source build `npm run test:air-finder` passes (private socket, Words, preview, original bytes). Its Air leg uses `python3` on the Air, which there is only the developer-tools stub; use curl and shasum instead.

## Install
- Backup: `~/SlideWell/backups/data-2026-11-27-before-alpha.23/` (userData + well, 1,537 files, SHA256SUMS beside them; copy verified; live data re-verified against the sums just before install).
- `/Applications/SlideWell.app` replaced with the notarised CI app (`rm -rf` + `ditto`); Gatekeeper accepts it.
- Started on the real library with the finder on. config.json and settings.json unchanged. triage_decisions unchanged (601 excluded, 652 included); Triage rows 23,025 → 23,027: two new CleanShot screenshots from today, not duplicates.

## Air finder
- Settings file `~/.slidewell-finder/finder.json` (0600 in a 0700 folder), socket `~/.slidewell-finder/finder.sock`, browser port 8870, `meaningVerified: false`.
- Allowlist: presentations with ownership `mine` in the archive registry, and every well screenshot image (663; the finder itself hides excluded, emptied and binned ones). Others' and unknown-owner decks are left out.
- **Gap:** 712 of the 727 own decks have IDs with spaces (folder names such as "01 MondAI Roundup - 11 Nov 24"). The launch config check (`/^[a-zA-Z0-9_][\w.-]{0,180}$/`) and the item id pattern in `catalogue.ts` refuse them, so only 15 decks are in. Fix next: allow spaces (still no `/`, no leading dot) and URL-encode item ids in finder.js.
- SlideWell runs from `/Applications` with `--air-finder-config=…`; no TCP listener on the Pro (lsof). A normal start has the finder off. Launchers (source in `scripts/air-finder/`): Pro `~/Applications/Start SlideWell with Air finder.command`; Air `~/Applications/SlideWell Air finder.command` (opens the `ssh -N -L 127.0.0.1:8870:<socket> macbook-pro` forward and the browser; closing the window ends it).
- From the Air through that forward: page 200; Words "dyslexia" 2 pictures, "AI" 40 slides in about 0.2 s; slide preview and picture preview WebP in about 0.05 s; downloads' SHA-256 equal to `X-SlideWell-SHA256`; POST 405; foreign Host 403.

## List (did not block)
- Settings › Watched folders: after a refused folder, Choose folder… and Stop watching overlap the "Triage source folder" label and the path is hidden.
- The finder shows More like this while Meaning is off.
- The finder's Air test leg depends on python3 on the Air.

DTC: `_DTC/slidewell/2026-11-27-check-alpha23-air-finder.md`

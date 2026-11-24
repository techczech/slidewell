---
entity_type: task
id: 2026-11-24-alpha22-publish-install
title: "Cut, prove, publish and install 0.4.0-alpha.22 on the MacBook Pro"
status: done
created_at: 2026-11-24T20:05:00Z
updated_at: 2026-11-25T00:05:00Z
requested_by: dominik
request_source: coordinator thread (T3 3212f315)
audit:
  agent: Claude Opus 5.5 (builder)
  machine: MacBook Pro
  cwd: slidewell.worktrees/release-0.4.0-alpha.22
scope: [release, publish, install]
blocked_by: []
waiting_on: Dominik re-points the missing OneDrive capture folder (DTC check)
next_action: none for agents; stable 0.4.0 release when he is ready
---

# Cut, prove, publish and install 0.4.0-alpha.22

## Request
Cut 0.4.0-alpha.22 from main after PR 19 (missing capture folders shown; recovery without duplicate Triage rows, cecb5dd), prove it, publish it on the opt-in alpha channel, install it on the Pro in place of alpha.21.

## What was done
- PR 20 (71fba77): version and two What's new notes in `src/main/update-notices.ts`. Merged at 3e86e27.
- First tag push did not build: GitHub no longer supports the `macos-14` runner ("The configuration 'macos-14-arm64-us-default' is not supported", run 45486654628 cancelled in 2 s, no release created). PR 21 moves `.github/workflows/release.yml` to `macos-15` (as TalkWeaver's public release). Merged at 393ac16; the tag `v0.4.0-alpha.22` was moved there (app code identical to 3e86e27).
- Release run 45486862719 on 393ac16: npm test, build, signed and notarised package, feed-entry check all green.
- Published https://github.com/techczech/slidewell/releases/tag/v0.4.0-alpha.22 as a prerelease (not Latest; 0.3.1 stays Latest).
- First publication of the update feed: `docs/updates.json` (GitHub Pages, https://techczech.github.io/slidewell/updates.json). `latest` and `channels.release` = 0.3.1; `channels.alpha` = 0.4.0-alpha.22 with the CI zip's URL, size 157,623,181, SHA-512 and bundle id. Checked with the app's own `parseChannelFeed`: alpha.21 with early versions on is offered alpha.22, with them off nothing, alpha.22 nothing. `scripts/update-feed-entry.mjs check` passes against the downloaded release zip.

## Proof
- Studio (remote-test, 71fba77): `npm run build` exit 0; `npx vitest run --testTimeout=30000` with short TMPDIR: 103 files, 1,224 passed, 1 skipped.
- Laptop slot, local package (`npm run build && npx electron-builder --mac dir --arm64 -c.mac.notarize=false`): codesign verify passes, team M7H45AGG8A; spctl rejects (not notarised, expected for the local build).
- Packaged e2e (made-up data, `SLIDEWELL_E2E_EXECUTABLE`): pass — capture-folders (missing folder shown in Triage and Settings, stored copy available, moved rows re-pointed and selection imported, choose and stop from Triage and Settings), smoke (with `make-smoke-archive`), triage, review, settings, sorter-cloud, backlog-import, look-alike, used-in-talks, review-ui, auto-sorting-ui; update-notices from the source build. `settings` now passes (failed on alpha.21 while fseventsd was broken; the Mac has since restarted).
- Notarised CI app (downloaded zip): `spctl` "accepted, source=Notarized Developer ID", stapler validate ok, codesign verify ok, version 0.4.0-alpha.22, bundle id net.dominiklukes.slidewell; smoke and capture-folders pass on it.
- Old against new on separate copies of the real data (APFS clones of userData, well and archive; watched folders pointed at scratch, the OneDrive source at a scratch folder that does not exist; mock keychain): installed alpha.21 and alpha.22 give identical library stats, Triage counts (22,555), first 200 Triage rows, Triage apps, paths, storage, owners, Review piles and row counts of every database table. Only difference: alpha.22 adds the empty `triage_relocation_observations` table and reports the missing source. config.json and settings.json unchanged by both.

## Install
- Backup: `~/SlideWell/backups/data-2026-11-24-before-alpha.22/` (userData + well, 1,504 checksummed files, copy verified; live data re-verified against the sums just before install). No app-binary backup (global rule): alpha.21 rebuilds from 117e467.
- `/Applications/SlideWell.app` replaced with the notarised CI app (`rm -rf` + `ditto`); Gatekeeper accepts it.
- Hidden start on the real library: 727 presentations, 48,683 slides, 14,700 images; Triage 22,555 (same as the copy); status bar "v0.4.0-alpha.22", "Updated to 0.4.0-alpha.22 · What's new". Triage shows "SlideWell can no longer find the capture folder Screenshots at …/OneDrive-Nexus365(2)/Screenshots" with Choose folder… and Stop watching. config.json and settings.json identical to the backup afterwards.

## Found
- The live OneDrive screenshot folder is `~/Library/CloudStorage/OneDrive-Nexus365/Screenshots` (macOS saves screenshots to its `ScreenRecordings` subfolder). `OneDrive-Nexus365(2) (29-10-2026 14:34)/Screenshots` is the disconnected copy OneDrive left on 29 Oct. Re-pointing is left to Dominik (DTC check).

## Not run
- match-switch, more-like-this, picture-search: need an indexed search fixture (model + indexed sample archive) no longer on this Mac; PR 19 does not touch search. sorter: needs a screenshot-well fixture. in-place-update: covered by PR 13's proof; the real one-click upgrade from alpha.21 to alpha.22 through the published feed was not exercised (the Pro was upgraded by replacing the app).

## Scratch (not removed)
Real-data copies and the CI download were removed. Left: the session scratchpad `sw22/` (job scripts and logs; `out/cmp-*.json`, `out/real-start*.json` and `out/real-start-triage.png` name real screenshot files); in the worktree `release/mac-arm64/` and `out/upkeep-smoke/archive-*`.

DTC: `_DTC/slidewell/2026-11-24-check-alpha22-missing-folder.md`

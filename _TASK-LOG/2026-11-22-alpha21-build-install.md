---
entity_type: task
id: 2026-11-22-alpha21-build-install
title: "Build, prove and install 0.4.0-alpha.21 on the MacBook Pro"
status: done
created_at: 2026-11-22T20:45:00Z
updated_at: 2026-11-22T23:05:00Z
requested_by: dominik
request_source: coordinator thread (T3 3212f315)
audit:
  agent: Claude Opus 5.5 (builder)
  machine: MacBook Pro
  cwd: slidewell.worktrees/release-0.4.0-alpha.21
scope: [release, install]
blocked_by: []
waiting_on: coordinator review and merge of PR 18
next_action: Merge PR 18; restart the Mac (or fseventsd) so file notifications work again
---

# Build, prove and install 0.4.0-alpha.21

## Request
Build 0.4.0-alpha.21 from main 2fd575d (PR 13 one-click updates, PR 15 watcher tests, PR 16 captures without file notifications, PR 17 sharp 0.35.5), prove it on made-up data and a copy of the real data, install in place of alpha.20.

## What was done
- Branch `release/0.4.0-alpha.21`, commit 117e467: version and three What's new notes (`src/main/update-notices.ts`). PR 18, not merged by the builder.
- Studio: typecheck exit 0; Vitest 102 files, 1,213 passed, 1 skipped, exit 0.
- Packaged on the Pro through the laptop slot: `npm run build && npx electron-builder --mac dir --arm64 -c.mac.notarize=false`. Developer ID Application (M7H45AGG8A), hardened runtime, not notarised (Gatekeeper: "Unnotarized Developer ID"), same as alpha.20.
- sharp 0.35.5 on the signed app: `codesign --verify --deep --strict` passes; `sharp-darwin-arm64-0.35.5.node` and `libvips-cpp.8.18.7.dylib` are signed with team M7H45AGG8A, runtime flag. A made-up WebP and PNG in the well inbox were stored as WebP in 8 s, same output names as alpha.20.
- Backup: `~/SlideWell/backups/data-2026-11-22-before-alpha.21/` (userData + well, 1,533 files) with `SHA256SUMS-userData.txt` and `SHA256SUMS-well.txt`; copy verified, and the live data re-verified against the sums just before install. alpha.20 app moved to `~/SlideWell/backups/SlideWell-0.4.0-alpha.20-2026-11-22.app` (signature still verifies).
- Old against new on separate copies of the real data (archive as APFS clone, watched folders pointed at empty scratch folders, mock keychain): library stats, categories, Triage counts and first 200 items, Triage apps, paths, storage, owners, sorter, every database table's row count, config untouched — all identical. Both rewrote only `picture-search.db` (the indexer, caused by rebasing the copy's archive path) and mirrored the rewritten paths into `settings.json`.
- Installed and started on the real library: 727 presentations, 48,683 slides, 14,700 images, 185 categories; picture search 63,358 indexed; sorter last retrain 16 Oct. Triage 22,554 = copy's 22,526 + 28 new named Desktop screenshots. A made-up capture in a temporary watched folder reached Triage in 22 s, was marked excluded, and the folder was removed again; config.json and settings.json are identical to the backup afterwards.

## End-to-end on the packaged app (made-up data)
Pass: smoke, triage, review, sorter-cloud, backlog-import, look-alike, used-in-talks, review-ui, auto-sorting-ui (the last two after installing the Playwright headless shell 1223), update-notices (source build: the packaged app refuses the loopback test feed by design).
Fail, same on alpha.20 today: settings `watcherFollowsCli`; match-switch "Words shows the quiet hint"; more-like-this stops at its no-model run (11 checks pass first); picture-search "new well image embedded as it arrives" (first run) and a timing step on the rerun (alpha.20 identical).
Not run: sorter (needs a screenshot-well fixture not on this Mac); in-place-update (covered by PR 13's own proof).

## Found
macOS fseventsd on the Pro is at 100% CPU, 1.1 GB, up 8 days, and delivers no file events to any program (plain Node `fs.watch` test gets nothing). This is why the watcher checks fail on both versions. PR 16's once-a-minute rescan is what still brings captures in. A restart of the Mac should fix it.
The Triage source `OneDrive-Nexus365(2)/Screenshots` no longer exists: OneDrive renamed the folder on 29 Oct 2026. Its 12,644 rows remain.

## Scratch (not removed)
`$TMPDIR` (/var/folders/7h/b0l9rp7s1xg8rvrhhw3sh5xw0000gn/T/): `sw21-*.log`, `sw21-e2e*/`, `sw21-cmp-*.json`, `sw21-real-start.json`, `sw21-test-capture.mOruG2/`, `fswtest.*`; `/tmp/sw-cmp-old-95d8Ce`, `/tmp/sw-cmp-new-*` (real-data copies, archive as clones), `/tmp/sw-sharp-*`, `/tmp/sw-idx.OAXFn6`, smoke archives `out/upkeep-smoke/archive-witi0n` and `archive-BxQLCJ` in the worktree; `release/mac-arm64/` in the worktree.

DTC: `_DTC/slidewell/2026-11-22-check-alpha21-captures.md`

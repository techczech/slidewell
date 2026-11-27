---
entity_type: task
id: 2026-11-27-alpha24-air-finder-all-decks
title: "Cut, prove, publish and install 0.4.0-alpha.24: all own decks in the Air finder"
status: done
created_at: 2026-11-27T15:45:00Z
updated_at: 2026-11-27T18:45:00Z
requested_by: dominik
request_source: coordinator thread (T3 3212f315)
audit:
  agent: Claude Opus 5.5
  machine: MacBook Pro
scope: [release, publish, install, real-data, air-finder]
---

# alpha.24: all own decks in the Air finder

## Release
- Includes since alpha.23 (5d6dbc9): PR 39 (later Exclude survives an import), PRs 40 to 42 (finder worker bundle test, worker restart, search responsive under preview load), PR 44 (deck names with spaces etc.; Watched folders layout; Meaning controls hidden when off), PR 45 (deck must be its own real allowlisted directory; NFC; archive root resolved once).
- PR 46 (version, two What's new notes) merged as eea256b. Release run 46029961236 (workflow_dispatch on main): tests, build, signed and notarised package, feed-entry check green; draft release, tested, then published as prerelease (not Latest; 0.3.1 stays Latest).
- Zip SHA-256 2986038d834862ec7d96869d59ce75a6baafcd20c4f5d2cb6103990e9b03a95c: the draft download that was tested and the published download are identical. spctl "accepted, source=Notarized Developer ID"; stapler valid; codesign valid; 0.4.0-alpha.24; net.dominiklukes.slidewell.
- PR 47: feed alpha channel → alpha.24. **Found:** the alpha.23 feed's first summary line was 123 characters (limit 120), so `parseChannelFeed` rejected the whole feed from 15:09 to the merge of PR 47 and no alpha user was offered alpha.23. New `test/published-feed.test.ts` reads docs/updates.json with the app's reader (fails on the alpha.23 feed, passes now). alpha.23 with alpha on is offered alpha.24; off, nothing.

## Checks
- Studio (remote-test, a37bb80): install, build (typecheck + electron-vite) exit 0; Vitest 106 files passed, 1 skipped; 1,247 tests passed, 2 skipped; `test:air-finder-dom` 1 passed.
- Laptop slot, notarised CI app via `SLIDEWELL_E2E_EXECUTABLE`, made-up data: smoke, capture-folders, triage, review, settings, sorter-cloud, backlog-import, look-alike, used-in-talks, review-ui, auto-sorting-ui all pass. Source build: update-notices pass, air-finder pass.
- Not run: match-switch, more-like-this, picture-search (need an indexed search fixture not on this Mac), sorter (needs a screenshot-well fixture), in-place-update (the Pro was upgraded by replacing the app).

## Proof on a copy of the real data
- APFS clones of userData, well and archive (watched folders and OneDrive pointed at scratch, mock keychain). Installed alpha.23 vs alpha.24: library stats (727 decks, 48,683 slides, 14,700 images), Triage counts (23,028), first 200 Triage rows, apps, paths, storage, owners, Review piles, capture sources and row counts of all 52 tables identical apart from the copy folder names; triage_decisions identical (601 excluded, 652 included, same rows); config.json and settings.json unchanged.
- Finder on the copy (alpha.24 CI app, scratch socket, allowlist = the 727 `mine` presentations + the 663 well images): each deck probed by a word search built from its own slides (two rare words). 721 of 727 found first time; one more (PF2019, only "PF 2019" on its slides) and "2 Sandra and Chloe- Practical Prompting" (first probes came from slides 157 to 159, which have no renders) were found on the live check with better probes. All 727 decks exist as real directories, none hidden, none symlinked, no name mismatch, all with renders.
- Not findable by words: 4 decks whose slides have no title or text: "AI Debate Slides for All LT - DL Draft - Feb 2024", "Conversation is the new reading-NotebookLM recording", "MOOC Šablona konečná", "Přípravný kurz". Not the finder's fault.
- Timing with all decks listed: search 4 to 5 ms (an "AI" search with 40 results 47 to 58 ms), preview 11 to 15 ms (WebP), download 2 to 3 ms with SHA-256 equal to `X-SlideWell-SHA256`.

## Install
- Backup: `~/SlideWell/backups/data-2026-11-27-before-alpha.24/` (userData 74 files, well 1,462 files, and `finder/finder.json`; SHA256SUMS-*.txt beside them; copy verified), made after quitting SlideWell.
- `/Applications/SlideWell.app` replaced (`rm -rf` + `ditto`) with the notarised CI app; Gatekeeper accepts it. alpha.23 rebuilds from 5d6dbc9.
- `~/.slidewell-finder/finder.json`: `presentations` rewritten from the 15 alpha.23 accepted to all 727 `mine` decks (0600, folder 0700); other fields unchanged.
- Hidden start on the real library: 727 decks, 48,683 slides, 14,700 images; Triage 23,028; "v0.4.0-alpha.24", "Updated to 0.4.0-alpha.24 · What's new"; config.json and settings.json identical to the backup; triage_decisions identical.
- Restarted with `open -g -a /Applications/SlideWell.app --args --air-finder-config=…` (as the launcher, in the background); socket up, no TCP listener.
- From the Pro over the socket: 723 of 727 decks found (707 of 711 with spaces); the 4 missing are the picture-only decks above.
- From the Air (SSH forward to the socket): page 200; "abandonment" (only in "1 Digital Accessibility-Principles and practice") found in 0.03 s; preview WebP 0.05 s; download 0.05 s, checksum match; POST 405; foreign Host 403.

## List (did not block)
- The feed has no CI check; the new unit test covers it through `npm test` in the release workflow.
- Picture query endpoint refuses long socket paths ("socket path too long") in scratch copies; real install unaffected.

DTC: `_DTC/slidewell/2026-11-27-check-alpha24-air-finder-all-decks.md` (supersedes the alpha.23 check)

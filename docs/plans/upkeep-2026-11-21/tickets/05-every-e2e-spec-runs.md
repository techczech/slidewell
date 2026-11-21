# 05 — Every end-to-end spec can be run by name and has run once on the current line

**What to build:** Each spec in `e2e/` has an `npm run test:<name>` script, every spec cleans up its scratch on failure, and each has been run once on the current line through `agent-run`. A spec that no longer matches the app is fixed if the fix is in the spec, or listed in the pull request if the app has changed in a way the spec cannot follow.

**Defect and evidence:** `e2e/` has 14 specs; `package.json` names seven (`smoke`, `triage`, `review-ui`, `auto-sorting-ui`, `review`, `sorter-cloud`, `settings`). `backlog-import`, `look-alike`, `match-switch`, `more-like-this`, `picture-search`, `sorter` and `used-in-talks` have no script. Commit `b9be929` ("specs that drove the old Settings panel now drive the Settings window") edited several unnamed specs for the shared Settings window; there is no record that they were run afterwards. SlideWell has no CI that runs tests (`.github/workflows/release.yml` packages only).

**Feature / journey:** groundwork: picture search, look-alike groups, used in talks and backlog import stay checked.
**Design:** none.
**Blocked by:** 01.
**Seams under test:** the hidden-Electron e2e harness each spec already uses.

**Real-path test that proves it:** each spec once through `~/.local/bin/agent-run` (one at a time, detached, long wait), results table in the pull request: spec, result, time, first failure line. Specs that need the real archive or a downloaded model say so and are run only if the fixture exists on this Mac; otherwise listed as not run with the reason.

- [ ] 14 scripts, one per spec.
- [ ] Every spec removes its scratch folder on failure too.
- [ ] Results table in the pull request; no spec silently skipped.
- [ ] No real archive, well or `userData` is written by any spec (check each spec's scratch root before running it).

**May touch:** `package.json` scripts, `e2e/*.mjs`.
**Must not touch:** `src/` (a failure caused by the app goes in the pull request as a finding, not fixed here).
**Boundary:** none → normal review.
**Status:** ready

# 11 — Watcher tests without fixed sleeps

**What to build:** Unit tests drive the watcher's event and timer boundaries deterministically. The Triage end-to-end spec waits for the specific fixture rows to appear without a manual scan.

**Defect and evidence:** All four watcher unit tests failed on the Studio at `8075c9e`. They used fixed sleeps as evidence that the OS had delivered events. In a separate Studio probe, a direct Node directory watcher delivered no events during the eight-second observation window. The Triage watch check polled for a count, so unrelated rows could end its wait before both expected files appeared.

**Feature / journey:** Capture a screenshot into a configured source and see it in Triage. A talk outline or a change in vault pool membership triggers a rescan.
**Design:** none.
**Blocked by:** 01.
**Seams under test:** `fs.watch` event delivery into the debounce and path filter, vault pool event routing, hidden Electron with real filesystem events and Triage IPC.

**Real-path test that proves it:** Ten consecutive passes of `test/source-watcher.test.ts` on the Studio under load, a full Studio Vitest run with zero failures, and `npm run test:triage` through laptop `agent-run` using its isolated fixture.

- [ ] Accept filter, max-wait, pool image add/remove, ignored pool descendants and pool symlink replacement all checked.
- [ ] Triage waits for both exact names in their expected sources, then checks parsed fields and ignored files.
- [ ] Quote pass counts and record any runtime watcher defect separately from test timing.

**May touch:** `test/source-watcher.test.ts`, `e2e/triage.mjs`, watcher implementation if evidence identifies a product defect.
**Boundary:** none → normal review.
**Status:** ready

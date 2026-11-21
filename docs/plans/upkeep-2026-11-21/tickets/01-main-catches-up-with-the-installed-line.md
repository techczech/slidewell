# 01 — main catches up with the installed line

**What to build:** Merge `feat/shared-settings` (0.4.0-alpha.16–19, the build installed on the Pro since 20 October) into `main`, so that `main` is again the line the installed app is built from and every later ticket branches from `main`.

**Defect and evidence:** `/Applications/SlideWell.app` is 0.4.0-alpha.19 (20 Oct). `main` is at 0.4.0-alpha.15 plus three website commits (`d7320fb`, `e86657a`, `6116a0c`); `feat/shared-settings` carries nine commits (shared Settings window, settings migration from `config.json`, R2 save, command registry, settings CLI) that were reviewed in rounds (commit messages of `4a3020b`, `0a4ecfc`, `0e90401`) but never merged. `git merge-tree` shows the merge is clean. An agent starting from `main` today rebuilds alpha.15 and loses the shared Settings.

**Feature / journey:** release line hygiene; 0.4.0 release record `_DTC/slidewell/releases/0.4.0.md`.
**Design:** none.
**Blocked by:** None — dispatchable now. Every other SlideWell ticket in this folder assumes it has landed.
**Seams under test:** the build and the unit suite.

**Real-path test that proves it:** after the merge, `node scripts/fetch-app-patterns.mjs`, `npm ci`, then `npm run build` and `npx vitest run` through `~/.local/bin/agent-run` (detached, long wait); attach the summary lines. `package.json` version on `main` reads 0.4.0-alpha.19.

- [ ] `main` contains every commit of `feat/shared-settings` and the three website commits.
- [ ] Build and unit suite pass on the merged `main` (or failures are listed with their first error, and none is new relative to `feat/shared-settings`).
- [ ] No version bump beyond what the branch already carries.

**May touch:** git history of `main` (a merge commit, pushed through a pull request).
**Must not touch:** any source change beyond conflict resolution (there should be none); `feat/shared-settings` itself.
**Boundary:** none → normal review.
**Status:** ready

# 07 — The renderer root is split by view

**What to build:** `src/renderer/src/App.tsx` keeps the shell (title bar, tabs, status bar, shared state); Search with its filter bar, results grid and lightbox, and the remaining Convert and Others' Library panels move into their own files, as Review, Triage and Auto sorting already are. No visible change.

**Deepening and evidence:** `App.tsx` is 2,658 lines (26 commits in eight weeks). The alpha.16 change removed about 660 lines of the old Settings panel from it, which shows the file still mixes several features. `Review.tsx`, `AutoSortingTab.tsx` and `SortPiles.tsx` show the pattern.

**Feature / journey:** groundwork for search and picture search.
**Design:** none; current look is the reference.
**Blocked by:** 02 (a real typecheck must guard a renderer move of this size).
**Seams under test:** `npm run typecheck`; the renderer-mock e2e specs (`test:review-ui`, `test:auto-sorting-ui`) and `test:smoke`.

**Real-path test that proves it:** typecheck; `test:smoke`, `test:review-ui` and `test:auto-sorting-ui` through `agent-run`; before/after screenshots of Search with results and the lightbox open, attached to the pull request.

- [ ] `App.tsx` under about 800 lines.
- [ ] Screenshots match; the three specs pass.

**May touch:** `src/renderer/src/*`.
**Must not touch:** preload, main process, `styles.css` beyond moving rules with their component.
**Boundary:** none → normal review.
**Status:** ready

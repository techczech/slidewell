# 02 — The typecheck actually checks the main process and the renderer

**What to build:** `npm run typecheck` checks both TypeScript projects (main/preload and renderer) and fails on a type error in either; `build`, `pack` and `dist:mac` run it. Every type error it then reveals on the current line is fixed without changing behaviour.

**Defect and evidence:** `tsconfig.json` is `{"files": [], "references": [node, web]}`. Plain `tsc --noEmit` on a solution-style config with an empty file list checks nothing, so `typecheck`, `build` (`tsc --noEmit && electron-vite build`) and `dist:mac` have passed vacuously since the split; `AGENTS.md`'s "npm run build passes before reporting done" proves nothing about types. The fix was written on 17 Oct on `origin/codex/slidewell-real-typecheck` (`0ad56bd`: `typecheck:node` and `typecheck:web` with `-p … --composite false`, plus one `Buffer` annotation in `src/main/well.ts`) but never merged; since then alpha.16–19 added about 2,800 lines (settings host, migration, command registry, R2 save) that have never been typechecked. The renderer mocks (`src/renderer/src/sw-mock.ts`, `review-mock.ts`) are typed as `SwApi` precisely so drift from the preload is caught; with no typecheck it is not.

**Feature / journey:** groundwork: every later change is checked.
**Design:** `0ad56bd` on `origin/codex/slidewell-real-typecheck` is the reference change; cherry-pick it or redo it.
**Blocked by:** 01.
**Seams under test:** `npm run typecheck` itself.

**Real-path test that proves it:** with the new scripts, put a deliberate wrong assignment in one main-process file and one renderer file: each makes `npm run typecheck` fail, naming the file; remove both. Then `npm run typecheck` passes on the branch. `npm run build` through `agent-run`.

- [ ] `typecheck` runs both projects; a renderer-only and a main-only error each fail it.
- [ ] All revealed errors fixed with type-level changes; any fix that would change runtime behaviour is listed in the pull request instead and left with a `// TODO(typecheck)` cast — no behaviour change in this ticket.
- [ ] If more than about 40 errors appear, fix the main-process project first and stop; record the renderer count for a follow-up ticket.

**May touch:** `package.json` scripts, `tsconfig*.json` only if needed for `-p`, type annotations anywhere in `src/`.
**Must not touch:** runtime logic, dependency versions, the lockfile.
**Boundary:** none → normal review.
**Status:** ready

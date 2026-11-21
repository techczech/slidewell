# 06 — The main process is split by area

**What to build:** `src/main/index.ts` keeps app start-up, windows and protocol handlers; the IPC handlers for the Others' Library (choose root, clear, delete matching), capture sources and the archive ingest/convert streams move into one module each with an `install(deps)` function. Behaviour and IPC channel names are unchanged.

**Deepening and evidence:** `src/main/index.ts` is 1,806 lines and the hottest file of the last eight weeks (44 commits). The Others' Library delete handlers (`settings:clear-others-library`, `others:delete-matching`) remove folders with `rmSync(…, {recursive: true, force: true})` in the middle of unrelated wiring; keeping destructive handlers in a small module with its own tests makes them reviewable. The estate split rule is about 800 lines.

**Feature / journey:** groundwork for Others' Library and capture sources.
**Design:** ADR-0031 delete-by-filter (presentation-system) — behaviour unchanged.
**Blocked by:** 04 (both edit `index.ts`; 04 extracts config first).
**Seams under test:** each new module's `install(deps)` with a fake IPC registrar and temp folders.

**Real-path test that proves it:** a unit test for the Others' Library module: `delete-matching` with two decks in a temp Others root deletes only the matching deck folder and never touches a sibling personal-archive root passed in deps; `clear` refuses when the two roots overlap. Then `npm run test:smoke` through `agent-run`.

- [ ] `index.ts` under about 1,000 lines; no handler logic left for the moved areas.
- [ ] The overlap guard and the confirmation dialogs are unchanged.
- [ ] Smoke spec passes.

**May touch:** `src/main/index.ts`, new modules under `src/main/`, tests.
**Must not touch:** `src/preload/index.ts` types and channel names, `src/main/archive.ts` queries.
**Boundary:** moves delete code without changing it → normal review; any change to what is deleted → **Opus review**.
**Status:** ready

# SlideWell

## What this is

Electron desktop app for the slide & image archive — "the well". Companion to TalkWeaver: what TalkWeaver is to the Vault, SlideWell is to the archive. It **reuses Core A's (`ppt-archive`) extraction / render / OCR / dedup / search engine** and redesigns the storage; it supersedes Core A's browser web-app and the `raycast-slide-search` proof-of-concept. Design: **ADR-0026** (and CONTEXT.md `SlideWell` / `Added image`, ROADMAP P7) in `presentation-system`.

## Direction layer lives elsewhere

Like TalkWeaver, SlideWell carries **no `CONTEXT.md` or `docs/adr/`** of its own. The glossary and binding ADRs are central in `~/gitrepos/05_ppt-tools/presentation-system/` (CONTEXT.md, docs/adr/, ROADMAP.md, CONTEXT-MAP.md). Read those before touching architecture. This repo holds only the **execution layer** (`_CHANGELOG/`, `_TASK-LOG/`, `_AGENT-INSTRUCTIONS/`) + code.

## First move

Read `_TASK-LOG/RESUME.md`, then `_CHANGELOG/INDEX.md` for shipped history.

## Locked decisions (from the 2026-06-18 grill — see presentation-system)

- **Layered authority**: SlideWell *owns* the extractions of the legacy PPTX archive + the *added images* (the well); it only *catalogues* current Talks (Outlines stay canonical in git, ADR-0001). Originals are extracted in place, referenced by content-hash, preserved cold — never copied in.
- **One Image Node** entity shared with TalkWeaver; `provenance` = `extracted | added`; one pool, **tags + search only, no folders**.
- **Identity/provenance/versioning (ADR-0026)**: `{#id}` only in the Outline; SlideWell owns lineage/drift/version history *externally* as a lightweight, approximate, git-referenced index (full + partial hashing). **Self-describing files** named `{slug}--{hash}.ext` — discovery never fully depends on the database.
- **Shared-disk boundary**: both apps read the on-disk DBs/media-store; **SlideWell owns all writes + heavy work**; semantic search served by SlideWell's local process, FTS-degraded when off.

## Key files

- `src/main/index.ts` — main process: window, `sw*` protocol handlers, archive detection, IPC
- `src/preload/index.ts` — typed IPC bridge (`window.sw`); the single source of truth for IPC types + the shared `ImageNode` shape
- `src/renderer/src/App.tsx` — root shell (search + scope + status)
- `src/renderer/src/styles.css` — shared ecosystem palette (warm paper + Oxford blue)
- `userData/config.json` — archive root + window bounds (written by main process)

## Commands

- `npm run dev` — dev server + Electron (HMR on renderer)
- `npm run build` — `tsc --noEmit && electron-vite build`
- `npm run dist:mac` — packaged `.app` into `release/`
- `electron .` — run production build

## Architecture

Three-process Electron: **main** (Node.js, file I/O, IPC, `sw*` protocols) → **preload** (contextBridge, typed `window.sw`) → **renderer** (React, browser context). Never add Node.js APIs to the renderer — use IPC. Heavy work (extraction, OCR, embeddings) runs in Core A's Python pipeline, invoked from main — not in the renderer.

## Constraints

- Archive root config: `userData/config.json` only (no electron-store — ESM/CJS conflict)
- IPC types live in `src/preload/index.ts`; keep them the single source of truth
- `window.sw` is the only renderer→main bridge; no direct Node.js in renderer
- electron v42.4.0 pinned (matches TalkWeaver); do not upgrade past the 7-day release gate
- Scaffold carries TalkWeaver's full devDeps incl. CodeMirror — prune unused once the surface settles (backlog)

## Self-Healing

On user correction: classify, route, optionally promote. Protocol: `_AGENT-INSTRUCTIONS/self-healing.md`.

## Verification

- `npm run build` passes before reporting done
- `git status` clean and pushed before reporting done

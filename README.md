# SlideWell

**Your slides and images in one place — the well.**

SlideWell is a desktop app for browsing, searching, and reusing every slide and image you have: the whole legacy PowerPoint archive *and* a growing well of images you collect for later. It is the companion to [TalkWeaver](../talk-weaver) — TalkWeaver authors presentations; SlideWell is where their raw material lives and is found.

## What it does

- **Imports PowerPoint** (a file or a whole folder) and extracts each slide's text, structure, a slide render, and the images inside it — reusing the proven `ppt-archive` (Core A) engine.
- **Searches everything together** — slide text, OCR'd text from images, and (planned) multimodal embeddings for finding images by what they show.
- **Holds an image well** — drop in screenshots and found images you might use later; they're auto-tagged and instantly findable. No folders, just tags and search.
- **Feeds TalkWeaver** — pull a slide or image straight into a presentation, with reuse, lineage, and versioning tracked by SlideWell, not baked into your Markdown.

## Status

Early scaffold. The architecture is decided (see below); the app shell builds and launches. Search, import, the well, and embeddings are the build order in `_TASK-LOG/RESUME.md`.

## Architecture

Electron + React + TypeScript (electron-vite), mirroring TalkWeaver for shared UI and one Image Node model across both apps. Heavy work (extraction, OCR via macOS Vision, embeddings via MLX) runs in Core A's Python pipeline; the app shell is a fast UI over the on-disk archive.

Direction layer (glossary + binding decisions) lives centrally in [`presentation-system`](../../05_ppt-tools/presentation-system): **ADR-0026**, CONTEXT.md (`SlideWell`, `Added image`, `Image Node`), ROADMAP P7.

## Develop

```sh
npm ci
npm run dev      # dev server + Electron, renderer HMR
npm run build    # typecheck + production build
```

Requires the `ppt-archive` extraction store for real data; without it the app launches and reports "archive not found" (choose its folder in the status bar).

# SlideWell

**Your slides and images in one place — the well you draw slides and images from.** Companion to [TalkWeaver](https://talkweaver.app).

SlideWell browses, searches, and reuses every slide and image you have: the whole legacy PowerPoint archive *and* a growing well of images you collect for later. TalkWeaver authors presentations; SlideWell is where their raw material lives and is found.

**Website & downloads:** [talkweaver.app/slidewell](https://talkweaver.app/slidewell) · macOS · MIT.

## What it does

- **Imports PowerPoint** (a file or a whole folder) and extracts each slide's text, structure, a slide render, and the images inside it — reusing the proven `ppt-archive` (Core A) engine.
- **Searches everything together** — slide text and OCR'd image text — and browses three ways: individual **Slides**, standalone **Images**, or whole **Decks** by their title slide.
- **Triages screenshots & short videos** — point it at a folder (e.g. OneDrive); it scans recursively, OCRs for search, and you keep the ones worth reusing into the well and dismiss the rest (decisions remembered by content hash).
- **Holds an image well** — net-new screenshots and found images, organised by tags + search, never folders.
- **Feeds TalkWeaver** — copy a slide's image (WebP), PNG, text, structure, or reference; see any slide in the context of its whole presentation. Keyboard-first (⌘K command palette), entirely local.

## Status

Early / soft launch. Downloads are built in CI and are **not Apple-notarised** — the first launch needs right-click → **Open** (or `xattr -dr com.apple.quarantine "/Applications/SlideWell.app"`). The app currently relies on a local engine — the `ppt-archive` Core A toolchain, the macOS Vision OCR helper, and `ffmpeg`; bundling these so it runs self-contained on any Mac is in progress. Direction layer (glossary + binding decisions) lives in [`presentation-system`](https://github.com/techczech/presentation-system) (ADR-0026/0029/0030, CONTEXT.md).

## Develop

```sh
npm install
npm run dev          # electron-vite dev (renderer HMR + Electron)
npm run build        # typecheck + build main/preload/renderer
npm run test:smoke   # Playwright _electron smoke test
npm run test:triage  # isolated triage end-to-end
npm run icon         # regenerate build/icon.icns
npm run dist:mac     # package a DMG into release/
```

Releases are cut by tagging — `git tag v0.1.0 && git push --tags` → `.github/workflows/release.yml` builds the DMG and opens a draft GitHub Release. Needs the `ppt-archive` store for real data; without it the app launches and reports "archive not connected" (point it at your folder in Settings).

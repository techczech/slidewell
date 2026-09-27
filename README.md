---
name: "SlideWell"
description: "Treats slides and images as a reusable creative well rather than files lost inside old presentations."
categories: [desktop-apps, desktop-app, built-by-ai]
updated: 2026-07-16
deployments:
  Release:
    "Latest release": https://github.com/techczech/slidewell/releases/latest
---
# SlideWell

**Your slides and images in one place — the well you draw slides and images from.** Companion to [TalkWeaver](https://talkweaver.app).

SlideWell browses, searches, and reuses every slide and image you have: the whole legacy PowerPoint archive *and* a growing well of images you collect for later. TalkWeaver authors presentations; SlideWell is where their raw material lives and is found.

Part of the TalkWeaver family: [talkweaver.app/tools/slidewell](https://talkweaver.app/tools/slidewell) · macOS (Apple Silicon) · MIT.

## What it does

- **Imports PowerPoint** (a file or a whole folder) and extracts each slide's text, structure, a slide render, and the images inside it — reusing the proven `ppt-archive` (Core A) engine.
- **Searches everything together** — slide text and OCR'd image text — and browses three ways: individual **Slides**, standalone **Images**, or whole **Decks** by their title slide.
- **Triages screenshots & short videos** — point it at a folder (e.g. OneDrive); it scans recursively, OCRs for search, and you keep the ones worth reusing into the well and dismiss the rest (decisions remembered by content hash).
- **Holds an image well** — net-new screenshots and found images, organised by tags + search, never folders.
- **Feeds TalkWeaver** — copy a slide's image (WebP), PNG, text, structure, or reference; see any slide in the context of its whole presentation. Keyboard-first (⌘K command palette), entirely local.

## Install

1. Download [`SlideWell-mac-arm64.dmg`](https://github.com/techczech/slidewell/releases/latest/download/SlideWell-mac-arm64.dmg) from the [latest release](https://github.com/techczech/slidewell/releases/latest) (Macs with Apple Silicon).
2. Open the DMG and drag **SlideWell** to Applications.

Release builds are signed with a Developer ID certificate and notarised by Apple, so SlideWell opens without a Gatekeeper warning. A ZIP of the app (`SlideWell-mac-arm64.zip`) is attached to each release as well. For the tools SlideWell uses for import, OCR and video, see [REQUIREMENTS.md](REQUIREMENTS.md).

## Status

Early / soft launch. The app currently relies on a local engine — the `ppt-archive` Core A toolchain, the macOS Vision OCR helper, and `ffmpeg`; bundling these so it runs self-contained on any Mac is in progress. The glossary and binding design decisions live in a separate design repository.

## Develop

```sh
npm install
npm run dev          # electron-vite dev (renderer HMR + Electron)
npm run build        # typecheck + build main/preload/renderer
npm run test:smoke   # Playwright _electron smoke test
npm run test:triage  # isolated triage end-to-end
npm run icon         # regenerate build/icon.icns
npm run dist:mac     # package a DMG + ZIP into release/ (unsigned unless a Developer ID is available)
```

Releases are cut by tagging a version that matches `package.json` — `git tag v0.3.1 && git push origin v0.3.1` → `.github/workflows/release.yml` runs the tests, builds, signs with the Developer ID certificate, notarises, and uploads `SlideWell-mac-arm64.dmg` and `SlideWell-mac-arm64.zip` to a draft GitHub Release; review it, then publish. Needs the `ppt-archive` store for real data; without it the app launches and reports "archive not connected" (point it at your folder in Settings).

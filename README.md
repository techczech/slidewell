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

## Settings

SlideWell › Settings… (⌘,) opens the Settings window: folders, screenshots, sorting and storage, keyboard shortcuts, the R2 and model-provider keys (kept encrypted in the macOS keychain, never shown), a list of every change with Reset, and export and import of a settings file. Settings live in `settings.json` in the app's data folder. On the first launch of 0.4.0-alpha.16 the preferences in `config.json` are copied into it; `config.json` itself is left as it was, so an older SlideWell still finds its own settings.

### Settings from the command line

```
bun bin/slidewell.mjs settings list [--json]
bun bin/slidewell.mjs settings get <key>
bun bin/slidewell.mjs settings set <key> <value>
bun bin/slidewell.mjs settings reset <key>
bun bin/slidewell.mjs settings changes
bun bin/slidewell.mjs settings export <file>
bun bin/slidewell.mjs settings import <file> [--yes]
```

Changes made here are recorded as made by an agent and show in an open Settings window within a second. Keys cannot be read or set from the command line. `SLIDEWELL_DATA_DIR` points both the app and the command line at another data folder.

An imported settings file never sets the Python SlideWell runs or the R2 account, bucket and endpoint; those are skipped as “not importable”. The Others’ Library folder can never be the same as your archive folder or inside it (or the other way round), whether it is set in the window, from the command line or by an import.

## Develop

In a fresh clone, run `npm run fetch:app-patterns` before installing dependencies.

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

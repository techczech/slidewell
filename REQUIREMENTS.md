# SlideWell — requirements & setup

SlideWell is a thin, fast UI over a few external tools that do the heavy lifting (extraction,
rendering, OCR, video). The app **degrades gracefully**: anything missing just disables the
feature that needs it — the app still launches and everything else works. Settings → **Requirements**
shows you, live, which of these are found on your machine.

> macOS, Apple Silicon. The download isn't Apple-notarised yet, so on first launch right-click the
> app → **Open** (or `xattr -dr com.apple.quarantine "/Applications/SlideWell.app"`).

## What each tool is for

| Tool | Needed for | If missing |
|------|-----------|------------|
| **ppt-archive engine** (Core A) | Slide/Deck **search** and PPTX **import** | Search & import are unavailable; the image **well** and **triage** still work |
| **Python 3** + `python-pptx`, `Pillow`, `lxml`, `pdf2image` | PPTX **import** (text, structure, embedded images) | Import is unavailable |
| **macOS Vision OCR helper** (`vision_ocr`, ships with ppt-archive) | **Text search inside images & screenshots** | Images/screenshots are still browsable; just not searchable by their text |
| **ffmpeg** | Video **poster frames** & triage **playback** | Videos show without a thumbnail; no inline playback |
| **LibreOffice** (`soffice`) + **Poppler** (`pdftoppm`) | Slide **render thumbnails** (PPTX → PDF → image) | Slides import without a visual render; everything else about them works |

Only the **ppt-archive engine** gates a whole feature area; the rest are per-feature niceties.

## Install

```sh
# Homebrew (https://brew.sh) is the easiest route on macOS:
brew install ffmpeg poppler            # video posters + slide-render rasterising
brew install --cask libreoffice        # slide-render thumbnails (≈500 MB)

# Python deps for import (any Python 3.10+):
pip install python-pptx Pillow lxml pdf2image
```

- **The archive engine:** clone [`techczech/ppt-archive`](https://github.com/techczech/ppt-archive)
  and point SlideWell at it in **Settings → Archive folder**. It carries the extractor, the render
  pipeline, and the `vision_ocr` helper.
- SlideWell looks for `soffice`/`pdftoppm`/`ffmpeg` in `/opt/homebrew/bin`, `/usr/local/bin`,
  `/usr/bin`, and (for LibreOffice) `/Applications/LibreOffice.app`. If you installed them elsewhere,
  symlink them into one of those.

## Checking what's detected

Open **Settings** (⚙ in the toolbar). Each tool shows ✅ found / ⚠️ missing, where it was found, what
it's for, and the one-line install command. This page is linked from there too.

> Bundling these so SlideWell runs fully self-contained (no separate installs) is planned — but
> LibreOffice is ~500 MB and can't ship inside the app, so slide renders will likely always rely on
> a local LibreOffice. The other tools are on the bundling roadmap.

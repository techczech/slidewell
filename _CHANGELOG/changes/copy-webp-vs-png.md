---
title: "Copy image: WebP file (default) vs PNG (explicit)"
id: copy-webp-vs-png
date: 2026-06-19
type: change
status: shipped
tags: [actions, clipboard, talkweaver, webp]
---

# Copy image: WebP file (default) vs PNG (explicit)

Split the copy-image action in two, because most pastes target TalkWeaver, whose paste handler (`Editor.tsx`) reads an `image/*` clipboard item and re-encodes to WebP via sharp.

- **Copy image (WebP → TalkWeaver)** — copies the render's actual WebP *file* to the macOS clipboard (via `osascript … set the clipboard to POSIX file`). A pasted `image/webp` file is kept as-is by TalkWeaver (no PNG round-trip). Verified: clipboard holds a `file` reference to the `.webp` render.
- **Copy as PNG** — the previous behaviour, now its own command: decodes the WebP render to a PNG raster bitmap (`sharp` → `nativeImage` → `clipboard.writeImage`) for Keynote / Slack / web that want a pasted image rather than a file.

Both live in the per-result action menu. Build clean; smoke test sees 9 menu actions.

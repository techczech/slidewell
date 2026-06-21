---
title: "Distribution foundation: icon, DMG, CI release, landing page (Phase 1)"
id: distribution-foundation
date: 2026-06-21
type: change
status: shipped
tags: [packaging, distribution, ci, github-releases, website, icon, adr-0030]
---

# Distribution foundation (ADR-0030, Phase 1)

Groundwork to share SlideWell as a soft, public launch (mirrors Highlight Scout).

- **App icon** — `build/make-icon.mjs` rasterizes an inline SVG (Oxford-blue + claret, a stack of slides) via sharp → `build/icon.icns` (+ `icon.png`). Replaces the default Electron icon; placeholder, easy to swap (`npm run icon`).
- **DMG packaging** — `build.mac.target` `dir` → **dmg**, icon wired, version `0.0.1` → `0.1.0`. `npm run dist:mac` now produces `release/SlideWell-<v>-arm64.dmg` (verified, 125 MB); `npm run pack` keeps the quick `.app` build. `publish` config points at the GitHub repo (draft releases).
- **CI release** — `.github/workflows/release.yml`: tag `v*` (or manual) → macOS runner → `electron-builder --mac --publish always` → **draft** GitHub Release with the DMG. Not Apple-notarised (ad-hoc); first launch needs right-click → Open.
- **Landing page** — `docs/index.html` (Cloudflare Pages, the Highlight Scout pattern) recoloured to SlideWell's palette; `docs/DEPLOY.md` covers the `talkweaver.app/slidewell` sub-path options. Hero hides itself until a real screenshot is added.
- **LICENSE** (MIT) + refreshed **README**; repo going public.

**Not done (Phase 2, gates announcing the download):** bundle `vision_ocr` + static `ffmpeg` + the Python import engine so the app runs self-contained without the local `ppt-archive` Core A toolchain. Until then the DMG only fully works on a machine that already has the engine.

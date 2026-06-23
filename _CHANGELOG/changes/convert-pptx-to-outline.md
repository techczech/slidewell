---
title: "Convert: throwaway PPTX → Outline (sideband, never catalogued)"
id: convert-pptx-to-outline
date: 2026-06-23
type: change
status: shipped
tags: [convert, outline, talkweaver, ingest, sideband, ocr, external, adr-0026]
---

# Convert: throwaway PPTX → Outline (sideband, never catalogued)

SlideWell gains a second, distinct verb alongside **Import**: **Convert** turns *someone else's* `.pptx` into a mechanical TalkWeaver Outline folder saved wherever the user picks — and it never touches the archive registry or the vault. For collaborators' decks you want to read/edit/share without them becoming "yours". Design: `docs/superpowers/specs/2026-06-22-throwaway-pptx-conversion-design.md`, plan: `docs/superpowers/plans/2026-06-23-throwaway-pptx-conversion.md`.

- **`src/main/outline.ts`** — pure `presentation.json` (Core A schema v2.1) → Outline markdown. Mechanical skeleton: one `###` per slide; bullets (level + children), runs (`**bold**`/`_italic_`/links), pipe tables, `:::notes`, images (`![](assets/…)`), smart_art (flattened), video, links, shapes. Handles the two schema quirks — title stored twice (uses `slide.title`, skips the echoed leading heading) and the always-present `sections[]` wrapper (suppresses `##` for a single unnamed catch-all). Stamps `origin: external`. 17 unit tests (vitest).
- **`src/main/convert.ts`** — sideband orchestrator: `unified_extractor extract --output <tmp>` (no `--screenshots`, no media-store/registry writes), optional OCR via `ocr.cli <tmp> ingest-all --no-renders` read back from the temp `media.db` by `rel_path` (== `image.src`) and inlined as `*Image text: …*`, then emits `<slug>-outline.md` + `<slug>-abstract.md` + `assets/` to the chosen folder. Temp always cleaned. OCR degrades gracefully when the Vision helper is absent.
- **IPC + Settings**: `convert:pptx-to-outline` (input + save dialogs, non-empty-folder guard, reveal-in-Finder), `settings:choose-conversions-folder` (pre-fills the save dialog via a new `conversionsRoot`), `settings:set-convert-ocr` (a `convertOcrByDefault` setting). `window.sw.convert` + extended `getPaths`.
- **UI**: a `⇄ Convert` titlebar button opens a ConvertPanel (OCR toggle, streamed log, result path); SettingsPanel gains the conversions-folder chooser and the OCR-default toggle. `sw-mock.ts` resynced to the full `SwApi`.

**Verified**: 17/17 vitest unit tests pass; `npm run build` (electron-vite) green; a real end-to-end run converted a third-party `govie-project-progress-report.pptx` → a faithful Outline (frontmatter `origin: external`, `## Default` section, `### Slide 2`, bold runs, three pipe tables, copied image asset) + abstract stub stamped `imported_by: slidewell-convert`, with extraction confined to a temp dir and cleaned afterwards. `tsc -p tsconfig.node.json` shows no new errors beyond the pre-existing `well.ts:108` baseline; the renderer mock fix removed a pre-existing web type error.

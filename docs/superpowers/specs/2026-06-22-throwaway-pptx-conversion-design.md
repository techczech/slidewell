# Throwaway PPTX → Outline conversion (Scenario B)

**Status:** design approved 2026-06-22 — pending spec review, then implementation plan.
**Repo:** slidewell (execution layer). Direction layer: presentation-system (CONTEXT.md, ADR-0001, ADR-0026).
**Scope:** one self-contained feature. Sibling Scenario A ("borrowed media library") is a separate spec, not covered here.

## Problem

Dominik regularly receives other people's PowerPoints — usually from training collaborators. He wants to convert one into TalkWeaver's editable Outline format so he can read, share, hand-edit, or feed it to an agent, **without** the result ever entering his vault (his canonical, git-tracked Talk collection) or his archive catalogue. The deck is not his; the conversion is disposable by default.

Today SlideWell can only *import* a PPTX, which means cataloguing its extraction into the archive registry. There is no way to produce an Outline, and no way to run extraction without writing to a managed store. This feature adds a second, clearly-distinct verb — **convert** — that is sideband to every managed store.

## Decisions locked in the 2026-06-22 brainstorm

- **Fidelity: mechanical skeleton.** One `###` per slide; bullets, text, notes, images, tables verbatim. No layout/Trigger authoring, no AI, no agent. A valid-but-plain Outline you can view, build, or hand-edit.
- **Output: fire-and-forget to a folder you pick.** A folder dialog chooses the destination; SlideWell writes the Talk folder there and reveals it in Finder. "Not in the vault" is guaranteed by construction — you pick a non-vault location. The dialog is **pre-filled with a default destination you set once in Settings** (`conversionsRoot`); any single conversion can still redirect elsewhere.
- **OCR is an option (default off).** A per-conversion toggle. When on, embedded images are OCR'd in the sideband run and the recognised text is inlined into the Outline, so a throwaway deck is still searchable / agent-feedable. Off keeps the fast path.
- **Sideband pipeline.** Extraction (and the optional OCR pass) runs into a temp dir, never the archive store or registry. No media-store migration, no archive-registry writes, no vault writes. A conversion run mutates no managed store; the only related persistent state is the Settings defaults (`conversionsRoot`, `convertOcrByDefault`).
- **In-app TS transform.** The `presentation.json → outline.md` step is a pure TypeScript function in the main process, not a shell-out to `ppt2outline-skill` (which is agent-oriented and has no deterministic emitter to reuse).
- **"Convert" is a distinct verb from "Import."** Separate, clearly-labelled UI action, so a conversion can never be mistaken for cataloguing the deck as the user's own.

## Non-goals

- Not AI-authored layout (no Triggers like `{cards}`/`{timeline}`). Mechanical only.
- Not opening the result in TalkWeaver (TalkWeaver scans one vault root; arbitrary-folder open is out of scope).
- Not full-slide renders (those need LibreOffice; a mechanical Outline uses embedded media). OCR, when on, covers embedded images only.
- Not a managed "Conversions shelf" inside SlideWell — only a default destination path. (The shelf was the rejected option B; fire-and-forget instead.)
- Not lineage/drift tracking (ADR-0026). A converted deck is not the user's content and gets no lineage edges.
- No change to any locked direction-layer decision. The vault stays canonical (ADR-0001); the well/archive model is untouched.

## Architecture

A new IPC namespace `convert`, sibling to the existing `ingest`, exposed through the typed `window.sw` bridge in `src/preload/index.ts`:

```ts
convert: {
  // pick .pptx → pick output folder (pre-filled with conversionsRoot) → sideband
  // pipeline (opts.ocr toggles the OCR pass) → reveal in Finder.
  // returns { ok, cancelled?, outDir? }
  pptxToOutline: (opts: { ocr: boolean }): Promise<{ ok: boolean; cancelled?: boolean; outDir?: string }>
  // streamed progress lines, same pattern as ingest.onLine
  onLine: (cb: (line: string) => void): (() => void)
}
```

Main-process implementation in a new `src/main/convert.ts`, wired from `src/main/index.ts` (handler registration alongside the `ingest:*` handlers).

### Flow

1. **Pick input** — open dialog filtered to `.pptx`.
2. **Pick output** — folder dialog, **pre-filled with `conversionsRoot`** when set (else OS default) → a destination folder the user names. Slug = slugified basename of that folder.
3. **Extract to temp** — invoke Core A's `unified_extractor extract <pptx> --output <scratch-tmp>` only. No `--screenshots` (slide renders need LibreOffice; a mechanical Outline needs embedded *media*, not renders). No media-store migrate. The temp dir lives under the OS temp / scratch area, never the archive root.
4. **OCR (optional)** — when the toggle is on, OCR the embedded images in the same temp dir (Core A `tools.ocr.cli`, sideband; results read back at emit, never written to the archive registry). Skipped entirely when off.
5. **Emit** — pure TS: read `<tmp>/presentation.json` (plus the sideband OCR results when present), build the outline string (mapping rules below), copy referenced media into `<out>/assets/`, write the abstract stub.
6. **Reveal** the output folder in Finder (reuse the existing `shell:reveal`/open-path path).
7. **Clean up** — delete the temp dir (always, including on failure).

### Output layout

```
<chosen-folder>/
├── <slug>-outline.md      # the mechanical Outline
├── <slug>-abstract.md     # origin: external stub (the not-mine safeguard)
└── assets/                # only the media actually referenced by the outline
```

### Settings & config

New persistent state in `userData/config.json` (no electron-store, per the repo constraint):

- `conversionsRoot?: string` — default destination folder; pre-fills the output dialog. Unset → OS default. Never points inside the vault.
- `convertOcrByDefault?: boolean` — initial state of the per-conversion OCR toggle (default `false`).

Surfaced through the existing settings IPC, mirroring the screenshot-folder pattern:

- `settings.getPaths()` gains `conversionsRoot: string | null`.
- new `settings.chooseConversionsFolder(): Promise<string | null>`.
- the OCR default is read with `getPaths` (or a small dedicated getter) and toggled from the Settings panel.

### The "not-mine" safeguard

Even fire-and-forget output self-documents that it came from someone else, via the abstract stub — directly addressing the "don't want to eventually think it's mine" concern:

```yaml
---
title: "Their Deck Title"
author: ""                 # left blank — not the user
source_pptx: "their-deck.pptx"
imported: 2026-06-22
imported_by: slidewell-convert
origin: external           # explicit: converted from a third-party deck
---
(Converted mechanically from a third-party PPTX. Not authored by you.)
```

`origin: external` is the lightweight nod to the shared "external / non-authoritative" tier that Scenario A will formalise. This feature does not depend on that tier existing — it just stamps the field.

## Mapping rules: `presentation.json` (schema v2.1) → `outline.md`

Schema confirmed against `ppt2outline-skill/scripts/extract_pptx.py` and `ppt-archive` `unified_extractor` (identical output). Top level: `{ version, metadata, sections[], media_registry? }`. Slides live inside `sections[].slides[]`.

Two schema quirks the transform must handle:

- **Title is stored twice** — in `slide.title` *and* as the first `content` block (`type: "heading", level: 1`). Use `slide.title` for the `###` heading and **skip that leading level-1 heading block** so it does not print twice.
- **Slides are always wrapped in `sections[]`**, even when the source had no real sections (one catch-all). Emit `##` only for *named* sections; suppress the heading when there is a single unnamed catch-all section.

| Source | Outline output |
|---|---|
| `metadata.title` / chosen folder name | frontmatter `title:`, `# Title`, `author: ""`, `origin: external` |
| `section.title` (named) | `## Section` — suppressed for a single unnamed section |
| `slide.title` | `### Slide title` (fallback `### Slide {order}`) |
| first `heading` level-1 block | skipped (duplicate of title) |
| `list` block → `items[]`, each `text` + `level` (0-based) + optional `children[]` | `-` (bullet) / `1.` (numbered) lists, indented 2 spaces × `level`, recursing into `children` |
| `runs[]` (`bold`/`italic`/`url`) | inline `**bold**`, `_italic_`, `[text](url)` when present; otherwise plain `text` |
| `notes` (non-empty string) | `:::notes` … `:::` block |
| `image` block → `src: media/<id>/<file>`, `alt` | copy file → `assets/<file>`; emit `![alt](assets/<file>)` |
| OCR text for an image (OCR pass on) | inlined beneath the image as an italic aside, e.g. `*image text: …*` — exact format is part of the deferred decision below |
| `table` block → `rows[][]` cells (`text`, `is_header`) | markdown pipe table; header row followed by the `---` separator |
| `smart_art` block → `nodes[]` (recursive, `level` + `children`) | flattened to a nested bullet list |
| `video` block → `src` + `title` | `[▶ title](assets/<file>)`, or the URL for external/youtube |
| `link` block → `text` + `url` | `[text](url)` |
| `shape` block with `text` | plain paragraph; decorative shapes (no text) skipped |

All non-`type` fields are optional in the schema; the transform treats null/absent as "not present" everywhere.

## Edge cases & error handling

- **Extractor unavailable** (Core A Python env absent) — detect before the save dialog and stop, pointing at Settings → Requirements. Reuse the existing dependency check rather than failing mid-run.
- **OCR requested but engine unavailable** (macOS Vision is Mac-only; no Windows fallback yet) — warn in the progress stream and continue *without* OCR rather than aborting. The Outline still emits.
- **Extraction fails** — surface the extractor's stderr in the progress stream, abort, delete temp. No partial folder is left at the destination.
- **Referenced media missing on disk** — keep the `![]()` reference and log a warning line; do not abort. Mechanical = lossy-but-complete.
- **Empty / section-less deck** — still emits a valid Outline (frontmatter + whatever slides exist); never an error.
- **Chosen folder already non-empty** — guard and confirm before writing, so a convert never silently clobbers an existing folder.
- **Cancellation** — cancelling either dialog returns `{ ok: false, cancelled: true }` and writes nothing.

## Testing

- **Unit — the pure core.** `presentationJsonToOutline(json) → string` tested against fixture JSON: the schema example plus a few real archive extractions chosen to cover nested bullets, `runs` formatting, tables, SmartArt, notes, multi-section, single-unnamed-section, and empty slides. Assert exact markdown output.
- **Unit — media resolution.** Given a `presentation.json` with image/video blocks and a temp media folder, assert the referenced files (and only those) land in `assets/` and the outline references resolve.
- **Unit — OCR inlining.** Given image blocks plus a stub OCR result set, assert recognised text is inlined in the chosen format with OCR on, and that no such lines appear with OCR off.
- **Integration smoke (dependency-gated).** Convert a fixture `.pptx` end-to-end; assert the `<slug>-outline.md` + `<slug>-abstract.md` + `assets/` structure and a couple of expected headings. Gated on extractor presence, in the style of the existing `test:smoke` / the renders-auto-skip-when-LibreOffice-absent pattern.

## Implementation decisions deferred to the build

Two small policy calls with multiple valid answers, best made while coding rather than now:

- **Ambiguous blocks** — **SmartArt flattening** (how deep, how to render icon-bearing nodes) and **decorative-shape handling** (which shapes are content vs noise).
- **OCR inlining format** — when the OCR pass is on, how recognised image text is attached (italic aside under the image, an HTML comment, a caption, or a per-image `:::notes`). Affects readability vs cleanliness of the throwaway Outline.

Each is a focused 5–10 line decision.

## Relationship to the direction layer

This feature changes no locked decision. It introduces a new app verb, **convert** (sideband, throwaway), alongside **import** (catalogue into archive). That distinction, and the `origin: external` stamp, are worth a short note in presentation-system CONTEXT.md once shipped — and may seed the shared "external / non-authoritative" tier that Scenario A will define properly. No ADR is required for this feature on its own.

## Files

- **new** `src/main/convert.ts` — sideband pipeline + the pure `presentationJsonToOutline` transform (transform may be split into its own module for unit-testing).
- **edit** `src/main/index.ts` — register `convert:*` IPC handlers next to `ingest:*`; add `settings:choose-conversions-folder`; extend `settings:get-paths` with `conversionsRoot`.
- **edit** config read/write (`userData/config.json` handling in main) — add `conversionsRoot` + `convertOcrByDefault` keys.
- **edit** `src/preload/index.ts` — add the `convert` namespace (with the `{ ocr }` opt) and the `chooseConversionsFolder` / extended `getPaths` types to `window.sw` (single source of truth for IPC types).
- **edit** `src/renderer/src/App.tsx` (or the relevant toolbar/menu component) — a distinct "Convert PPTX to Outline…" action, visually separate from import, with an OCR toggle and progress + result surfacing.
- **edit** Settings panel — a "Conversions folder" chooser (mirrors the screenshot-folder chooser) and the default-OCR toggle.
- **new** test fixtures + specs under the existing test layout.

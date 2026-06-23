# Throwaway PPTX → Outline conversion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or subagent-driven-development. Steps use `- [ ]` for tracking.

**Goal:** Add a sideband "Convert" verb to SlideWell that turns someone else's `.pptx` into a mechanical TalkWeaver Outline folder saved wherever the user picks — never touching the vault or archive registry.

**Architecture:** A pure `presentation.json → outline.md` transform (`src/main/outline.ts`, unit-tested) + an impure orchestrator (`src/main/convert.ts`) that extracts to a temp dir via Core A's `unified_extractor`, optionally OCRs sideband (temp registry, read back), emits the Outline, copies assets to a user-chosen folder, and deletes the temp. New `convert` IPC namespace + a distinct renderer panel; a `conversionsRoot` default path and `convertOcrByDefault` toggle in Settings.

**Tech Stack:** Electron (main/preload/renderer), TypeScript, React, electron-vite (esbuild). vitest 3 for unit tests. Core A Python tools (`unified_extractor`, `ocr`) shelled out. System `sqlite3` for reading the temp OCR DB.

## Global Constraints

- IPC types live in `src/preload/index.ts` — single source of truth; mirror new shapes in `src/renderer/src/sw-mock.ts`.
- No Node APIs in the renderer; all main↔renderer via `window.sw`.
- Config persists only in `userData/config.json` (no electron-store).
- Conversion is SIDEBAND: extraction/OCR write to a temp dir only; nothing into the archive `extracted/`/`registry/` or the vault.
- Mechanical only: no AI, no agent, no `--screenshots` render.
- The repo's `tsc --noEmit` is a no-op (root tsconfig `files:[]`). Real verification = vitest (unit) + `npm run build` (esbuild) green + no NEW errors under `tsc -p tsconfig.node.json --noEmit` beyond the known baseline (`well.ts:108`).
- Extractor output layout: `--output <DIR>` → `<DIR>/<stem>/presentation.json` + media at `<DIR>/<stem>/media/<stem>/…`; `image.src` is `media/<stem>/<file>` relative to `<DIR>/<stem>/`.
- OCR join key: `ocr_assets.rel_path` (== `image.src`), table in `<root>/registry/media.db`, `kind='image'`, column `text`.
- OCR engine = macOS Vision via `<archiveRoot>/tools/ocr/vision_ocr(.swift)`; detect file presence, warn+skip when absent.

---

### Task 1: Pure transform module + vitest harness

**Files:**
- Create: `src/main/outline.ts`
- Create: `test/outline.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json` (devDep `vitest@^3`, `"test": "vitest run"`)

**Interfaces — Produces:**
- `slugify(s: string): string`
- `presentationJsonToOutline(doc: unknown, opts?: { title?: string; ocrBySrc?: Record<string,string> }): { markdown: string; assets: string[] }`
- `buildAbstract(a: { title: string; sourcePptx: string; date: string }): string`

- [ ] **Step 1: install vitest + script**

```bash
npm install -D vitest@^3
```
Add to package.json scripts: `"test": "vitest run"`.

- [ ] **Step 2: vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })
```

- [ ] **Step 3: write failing tests** (`test/outline.test.ts`) covering: single unnamed section (no `##`), title-not-duplicated (skip leading heading level 1), `### Slide N` fallback, nested bullets (level + children), numbered list, pipe table, image → `assets[]` + `![alt](assets/<base>)`, OCR inlining present only when `ocrBySrc` given, named multi-section `##`, `:::notes`, smart_art flatten, runs (`**bold**`/`_italic_`/link), `slugify`, `buildAbstract` contains `origin: external`.

- [ ] **Step 4: run — expect fail** (`npx vitest run` → cannot find module / assertions fail).

- [ ] **Step 5: implement `src/main/outline.ts`** — pure, zero imports. Inline `basename`. Block dispatch by `type`: heading/list/image/table/smart_art/video/link/shape. Section `##` iff `section.title.trim()` non-empty. Skip first content block when `type==='heading' && level===1`. Image: push `src` to assets, emit `![alt](assets/<basename(src)>)`, then `*Image text: …*` when `ocrBySrc[src]` non-empty (newlines→`; `). Frontmatter `title/author:""/origin: external`.

- [ ] **Step 6: run — expect pass** (`npx vitest run`).

- [ ] **Step 7: commit** `feat: pure presentation.json→outline transform + vitest`.

---

### Task 2: Sideband orchestrator `convert.ts`

**Files:**
- Create: `src/main/convert.ts`
- Modify: `src/main/ingest.ts` (export the spawn helper as `runPythonStep`)

**Interfaces:**
- Consumes: `runPythonStep(python, cwd, step:{label,args}, onLine)` from ingest.ts; `presentationJsonToOutline`, `buildAbstract`, `slugify` from outline.ts; `sqlite3Binary()` from archive.ts.
- Produces:
  - `findOcrTool(archiveRoot: string): { available: boolean; detail: string }`
  - `convertPptxToOutline(opts: { archiveRoot: string; python: string; pptxPath: string; outDir: string; ocr: boolean }, onLine: (s:string)=>void): Promise<{ ok: boolean; cancelled?: boolean; outDir?: string; error?: string }>`

- [ ] **Step 1:** export `runStep` from `ingest.ts` (rename to `runPythonStep`, keep `runIngest` using it).
- [ ] **Step 2:** implement `convert.ts`:
  - `mkdtempSync(join(tmpdir(),'sw-convert-'))` → `tmp`; `extracted = join(tmp,'extracted')`.
  - extract: `runPythonStep(python, archiveRoot, { label:'Extract', args:['-m','tools.unified_extractor.cli','extract', pptxPath,'--output', extracted] }, onLine)`; non-zero → cleanup + `{ok:false,error}`.
  - locate `<extracted>/<stem>/presentation.json` (scan children for one with presentation.json); read+parse.
  - if `ocr`: `findOcrTool`; if available → `mkdirSync(join(tmp,'registry'))`, `runPythonStep(... ['-m','tools.ocr.cli', tmp,'ingest-all','--no-renders'])`, then read `join(tmp,'registry','media.db')` via `sqlite3 -json -readonly "SELECT rel_path,text FROM ocr_assets WHERE kind='image' AND text IS NOT NULL"` → `ocrBySrc[rel_path]=text`; on any failure warn + continue. If unavailable → warn + continue.
  - `const { markdown, assets } = presentationJsonToOutline(doc, { ocrBySrc })`.
  - `slug = slugify(basename(outDir))`; `mkdirSync(outDir,{recursive:true})`, `mkdirSync(join(outDir,'assets'),{recursive:true})`.
  - write `<slug>-outline.md`, `<slug>-abstract.md`.
  - copy each asset `join(mediaBase, src)` → `join(outDir,'assets', basename(src))`; missing → warn line.
  - `finally { rmSync(tmp,{recursive:true,force:true}) }`; return `{ok:true,outDir}`.
- [ ] **Step 3:** `npm run build` green; commit `feat: sideband pptx→outline orchestrator`.

---

### Task 3: IPC + config (main + preload)

**Files:**
- Modify: `src/main/index.ts` (Config type, `conversionsRootResolved`, extend `settings:get-paths`, `settings:choose-conversions-folder`, `convert:*` handlers, allowedRoots? no)
- Modify: `src/preload/index.ts` (`convert` namespace, `settings.chooseConversionsFolder`, extend `getPaths` return type)

- [ ] **Step 1:** Config gains `conversionsRoot?: string; convertOcrByDefault?: boolean`. Add `conversionsRootResolved()`. Extend `settings:get-paths` with `conversionsRoot` + `convertOcrDefault`.
- [ ] **Step 2:** `settings:choose-conversions-folder` (openDirectory → writeConfig → path).
- [ ] **Step 3:** `convert:pptx-to-outline` handler `(_, opts:{ocr:boolean})`: guard `archiveAvailable()`; input dialog (`openFile`, pptx/ppt) → cancelled; output dialog `showSaveDialog({ defaultPath: join(conversionsRoot??homedir(), slug) })` → cancelled; non-empty-existing guard via `showMessageBox`; run `convertPptxToOutline`; on ok `shell.showItemInFolder(outlineFile)`; stream via `mainWindow.webContents.send('convert:line', s)`.
- [ ] **Step 4:** preload `convert.pptxToOutline(opts)` + `convert.onLine(cb)`; `settings.chooseConversionsFolder`; extend `getPaths` return type with `conversionsRoot: string|null; convertOcrDefault: boolean`.
- [ ] **Step 5:** `npm run build` green; commit `feat: convert IPC + conversionsRoot setting`.

---

### Task 4: Renderer — Convert panel + Settings

**Files:**
- Modify: `src/renderer/src/App.tsx` (titlebar Convert button, `showConvert` state, `ConvertPanel` component, SettingsPanel conversions row + OCR toggle + paths type)
- Modify: `src/renderer/src/sw-mock.ts` (add `convert`, `settings.chooseConversionsFolder`, extend `getPaths`)

- [ ] **Step 1:** sw-mock: add `convert: { pptxToOutline: async()=>({ok:false}), onLine: ()=>()=>{} }`, `settings.chooseConversionsFolder: async()=>null`, and extend `getPaths` mock to include `conversionsRoot:null, convertOcrDefault:false, screenshotRoot:null, screenshotAvailable:false`.
- [ ] **Step 2:** App titlebar: a `⇄ Convert` button → `setShowConvert(true)`; render `{showConvert && <ConvertPanel onClose=… />}`.
- [ ] **Step 3:** `ConvertPanel` (mirror `ImportPanel`): OCR checkbox (default from `getPaths().convertOcrDefault`), "Convert a PowerPoint…" button → `window.sw.convert.pptxToOutline({ocr})`, stream `convert.onLine`, on `{ok,outDir}` show "Saved to <outDir> — revealed in Finder". Copy explains: not added to archive/vault.
- [ ] **Step 4:** SettingsPanel: extend local `paths` type with `conversionsRoot`; add `conversions` folder row (choosable) to `folders`; extend `choose` union + switch to call `chooseConversionsFolder`; add an OCR-default checkbox (writes via a new `settings:set-convert-ocr` handler OR fold into chooser — minimal: a labelled note + the toggle persisted through a tiny handler). Keep scope tight: ship the folder chooser; OCR default toggle optional if time-boxed.
- [ ] **Step 5:** `npm run build` green; `npx vitest run` green; commit `feat: Convert panel + Settings conversions folder`.

---

### Task 5: Verify + docs

- [ ] **Step 1:** `npx vitest run` (unit green), `npm run build` (esbuild green), `tsc -p tsconfig.node.json --noEmit` shows only the known `well.ts:108` baseline error.
- [ ] **Step 2:** `npm run test:smoke` still builds/runs (search smoke unaffected).
- [ ] **Step 3:** update `_TASK-LOG/RESUME.md` + `_CHANGELOG` per repo logging; commit.
- [ ] **Step 4:** push branch.

## Self-Review

- Spec coverage: mechanical transform (T1), sideband extract+OCR (T2), conversionsRoot + OCR toggle (T3/T4), distinct Convert verb + not-mine abstract stub (T1 buildAbstract + T4 panel), fire-and-forget save dialog (T3), edge cases (T2 guards). ✓
- OCR inlining format decision: italic `*Image text: …*` (chosen). SmartArt: flatten to nested bullets (chosen). ✓
- Type consistency: `pptxToOutline`/`onLine`/`convertPptxToOutline`/`runPythonStep`/`findOcrTool` names consistent across tasks. ✓
- No placeholders except the deliberately-optional OCR-default toggle (T4 S4), which has a defined minimal fallback. ✓

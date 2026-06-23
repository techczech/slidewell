/**
 * Sideband PPTX → Outline conversion (ADR-0026 scenario B / docs/superpowers/specs/2026-06-22…).
 *
 * Throwaway by design: extract someone else's .pptx into a TEMP dir (never the archive store),
 * optionally OCR it sideband (a temp registry, read back), emit a mechanical Outline, copy the
 * referenced media into a user-chosen folder, then delete the temp. Nothing lands in the vault
 * or the archive registry — this is a distinct verb from `ingest` (which catalogues into Core A).
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { runPythonStep } from './ingest'
import { sqlite3Binary } from './archive'
import { presentationJsonToOutline, buildAbstract, slugify } from './outline'

export interface ConvertOpts {
  archiveRoot: string
  python: string
  pptxPath: string
  outDir: string
  ocr: boolean
}

export interface ConvertResult {
  ok: boolean
  cancelled?: boolean
  outDir?: string
  error?: string
}

/** macOS Vision OCR helper, shipped with ppt-archive (tools/ocr). Mirrors the Settings deps probe. */
export function findOcrTool(archiveRoot: string): { available: boolean; detail: string } {
  const bin = join(archiveRoot, 'tools', 'ocr', 'vision_ocr')
  const swift = join(archiveRoot, 'tools', 'ocr', 'vision_ocr.swift')
  if (existsSync(bin)) return { available: true, detail: bin }
  if (existsSync(swift)) return { available: true, detail: swift }
  return { available: false, detail: 'tools/ocr/vision_ocr(.swift) not found' }
}

/** Read OCR text from a sideband registry's media.db, keyed by rel_path (== image.src). */
function readOcrText(mediaDbPath: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    if (!existsSync(mediaDbPath)) {
      resolve({})
      return
    }
    execFile(
      sqlite3Binary(),
      ['-json', '-readonly', `file:${mediaDbPath}?mode=ro`, "SELECT rel_path, text FROM ocr_assets WHERE kind='image' AND text IS NOT NULL"],
      { timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({})
          return
        }
        try {
          const rows = JSON.parse((stdout || '').trim() || '[]') as Array<{ rel_path: string; text: string }>
          const map: Record<string, string> = {}
          for (const r of rows) if (r.rel_path) map[r.rel_path] = r.text || ''
          resolve(map)
        } catch {
          resolve({})
        }
      }
    )
  })
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function convertPptxToOutline(opts: ConvertOpts, onLine: (s: string) => void): Promise<ConvertResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'sw-convert-'))
  const extracted = join(tmp, 'extracted')
  try {
    // 1. Extract into the temp dir (NOT the archive store). cwd=archiveRoot so `tools.*` import.
    onLine(`Converting ${basename(opts.pptxPath)} → Outline (mechanical, throwaway)`)
    const code = await runPythonStep(
      opts.python,
      opts.archiveRoot,
      { label: 'Extract', args: ['-m', 'tools.unified_extractor.cli', 'extract', opts.pptxPath, '--output', extracted] },
      onLine
    )
    if (code !== 0) return { ok: false, error: `extraction failed (exit ${code})` }

    // 2. Locate <extracted>/<stem>/presentation.json
    let presDir: string | null = null
    try {
      for (const d of readdirSync(extracted, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(extracted, d.name, 'presentation.json'))) {
          presDir = join(extracted, d.name)
          break
        }
      }
    } catch {
      /* extracted dir missing → handled below */
    }
    if (!presDir) return { ok: false, error: 'no presentation.json produced by the extractor' }

    let doc: unknown
    try {
      doc = JSON.parse(readFileSync(join(presDir, 'presentation.json'), 'utf8'))
    } catch (e) {
      return { ok: false, error: `could not read presentation.json: ${(e as Error).message}` }
    }

    // 3. Optional sideband OCR — run the real CLI against the temp dir as a throwaway archive root,
    //    then read its media.db back. Any failure degrades to no-OCR (the Outline still emits).
    let ocrBySrc: Record<string, string> = {}
    if (opts.ocr) {
      const tool = findOcrTool(opts.archiveRoot)
      if (!tool.available) {
        onLine('⚠ OCR skipped — macOS Vision helper not found (tools/ocr). The Outline omits image text.')
      } else {
        mkdirSync(join(tmp, 'registry'), { recursive: true })
        const ocrCode = await runPythonStep(
          opts.python,
          opts.archiveRoot,
          { label: 'OCR images', args: ['-m', 'tools.ocr.cli', tmp, 'ingest-all', '--no-renders'] },
          onLine
        )
        if (ocrCode === 0) {
          ocrBySrc = await readOcrText(join(tmp, 'registry', 'media.db'))
          onLine(`OCR: text recovered for ${Object.keys(ocrBySrc).length} image(s)`)
        } else {
          onLine(`⚠ OCR step failed (exit ${ocrCode}) — continuing without image text`)
        }
      }
    }

    // 4. Emit the Outline + abstract + assets into the user-chosen folder.
    const { markdown, assets } = presentationJsonToOutline(doc, { ocrBySrc })
    const slug = slugify(basename(opts.outDir)) || 'converted'
    mkdirSync(join(opts.outDir, 'assets'), { recursive: true })
    const titleMatch = /\ntitle: "(.*)"/.exec(markdown)
    const title = titleMatch ? titleMatch[1] : slug
    writeFileSync(join(opts.outDir, `${slug}-outline.md`), markdown, 'utf8')
    writeFileSync(join(opts.outDir, `${slug}-abstract.md`), buildAbstract({ title, sourcePptx: basename(opts.pptxPath), date: today() }), 'utf8')

    let copied = 0
    for (const src of assets) {
      const from = join(presDir, src)
      const to = join(opts.outDir, 'assets', basename(src))
      try {
        if (existsSync(from)) {
          copyFileSync(from, to)
          copied++
        } else {
          onLine(`⚠ media missing, reference kept: ${src}`)
        }
      } catch (e) {
        onLine(`⚠ could not copy ${src}: ${(e as Error).message}`)
      }
    }
    onLine(`✓ done — wrote ${slug}-outline.md + ${copied} asset(s)`)
    return { ok: true, outDir: opts.outDir }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

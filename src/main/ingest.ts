/**
 * Archive ingest — orchestrates Core A's Python pipeline as streamed subprocesses.
 * SlideWell drives it; the heavy work (extract / render / OCR / dedup) stays in ppt-archive's
 * tools. Idempotent (Core A skips already-done decks), cancellable, streams stdout/stderr lines.
 *
 * Packaged-app PATH lacks Homebrew/conda, so the Python interpreter is an explicit path —
 * default /opt/anaconda3/bin/python3 (verified to have python-pptx/lxml/PIL), config-overridable.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function detectPython(override?: string | null): string {
  const candidates = [override, '/opt/anaconda3/bin/python3', '/opt/homebrew/bin/python3', '/usr/bin/python3', 'python3'].filter(
    (c): c is string => Boolean(c)
  )
  for (const c of candidates) if (c === 'python3' || existsSync(c)) return c
  return 'python3'
}

// A Finder-launched .app has a minimal PATH (no /opt/homebrew, no LibreOffice.app). The Python
// render tools call `shutil.which("soffice"|"pdftoppm")`, so we hand the subprocess an augmented
// PATH that includes the usual install locations + the LibreOffice bundle's binary dir.
const LIBREOFFICE_BIN = '/Applications/LibreOffice.app/Contents/MacOS'
function enginePath(): string {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', LIBREOFFICE_BIN]
  const existing = (process.env.PATH || '').split(':').filter(Boolean)
  return [...new Set([...dirs, ...existing])].join(':')
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p
  return null
}

/** Detect the slide-render toolchain (LibreOffice + Poppler). Renders are skipped if either is absent. */
export function findRenderTools(): { soffice: string | null; pdftoppm: string | null; available: boolean } {
  const soffice = firstExisting([join(LIBREOFFICE_BIN, 'soffice'), '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice'])
  const pdftoppm = firstExisting(['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm'])
  return { soffice, pdftoppm, available: Boolean(soffice && pdftoppm) }
}

export interface Step {
  label: string
  args: string[]
}

let current: ChildProcess | null = null
let cancelled = false

export function cancelIngest(): void {
  cancelled = true
  if (current) {
    try {
      current.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

export function runPythonStep(python: string, cwd: string, step: Step, onLine: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    onLine(`\n▶ ${step.label}`)
    // archiveRoot makes `tools.*` importable; archiveRoot/tools makes the bare `embeddings`
    // package (tools/embeddings) importable, which unified_extractor.cli needs.
    const pythonPath = `${cwd}:${join(cwd, 'tools')}`
    const child = spawn(python, step.args, { cwd, env: { ...process.env, PYTHONPATH: pythonPath, PATH: enginePath() } })
    current = child
    const handle = (buf: Buffer): void => {
      for (const l of buf.toString().split('\n')) if (l.trim()) onLine(l.replace(/\s+$/, ''))
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
    child.on('close', (code) => {
      current = null
      resolve(code ?? 0)
    })
    child.on('error', (e) => {
      onLine(`error: ${e.message}`)
      current = null
      resolve(1)
    })
  })
}

export interface IngestOpts {
  archiveRoot: string
  python: string
  mode: 'pending' | 'path'
  targetPath?: string
}

export async function runIngest(opts: IngestOpts, onLine: (s: string) => void): Promise<{ ok: boolean }> {
  cancelled = false
  const cwd = opts.archiveRoot
  const py = opts.python
  // Slide renders need LibreOffice + Poppler; if either is missing, skip rendering and still
  // import text/structure/images/OCR (graceful degrade — see REQUIREMENTS.md).
  const render = findRenderTools()
  if (!render.available) {
    onLine('⚠ Slide renders skipped — LibreOffice + Poppler not found. Import still does text, structure, images & OCR.')
    onLine('  Install for slide thumbnails: brew install --cask libreoffice && brew install poppler (see Requirements in Settings).')
  }
  let steps: Step[]
  if (opts.mode === 'path' && opts.targetPath) {
    const isDir = (() => {
      try {
        return statSync(opts.targetPath).isDirectory()
      } catch {
        return false
      }
    })()
    const ex = ['-m', 'tools.unified_extractor.cli', 'extract', opts.targetPath, '--output', './extracted']
    if (render.available) ex.push('--screenshots') // --screenshots triggers the LibreOffice render
    if (isDir) ex.push('--batch')
    steps = [
      { label: `Extract ${isDir ? 'folder' : 'file'}${render.available ? ' + render' : ' (no render)'}`, args: ex },
      { label: 'OCR', args: ['-m', 'tools.ocr.cli', '.', 'ingest-all'] },
      { label: 'Content-address media', args: ['-m', 'tools.media_store.cli', '.', 'migrate'] }
    ]
  } else {
    steps = [
      { label: 'Crawl for new PowerPoint', args: ['tools/crawler.py'] },
      {
        label: 'Extract (skip duplicates)',
        args: ['-m', 'tools.unified_extractor.cli', 'from-manifest', 'manifest/ppt-manifest.json', '--skip-duplicates', '--output', './extracted']
      },
      ...(render.available ? [{ label: 'Render slides', args: ['-m', 'tools.renders.cli', '.', 'render-all'] }] : []),
      { label: 'OCR images + renders', args: ['-m', 'tools.ocr.cli', '.', 'ingest-all'] },
      { label: 'Content-address media', args: ['-m', 'tools.media_store.cli', '.', 'migrate'] }
    ]
  }
  for (const step of steps) {
    if (cancelled) {
      onLine('✕ cancelled')
      return { ok: false }
    }
    const code = await runPythonStep(py, cwd, step, onLine)
    if (cancelled) {
      onLine('✕ cancelled')
      return { ok: false }
    }
    if (code !== 0) {
      onLine(`✕ ${step.label} failed (exit ${code})`)
      return { ok: false }
    }
  }
  onLine('✓ done — search to see the new slides')
  return { ok: true }
}

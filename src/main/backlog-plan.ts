/**
 * Pure planner for the one-off screenshot backlog import (ticket 13). NO fs/electron imports, so it
 * is unit-testable in vitest and is also what the dry run shows. Input: folder listings (names,
 * sizes, mtimes only), the watched folder's top-level names and the import ledger. Output: one plan
 * item per file, each a copy → verify → (Desktop only) move sequence.
 *
 * Rules:
 * - Desktop: top-level image/video files named like screenshots (ticket-01 name rules). Nothing else
 *   on the Desktop is ever listed.
 * - CleanShot history: `<media>/<capture folder>/<file>` image/video files. Read and copied only;
 *   nothing there is moved or changed. CleanShot project files (`.cleanshot`) and bundles are skipped.
 * - Copies land at the top of the watched folder under their own name. A name already taken there
 *   (or by an earlier item in this plan) is flagged; the executor then compares by hash and either
 *   reuses the identical file or picks a free name. Nothing is ever overwritten.
 * - Desktop originals move to `Moved by SlideWell <date>` inside the watched folder.
 * - `likelyDone` uses the ledger's source fingerprint (path + size + mtime) as a hint for the dry
 *   run; the executor decides by content hash.
 */
import { parseScreenshotName } from './screenshot-name'

export type BacklogSource = 'desktop' | 'cleanshot'

/** One file from a read-only listing. `rel` is relative to the source root, '/'-separated. `onlineOnly` = a cloud placeholder (dataless): never read. */
export type ListedFile = { rel: string; size: number; mtimeMs: number; onlineOnly?: boolean }

/** One ledger line (hash-keyed). `copied` = a verified copy exists in `watched`; `moved` = the Desktop original was moved. */
export type LedgerEntry = {
  step: 'copied' | 'moved'
  hash: string
  watched: string
  source: BacklogSource
  from: string
  size: number
  mtimeMs: number
  dest: string
  at: string
}

export type PlanItem = {
  id: string // the source path (unique within a plan)
  source: BacklogSource
  from: string
  name: string
  size: number
  mtimeMs: number
  copyTo: string
  nameTaken: boolean
  moveTo: string | null
  likelyDone: boolean
}

export type SourceSummary = { count: number; bytes: number; examples: string[] }

export type BacklogPlan =
  | {
      ok: true
      date: string
      watchedFolder: string
      movedFolder: string
      desktopDir: string
      cleanshotDir: string | null
      items: PlanItem[]
      summary: {
        desktop: SourceSummary // still to copy (excludes likelyDone)
        cleanshot: SourceSummary
        pendingMoves: number // Desktop originals already copied but still on the Desktop (an interrupted run)
        onlineOnly: number // online-only placeholders left out; downloading them first is the user's step
        likelyDone: number
        nameTaken: number
        totalBytes: number
        skipped: { cleanshotProjects: number; cleanshotOther: number; empty: number }
        leftoverPartials: number // hidden temp files from a copy cut off by a crash; never removed automatically
      }
    }
  | { ok: false; reason: 'no-watched-folder' | 'watched-folder-overlaps'; detail: string }

export type PlanInput = {
  watchedFolder: string | null
  desktopDir: string
  cleanshotDir: string | null
  desktop: ListedFile[]
  cleanshot: ListedFile[]
  watchedNames: string[]
  ledger: LedgerEntry[]
  date: string // YYYY-MM-DD, local
}

// Same media types the capture inbox scans (triage.ts).
export const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'])

export const MOVED_FOLDER_PREFIX = 'Moved by SlideWell'
/** Suffix of the executor's temp files (`.<name>.<pid>-<rand>.slidewell-partial`). */
export const PARTIAL_SUFFIX = '.slidewell-partial'
const EXAMPLES = 5

const ext = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const joinPath = (dir: string, name: string): string => `${strip(dir)}/${name}`
/** True when a and b are the same folder or one contains the other. */
export function foldersOverlap(a: string, b: string): boolean {
  const x = strip(a).toLowerCase()
  const y = strip(b).toLowerCase()
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

export function movedFolderName(date: string): string {
  return `${MOVED_FOLDER_PREFIX} ${date}`
}

/** True for the dated folders the import moves Desktop originals into; the Triage scan skips them. */
export function isMovedFolderName(name: string): boolean {
  return /^Moved by SlideWell \d{4}-\d{2}-\d{2}$/.test(name)
}

/** `name.png` → `name (2).png` (n ≥ 2). Used by the executor when a name is taken by different content. */
export function alternativeName(name: string, n: number): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? `${name.slice(0, i)} (${n})${name.slice(i)}` : `${name} (${n})`
}

export function planBacklogImport(input: PlanInput): BacklogPlan {
  const watched = input.watchedFolder ? strip(input.watchedFolder) : null
  if (!watched) return { ok: false, reason: 'no-watched-folder', detail: 'Choose the Triage source folder first; the backlog is brought in there.' }
  for (const other of [input.desktopDir, input.cleanshotDir]) {
    if (other && foldersOverlap(watched, other)) {
      return { ok: false, reason: 'watched-folder-overlaps', detail: `The watched folder and ${other} overlap; the import needs them to be separate folders.` }
    }
  }
  const movedFolder = joinPath(watched, movedFolderName(input.date))
  const done = new Set(input.ledger.filter((e) => e.watched === watched).map((e) => `${e.from}\0${e.size}\0${e.mtimeMs}`))
  const taken = new Set(input.watchedNames.filter((n) => !n.endsWith(PARTIAL_SUFFIX)).map((n) => n.toLowerCase()))
  const skipped = { cleanshotProjects: 0, cleanshotOther: 0, empty: 0 }
  let onlineOnly = 0
  const items: PlanItem[] = []

  const add = (source: BacklogSource, root: string, f: ListedFile, name: string): void => {
    if (f.size <= 0) {
      skipped.empty++
      return
    }
    if (f.onlineOnly) {
      onlineOnly++
      return
    }
    const from = joinPath(root, f.rel)
    const likelyDone = done.has(`${from}\0${f.size}\0${f.mtimeMs}`)
    const key = name.toLowerCase()
    const nameTaken = taken.has(key)
    taken.add(key)
    items.push({
      id: from,
      source,
      from,
      name,
      size: f.size,
      mtimeMs: f.mtimeMs,
      copyTo: joinPath(watched, name),
      nameTaken,
      moveTo: source === 'desktop' ? joinPath(movedFolder, name) : null,
      likelyDone
    })
  }

  const byRel = (a: ListedFile, b: ListedFile): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
  for (const f of [...input.desktop].sort(byRel)) {
    if (f.rel.includes('/') || f.rel.startsWith('.')) continue
    if (!MEDIA_EXT.has(ext(f.rel)) || !parseScreenshotName(f.rel)) continue
    add('desktop', input.desktopDir, f, f.rel)
  }
  if (input.cleanshotDir) {
    for (const f of [...input.cleanshot].sort(byRel)) {
      const parts = f.rel.split('/')
      const name = parts[parts.length - 1]
      if (name.startsWith('.')) continue
      if (parts.length !== 2) {
        skipped.cleanshotOther++
        continue
      }
      const e = ext(name)
      if (e === 'cleanshot') skipped.cleanshotProjects++
      else if (!MEDIA_EXT.has(e)) skipped.cleanshotOther++
      else add('cleanshot', input.cleanshotDir, f, name)
    }
  }

  const summarise = (source: BacklogSource): SourceSummary => {
    const todo = items.filter((i) => i.source === source && !i.likelyDone)
    return { count: todo.length, bytes: todo.reduce((s, i) => s + i.size, 0), examples: todo.slice(0, EXAMPLES).map((i) => i.name) }
  }
  const desktop = summarise('desktop')
  const cleanshot = summarise('cleanshot')
  return {
    ok: true,
    date: input.date,
    watchedFolder: watched,
    movedFolder,
    desktopDir: strip(input.desktopDir),
    cleanshotDir: input.cleanshotDir ? strip(input.cleanshotDir) : null,
    items,
    summary: {
      desktop,
      cleanshot,
      pendingMoves: items.filter((i) => i.likelyDone && i.source === 'desktop').length,
      onlineOnly,
      likelyDone: items.filter((i) => i.likelyDone).length,
      nameTaken: items.filter((i) => i.nameTaken && !i.likelyDone).length,
      totalBytes: desktop.bytes + cleanshot.bytes,
      skipped,
      leftoverPartials: input.watchedNames.filter((n) => n.startsWith('.') && n.endsWith(PARTIAL_SUFFIX)).length
    }
  }
}

/** Parse ledger JSONL; a torn last line (interrupted append) or junk line is skipped. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && (e.step === 'copied' || e.step === 'moved') && typeof e.hash === 'string' && typeof e.watched === 'string') out.push(e as LedgerEntry)
    } catch {
      /* torn line */
    }
  }
  return out
}

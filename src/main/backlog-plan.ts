/**
 * Pure planner for the one-off screenshot backlog import (ticket 13). NO fs/electron imports, so it
 * is unit-testable in vitest and is also what the dry run shows. Input: folder listings (names,
 * sizes, mtimes only), the watched folder's top-level names, the ledger and the state of each
 * recorded copy (checked by the executor). Output: one plan item per file to copy.
 *
 * The import only COPIES. Originals on the Desktop and in CleanShot's history stay where they are.
 *
 * Rules:
 * - Desktop: top-level image/video files named like screenshots (ticket-01 name rules). Nothing else
 *   on the Desktop is ever listed.
 * - CleanShot history: `<media>/<capture folder>/<file>` image/video files. Project files
 *   (`.cleanshot`) and bundles are skipped.
 * - Copies land at the top of the watched folder under their own name. A name already taken there
 *   (or by an earlier item in this plan) is flagged; the executor compares by hash and either reuses
 *   the identical file or picks a free name. Nothing is ever overwritten.
 * - An item counts as done only when the ledger has it (path + size + mtime) AND its recorded copy
 *   still exists and matches by hash. A missing or changed copy puts the item back in the plan. A
 *   recorded copy that is online-only cannot be checked without downloading it: it is counted as
 *   "unverified, online-only", neither done nor copied again.
 */
import { parseScreenshotName } from './screenshot-name'

export type BacklogSource = 'desktop' | 'cleanshot'

/** One file from a read-only listing. `rel` is relative to the source root, '/'-separated. */
export type ListedFile = { rel: string; size: number; mtimeMs: number; onlineOnly?: boolean; notRegular?: boolean }

/**
 * One ledger line (hash-keyed). `placing` = intent, fsynced before a copy is linked/copied to `dest`;
 * `copied` = a verified copy of `from` exists at `dest` in `watched`. An intent without a done record
 * counts as brought in only if `dest` holds that hash.
 */
export type LedgerEntry = {
  step: 'copied' | 'placing'
  hash: string
  watched: string
  source: BacklogSource
  from: string
  size: number
  mtimeMs: number
  dest: string
  at: string
}

/** State of a recorded copy, checked by the executor: ok = exists, regular file, same hash. */
export type CopyState = 'ok' | 'missing-or-changed' | 'online-only'

export type PlanItem = {
  id: string // the source path (unique within a plan)
  source: BacklogSource
  from: string
  name: string
  size: number
  mtimeMs: number
  copyTo: string
  nameTaken: boolean
  recopy: boolean // the ledger had it, but its recorded copy is missing or changed
}

export type SourceSummary = { count: number; bytes: number; examples: string[] }

export type BacklogPlan =
  | {
      ok: true
      date: string
      watchedFolder: string
      desktopDir: string
      cleanshotDir: string | null
      items: PlanItem[]
      summary: {
        desktop: SourceSummary // to copy
        cleanshot: SourceSummary
        recopy: number // included in the counts above
        done: number // verified copies already in the watched folder
        unverifiedOnlineOnly: number // recorded copy is online-only: not checked, not copied again
        onlineOnly: number // online-only sources left out; downloading them first is the user's step
        nameTaken: number
        totalBytes: number
        skipped: { cleanshotProjects: number; cleanshotOther: number; empty: number; notRegular: number }
        leftoverStaged: number // staged files from a run cut off by a crash; never removed automatically
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
  stagingNames?: string[]
  ledger: LedgerEntry[]
  copyStates?: Record<string, CopyState> // keyed by copyStateKey(dest, hash); absent = missing-or-changed
  date: string // YYYY-MM-DD, local
}

// Same media types the capture inbox scans (triage.ts).
export const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'])

/** Private staging folder inside the watched folder (dot-named: Triage and the watcher skip it). */
export const STAGING_DIR = '.slidewell-staging'
const EXAMPLES = 5

const ext = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const joinPath = (dir: string, name: string): string => `${strip(dir)}/${name}`
/** Cache key for a recorded copy's state: the same path can be expected to hold different content. */
export function copyStateKey(dest: string, hash: string): string {
  return `${dest}\0${hash}`
}

/** True when a and b are the same folder or one contains the other. */
export function foldersOverlap(a: string, b: string): boolean {
  const x = strip(a).toLowerCase()
  const y = strip(b).toLowerCase()
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/**
 * True for `Moved by SlideWell <date>` folders. An earlier build of the import moved Desktop
 * originals into such folders; the Triage scan still skips them so they are never indexed twice.
 */
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
  if (!watched) return { ok: false, reason: 'no-watched-folder', detail: 'Choose the Triage source folder first; the backlog is copied there.' }
  for (const other of [input.desktopDir, input.cleanshotDir]) {
    if (other && foldersOverlap(watched, other)) {
      return { ok: false, reason: 'watched-folder-overlaps', detail: `The watched folder and ${other} overlap; the import needs them to be separate folders.` }
    }
  }
  // ledger entries for this watched folder, by source fingerprint
  const byFrom = new Map<string, LedgerEntry[]>()
  for (const e of input.ledger) {
    if (e.watched !== watched) continue
    const k = `${e.from}\0${e.size}\0${e.mtimeMs}`
    byFrom.set(k, [...(byFrom.get(k) ?? []), e])
  }
  const stateOf = (e: LedgerEntry): CopyState => input.copyStates?.[copyStateKey(e.dest, e.hash)] ?? 'missing-or-changed'
  const taken = new Set(input.watchedNames.map((n) => n.toLowerCase()))
  const skipped = { cleanshotProjects: 0, cleanshotOther: 0, empty: 0, notRegular: 0 }
  let onlineOnly = 0
  let done = 0
  let unverifiedOnlineOnly = 0
  const items: PlanItem[] = []

  const add = (source: BacklogSource, root: string, f: ListedFile, name: string): void => {
    if (f.notRegular) {
      skipped.notRegular++
      return
    }
    if (f.size <= 0) {
      skipped.empty++
      return
    }
    if (f.onlineOnly) {
      onlineOnly++
      return
    }
    const from = joinPath(root, f.rel)
    const prior = byFrom.get(`${from}\0${f.size}\0${f.mtimeMs}`) ?? []
    if (prior.some((e) => stateOf(e) === 'ok')) {
      done++
      return
    }
    // the unverified policy is for real earlier copies only; an intent-only online-only path is unresolved work
    if (prior.some((e) => e.step === 'copied' && stateOf(e) === 'online-only')) {
      unverifiedOnlineOnly++
      return
    }
    const key = name.toLowerCase()
    const nameTaken = taken.has(key)
    taken.add(key)
    items.push({ id: from, source, from, name, size: f.size, mtimeMs: f.mtimeMs, copyTo: joinPath(watched, name), nameTaken, recopy: prior.some((e) => e.step === 'copied') })
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
    const todo = items.filter((i) => i.source === source)
    return { count: todo.length, bytes: todo.reduce((s, i) => s + i.size, 0), examples: todo.slice(0, EXAMPLES).map((i) => i.name) }
  }
  const desktop = summarise('desktop')
  const cleanshot = summarise('cleanshot')
  return {
    ok: true,
    date: input.date,
    watchedFolder: watched,
    desktopDir: strip(input.desktopDir),
    cleanshotDir: input.cleanshotDir ? strip(input.cleanshotDir) : null,
    items,
    summary: {
      desktop,
      cleanshot,
      recopy: items.filter((i) => i.recopy).length,
      done,
      unverifiedOnlineOnly,
      onlineOnly,
      nameTaken: items.filter((i) => i.nameTaken).length,
      totalBytes: desktop.bytes + cleanshot.bytes,
      skipped,
      leftoverStaged: (input.stagingNames ?? []).filter((n) => !n.startsWith('.')).length
    }
  }
}

/** Parse ledger JSONL; a torn line (interrupted append) or junk line is skipped. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && (e.step === 'copied' || e.step === 'placing') && typeof e.hash === 'string' && typeof e.watched === 'string' && typeof e.dest === 'string') out.push(e as LedgerEntry)
    } catch {
      /* torn line */
    }
  }
  return out
}

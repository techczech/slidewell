/**
 * Per-deck metadata (date / title / filename / ownership / category), read from
 * extracted/<id>/presentation.json. Ported from raycast-slide-search
 * (datemeta.ts + ownership.ts + category.ts), READ-ONLY.
 *
 * Scanning ~600 presentation.json files per keystroke is too slow, so the index
 * is built once and cached as JSON in the app's userData dir; we re-scan only
 * when a newer presentation.json appears (mtime check) — so the parallel
 * extraction pipeline writing new decks invalidates the cache automatically.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type Ownership = 'mine' | 'others' | 'unknown'

export interface DeckMeta {
  title: string
  date: string | null
  dateSource: 'created' | 'modified' | 'none'
  created: string | null
  modified: string | null
  filename: string
  sourcePath: string
  ownership: Ownership
  author: string // raw PPTX author (or last_modified_by fallback); '' when none — for display
  category: string
}
export type DeckMetaIndex = Record<string, DeckMeta>

// --- ownership (mirrors tools/ownership.py) ---
function isMine(value: string | null | undefined): boolean {
  if (!value) return false
  const s = String(value).trim().toLowerCase()
  if (!s) return false
  if (s === 'dl') return true
  return s.includes('dominik') || s.includes('lukes')
}
function resolveOwnership(meta: { ownership?: string; author?: string | null; last_modified_by?: string | null }): Ownership {
  const stamped = meta.ownership
  if (stamped === 'mine' || stamped === 'others' || stamped === 'unknown') return stamped
  if (isMine(meta.author) || isMine(meta.last_modified_by)) return 'mine'
  const a = String(meta.author ?? '').trim()
  const l = String(meta.last_modified_by ?? '').trim()
  if (!a && !l) return 'unknown'
  return 'others'
}

// --- category (mirrors tools/category.py) ---
const ANCHORS: readonly string[] = [
  '2 Training & Presentations',
  'AICC Files',
  'Academic Productivity',
  '3 Teaching and Learning',
  'Czech Language Project',
  '0 Documents'
]
const MAX_CATEGORY_DEPTH = 2
const PREFIX_RE = /^(?:\d+[a-z]?[.)]?|[A-Za-z])\s*[-.]?\s+/
function splitPath(p: string): string[] {
  return p.trim().replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')
}
function stripPrefix(seg: string): string {
  const cleaned = seg.replace(PREFIX_RE, '').trim()
  return cleaned || seg.trim()
}
function deriveCategory(sourcePath: string | null | undefined): string {
  if (!sourcePath) return ''
  const segments = splitPath(sourcePath)
  if (segments.length < 2) return ''
  const folders = segments.slice(0, -1)
  let anchorIdx = -1
  let matched: string | null = null
  for (const anchor of ANCHORS) {
    const idx = folders.indexOf(anchor)
    if (idx !== -1) {
      anchorIdx = idx
      matched = anchor
      break
    }
  }
  if (matched !== null) {
    const after = folders.slice(anchorIdx + 1, anchorIdx + 1 + MAX_CATEGORY_DEPTH)
    const raw = after.length > 0 ? after : [matched]
    return raw.map(stripPrefix).join(' / ')
  }
  return stripPrefix(folders[folders.length - 1])
}
function resolveCategory(meta: { category?: string | null; source_path?: string | null }): string {
  const stamped = (meta.category ?? '').trim()
  if (stamped) return stamped
  return deriveCategory(meta.source_path)
}

export function categoryMatches(category: string | null | undefined, sub: string): boolean {
  const needle = sub.trim().toLowerCase()
  if (!needle) return true
  if (!category) return false
  return category.toLowerCase().includes(needle)
}
export function deckMatchesSubstring(meta: DeckMeta | undefined, presentationId: string, sub: string): boolean {
  const needle = sub.toLowerCase()
  if (presentationId.toLowerCase().includes(needle)) return true
  if (!meta) return false
  return meta.filename.toLowerCase().includes(needle) || meta.title.toLowerCase().includes(needle)
}

// --- scan + cache ---
interface PMeta {
  title?: string
  source_file?: string
  source_path?: string
  created_date?: string
  modified_date?: string
  ownership?: string
  author?: string
  last_modified_by?: string
  category?: string
}
const CACHE_VERSION = 3 // bumped: added author (carried through for display)
const CACHE_FILENAME = 'deck-meta-cache.json'

function extractedRoot(archiveRoot: string): string {
  return join(archiveRoot, 'extracted')
}

function scanDeckMeta(archiveRoot: string): { index: DeckMetaIndex; newestMtimeMs: number } {
  const root = extractedRoot(archiveRoot)
  const index: DeckMetaIndex = {}
  let newestMtimeMs = 0
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return { index, newestMtimeMs }
  }
  for (const id of entries) {
    const pj = join(root, id, 'presentation.json')
    let st
    try {
      st = statSync(pj)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs
    let meta: PMeta | undefined
    try {
      meta = (JSON.parse(readFileSync(pj, 'utf8')) as { metadata?: PMeta }).metadata
    } catch {
      meta = undefined
    }
    const created = meta?.created_date?.trim() || ''
    const modified = meta?.modified_date?.trim() || ''
    let date: string | null = null
    let dateSource: DeckMeta['dateSource'] = 'none'
    if (created) {
      date = created
      dateSource = 'created'
    } else if (modified) {
      date = modified
      dateSource = 'modified'
    }
    index[id] = {
      title: meta?.title?.trim() || id,
      date,
      dateSource,
      created: created || null,
      modified: modified || null,
      filename: meta?.source_file?.trim() || `${id}.pptx`,
      sourcePath: meta?.source_path?.trim() || '',
      ownership: resolveOwnership(meta ?? {}),
      author: String(meta?.author ?? meta?.last_modified_by ?? '').trim(),
      category: resolveCategory(meta ?? {})
    }
  }
  return { index, newestMtimeMs }
}

function currentNewestMtime(archiveRoot: string): number {
  const root = extractedRoot(archiveRoot)
  let newest = 0
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return 0
  }
  for (const id of entries) {
    try {
      const st = statSync(join(root, id, 'presentation.json'))
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs
    } catch {
      /* skip */
    }
  }
  return newest
}

let memo: { archiveRoot: string; index: DeckMetaIndex } | null = null

/**
 * Drop the cached deck index (in-memory memo + on-disk cache) so the next load rescans.
 * Call after any store mutation that mtime-invalidation can't see — chiefly DELETES (removing a
 * deck doesn't bump any mtime), but also imports, so new/removed decks show without an app restart.
 */
export function invalidateDeckMeta(cacheDir: string): void {
  memo = null
  try {
    rmSync(join(cacheDir, CACHE_FILENAME), { force: true })
  } catch {
    /* best-effort */
  }
}

/** Load the deck-meta index, cached on disk (mtime-invalidated) + in memory. */
export function loadDeckMeta(archiveRoot: string, cacheDir: string): DeckMetaIndex {
  if (memo && memo.archiveRoot === archiveRoot) return memo.index
  const cachePath = join(cacheDir, CACHE_FILENAME)
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      version: number
      newestMtimeMs: number
      archiveRoot: string
      index: DeckMetaIndex
    }
    if (cached.version === CACHE_VERSION && cached.archiveRoot === archiveRoot) {
      if (currentNewestMtime(archiveRoot) <= cached.newestMtimeMs) {
        memo = { archiveRoot, index: cached.index }
        return cached.index
      }
    }
  } catch {
    /* no/stale cache → rescan */
  }
  const scanned = scanDeckMeta(archiveRoot)
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(
      cachePath,
      JSON.stringify({ version: CACHE_VERSION, newestMtimeMs: scanned.newestMtimeMs, archiveRoot, index: scanned.index }),
      'utf8'
    )
  } catch {
    /* best-effort cache */
  }
  memo = { archiveRoot, index: scanned.index }
  return scanned.index
}

/** Distinct categories with deck counts, most common first (for the dropdown). */
export function categoryList(index: DeckMetaIndex): { category: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const id of Object.keys(index)) {
    const cat = index[id].category?.trim()
    if (!cat) continue
    counts.set(cat, (counts.get(cat) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
}

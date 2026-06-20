/**
 * Read-only search over Core A's (ppt-archive) registry, ported from the proven
 * `raycast-slide-search` query layer. We shell out to the system `sqlite3`
 * binary (no native module → no electron-rebuild), querying READ-ONLY.
 *
 * SQL params are inlined as hardened literals (numbers verified finite, strings
 * single-quote-escaped by doubling) so user input is always data, never syntax.
 * FTS MATCH strings get an extra `safeFtsQuery` pass.
 *
 * v1 simplification vs Raycast: the per-OCR-row role filter (N extra sqlite3
 * spawns) is skipped for snappiness; slide role filtering stays (in-query EXISTS).
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { loadDeckMeta, categoryMatches, deckMatchesSubstring, type DeckMetaIndex } from './deckmeta'
import {
  parseQuery,
  combinedDateFilter,
  resolveOwnershipFilter,
  applyFilters,
  clusterHits,
  dateMatches,
  type OwnershipFilter,
  type Era
} from './searchlib'

const MATCH_OPEN = '\u{E000}'
const MATCH_CLOSE = '\u{E001}'

export function sqlite3Binary(): string {
  return existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3'
}

function runSqlite3(binary: string, args: string[], script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || '').toString().trim() || err.message))
          return
        }
        resolve((stdout || '').toString())
      }
    )
    child.stdin?.end(script)
  })
}

function shellQuoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
function toParamLiteral(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite numeric param: ${value}`)
    return String(value)
  }
  return shellQuoteSqlString(value)
}

interface RunOpts {
  binary: string
  dbPath: string
  sql: string
  params?: Array<string | number | null>
  timeoutMs?: number
}

async function query<T = Record<string, string>>(opts: RunOpts): Promise<T[]> {
  const params = opts.params ?? []
  let i = 0
  const inlined = opts.sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error('More ? placeholders than params')
    return toParamLiteral(params[i++])
  })
  if (i !== params.length) throw new Error(`Placeholder count (${i}) != params length (${params.length})`)
  const script = inlined.trim().endsWith(';') ? inlined : `${inlined};`
  const dbUri = `file:${opts.dbPath}?mode=ro`
  const stdout = await runSqlite3(opts.binary, ['-json', '-readonly', dbUri], script, opts.timeoutMs ?? 8000)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    return JSON.parse(trimmed) as T[]
  } catch {
    throw new Error(`sqlite3 returned non-JSON output: ${trimmed.slice(0, 200)}`)
  }
}

/** FTS5 MATCH sanitiser — mirrors the registry's _safe_fts_query. */
export function safeFtsQuery(rawQuery: string): string {
  const q = rawQuery.trim()
  if (!q) return q
  const lowered = ` ${q.toLowerCase()} `
  const hasSyntax =
    q.includes('"') ||
    q.includes('*') ||
    ['and', 'or', 'not'].some((op) => lowered.includes(` ${op} `)) ||
    /^near\(/i.test(q)
  if (hasSyntax) return q
  return q
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' ')
}

function plainSnippet(raw: string, maxLen = 160): string {
  const s = (raw ?? '').split(MATCH_OPEN).join('').split(MATCH_CLOSE).join('').replace(/\s+/g, ' ').trim()
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1).trimEnd() + '…'
}

// --- paths ---
function slidesDb(root: string): string {
  return join(root, 'registry', 'slides.db')
}
function mediaDb(root: string): string {
  return join(root, 'registry', 'media.db')
}
function imagesDb(root: string): string {
  return join(root, 'registry', 'images.db')
}

/** Absolute path to a slide's render WebP (renders/slide_NNNN.webp, NNNN = order+1). */
export function renderPath(root: string, presentationId: string, slideOrder: number | null): string | null {
  if (slideOrder === null || slideOrder === undefined || !presentationId) return null
  const nnnn = String(slideOrder + 1).padStart(4, '0')
  const p = join(root, 'extracted', presentationId, 'renders', `slide_${nnnn}.webp`)
  return existsSync(p) ? p : null
}

/** Absolute path to an extracted image: media-store/<sha>.<ext> first, then per-deck rel_path. */
export function imagePath(root: string, sha256: string, format: string, presentationId: string, relPath: string): string | null {
  const store = join(root, 'media-store', `${sha256}.${format}`)
  if (existsSync(store)) return store
  if (presentationId && relPath) {
    const p = join(root, 'extracted', presentationId, relPath)
    if (existsSync(p)) return p
  }
  return null
}

export type SlideHit = {
  kind: 'slide' | 'ocr-render' | 'ocr-image'
  title: string
  snippet: string
  text: string
  rank: number
  deck: string
  slideOrder: number | null
  usedInDecks: number
  reference: string
  renderAbsPath: string | null
}

export type ImageHit = {
  sha256: string
  deck: string
  format: string
  snippet: string
  usedInDecks: number
  reference: string
  fileAbsPath: string | null
}

interface SlideRow {
  content_hash: string
  title: string | null
  text_content: string | null
  rank: number
  used_in_decks: number
  best_pid: string | null
  best_order: number | null
  snippet: string | null
}
interface OcrRow {
  asset_key: string
  presentation_id: string | null
  slide_order: number | null
  kind: string
  text_content: string | null
  rank: number
  snippet: string | null
}

/** Search slides (slide FTS + OCR FTS merged). contentOnly hides purely-structural slides. */
export async function searchSlides(root: string, rawQuery: string, limit = 60, contentOnly = true): Promise<SlideHit[]> {
  const q = safeFtsQuery(rawQuery)
  if (!q) return []
  const binary = sqlite3Binary()
  const db = slidesDb(root)

  const roleClause = contentOnly
    ? `AND EXISTS (SELECT 1 FROM slide_locations l2
                  WHERE l2.content_hash = s.content_hash
                    AND (l2.role = 'content' OR l2.role IS NULL))`
    : ''
  const slideSql = `
    SELECT s.content_hash, s.title, s.text_content, fts.rank AS rank,
           snippet(slides_fts, -1, ?, ?, ?, 12) AS snippet,
           (SELECT COUNT(DISTINCT presentation_id) FROM slide_locations l
              WHERE l.content_hash = s.content_hash) AS used_in_decks,
           (SELECT presentation_id FROM slide_locations l3
              WHERE l3.content_hash = s.content_hash ORDER BY l3.slide_order LIMIT 1) AS best_pid,
           (SELECT slide_order FROM slide_locations l4
              WHERE l4.content_hash = s.content_hash ORDER BY l4.slide_order LIMIT 1) AS best_order
    FROM slides s
    JOIN slides_fts fts ON s.rowid = fts.rowid
    WHERE slides_fts MATCH ?
      ${roleClause}
    ORDER BY fts.rank LIMIT ?`
  const slideRows = await query<SlideRow>({
    binary,
    dbPath: db,
    sql: slideSql,
    params: [MATCH_OPEN, MATCH_CLOSE, '…', q, limit]
  })

  const hits: SlideHit[] = slideRows.map((r) => ({
    kind: 'slide',
    title: r.title || '(untitled slide)',
    snippet: plainSnippet(r.snippet || r.text_content || ''),
    text: r.text_content || '',
    deck: r.best_pid || '',
    slideOrder: r.best_order,
    usedInDecks: Number(r.used_in_decks) || 1,
    reference: r.best_order === null ? `[use: ppt:${r.best_pid}]` : `[use: ppt:${r.best_pid}#${r.best_order}]`,
    renderAbsPath: renderPath(root, r.best_pid || '', r.best_order),
    rank: r.rank
  }))

  const ocrRows = await query<OcrRow>({
    binary,
    dbPath: db,
    sql: `SELECT o.asset_key, o.presentation_id, o.slide_order, o.kind, o.text_content,
                 fts.rank AS rank, snippet(ocr_fts, -1, ?, ?, ?, 12) AS snippet
          FROM ocr_text o JOIN ocr_fts fts ON o.rowid = fts.rowid
          WHERE ocr_fts MATCH ? ORDER BY fts.rank LIMIT ?`,
    params: [MATCH_OPEN, MATCH_CLOSE, '…', q, limit]
  })
  for (const r of ocrRows) {
    const isRender = r.kind === 'render'
    hits.push({
      kind: isRender ? 'ocr-render' : 'ocr-image',
      title:
        `[OCR ${r.kind}] ${r.presentation_id ?? ''}` +
        (r.slide_order !== null && r.slide_order !== undefined ? ` slide ${r.slide_order + 1}` : ''),
      snippet: plainSnippet(r.snippet || r.text_content || ''),
      text: r.text_content || '',
      deck: r.presentation_id || '',
      slideOrder: r.slide_order ?? null,
      usedInDecks: 1,
      reference: r.slide_order === null ? `[use: ppt:${r.presentation_id}]` : `[use: ppt:${r.presentation_id}#${r.slide_order}]`,
      renderAbsPath: renderPath(root, r.presentation_id || '', r.slide_order ?? null),
      rank: r.rank
    })
  }

  hits.sort((a, b) => a.rank - b.rank)
  return hits.slice(0, limit)
}

interface ImageRow {
  asset_key: string
  presentation_id: string | null
  rel_path: string | null
  text: string | null
  rank: number
}

/** Search extracted images by OCR text (media.db ocr_assets, kind='image'). */
export async function searchImages(root: string, rawQuery: string, limit = 60): Promise<ImageHit[]> {
  const binary = sqlite3Binary()
  const q = rawQuery.trim()
  let rows: ImageRow[]
  if (q.length >= 2) {
    const tokens = q
      .split(/\s+/)
      .map((t) => t.replace(/[%_]/g, (m) => `\\${m}`))
      .filter(Boolean)
    const whereLikes = tokens.map(() => `o.text LIKE ? ESCAPE '\\'`).join(' AND ')
    const params: Array<string | number> = tokens.map((t) => `%${t}%`)
    params.push(limit)
    rows = await query<ImageRow>({
      binary,
      dbPath: mediaDb(root),
      sql: `SELECT o.asset_key, o.presentation_id, o.rel_path, o.text, o.line_count AS rank
            FROM ocr_assets o
            WHERE o.kind = 'image' AND o.text IS NOT NULL AND ${whereLikes}
            ORDER BY length(o.text) DESC LIMIT ?`,
      params
    })
  } else {
    // browse: most text-rich images first (a stand-in for relevance until embeddings land)
    rows = await query<ImageRow>({
      binary,
      dbPath: mediaDb(root),
      sql: `SELECT o.asset_key, o.presentation_id, o.rel_path, o.text, o.line_count AS rank
            FROM ocr_assets o
            WHERE o.kind = 'image' AND o.text IS NOT NULL
            ORDER BY length(o.text) DESC LIMIT ?`,
      params: [limit]
    })
  }

  const hits: ImageHit[] = []
  for (const r of rows) {
    const sha = r.asset_key
    const relPath = r.rel_path || ''
    const format = (relPath.split('.').pop() || '').toLowerCase() || 'bin'
    let usedIn = 1
    try {
      const cnt = await query<{ n: number }>({
        binary,
        dbPath: imagesDb(root),
        sql: `SELECT COUNT(DISTINCT presentation_id) AS n FROM image_locations WHERE sha256 = ?`,
        params: [sha]
      })
      if (cnt[0]?.n) usedIn = Number(cnt[0].n)
    } catch {
      /* images.db absent → default 1 */
    }
    hits.push({
      sha256: sha,
      deck: r.presentation_id || '',
      format,
      snippet: plainSnippet(r.text || ''),
      usedInDecks: usedIn,
      reference: `r2://ppt-archive-media/media/${sha}.${format}`,
      fileAbsPath: imagePath(root, sha, format, r.presentation_id || '', relPath)
    })
  }
  return hits
}

// ---------- high-level search: parse tokens → FTS → filter by deck meta → enrich → cluster ----------
export interface EnrichedHit {
  kind: SlideHit['kind']
  title: string
  snippet: string
  text: string
  rank: number
  deck: string
  deckTitle: string
  filename: string
  category: string
  date: string | null
  slideOrder: number | null
  usedInDecks: number
  reference: string
  renderAbsPath: string | null
}
export interface EnrichedCluster {
  representative: EnrichedHit
  members: EnrichedHit[]
  size: number
  deckCount: number
}
export interface SearchFilters {
  owner: OwnershipFilter
  era: Era
  category: string
  deck: string // substring on deck filename/title ('' = any); ANDed with any deck: tokens
  role: 'content' | 'all'
  cluster: boolean
  scope: 'all' | 'archive' | 'well'
  type: 'slides' | 'images' | 'decks'
}

export async function searchArchive(
  root: string,
  cacheDir: string,
  rawQuery: string,
  filters: SearchFilters
): Promise<EnrichedCluster[]> {
  const parsed = parseQuery(rawQuery)
  const dateFilter = combinedDateFilter(parsed, filters.era)
  const ownerFilter = resolveOwnershipFilter(parsed.owner, filters.owner)
  const categorySubs = [...(filters.category ? [filters.category.toLowerCase()] : []), ...parsed.categorySubstrings]
  const deckSubs = [...parsed.deckSubstrings, ...(filters.deck ? [filters.deck.toLowerCase()] : [])]
  // owner/role narrow results but never justify a no-text broad search (don't dump the archive);
  // a date/deck/category filter does (mirrors the Raycast rule).
  const hasFilter = !!dateFilter || deckSubs.length > 0 || categorySubs.length > 0
  const ftsText = parsed.text.trim()
  // Allow a tokens/filters-only query (e.g. "deck:roundup year:2024") with no free text.
  if (ftsText.length < 2 && !hasFilter) return []

  const raw = await searchSlides(root, ftsText.length >= 2 ? ftsText : 'the', 120, filters.role === 'content')
  const index: DeckMetaIndex = loadDeckMeta(root, cacheDir)
  const filtered = applyFilters(raw, index, dateFilter, deckSubs, ownerFilter, categorySubs).slice(0, 60)

  const enriched: EnrichedHit[] = filtered.map((h) => {
    const m = index[h.deck]
    return {
      ...h,
      deckTitle: m?.title || h.deck,
      filename: m?.filename || '',
      category: m?.category || '',
      date: m?.date ?? null
    }
  })

  if (!filters.cluster) {
    return enriched.map((h) => ({ representative: h, members: [h], size: 1, deckCount: h.deck ? 1 : 0 }))
  }
  return clusterHits(enriched)
}

/** The structured content of one slide (its presentation.json node), pretty-printed — for "copy structure". */
export function slideStructure(root: string, deck: string, slideOrder: number | null): string | null {
  if (!deck) return null
  const pj = join(root, 'extracted', deck, 'presentation.json')
  let doc: { sections?: Array<{ slides?: unknown[] }> }
  try {
    doc = JSON.parse(readFileSync(pj, 'utf8'))
  } catch {
    return null
  }
  const slides: unknown[] = []
  for (const section of doc.sections ?? []) for (const sl of section.slides ?? []) slides.push(sl)
  if (slides.length === 0) return null
  const node = slides[slideOrder ?? 0] ?? slides[0]
  return JSON.stringify(node, null, 2)
}

interface BrowseRow {
  content_hash: string
  title: string | null
  text_content: string | null
  pid: string
  ord: number
}

function toEnriched(root: string, index: DeckMetaIndex, r: { content_hash?: string; title: string | null; text_content: string | null; pid: string; ord: number }): EnrichedHit {
  const m = index[r.pid]
  return {
    kind: 'slide',
    title: r.title || '(untitled slide)',
    snippet: plainSnippet(r.text_content || ''),
    text: r.text_content || '',
    rank: 0,
    deck: r.pid,
    deckTitle: m?.title || r.pid,
    filename: m?.filename || '',
    category: m?.category || '',
    date: m?.date ?? null,
    slideOrder: r.ord,
    usedInDecks: 1,
    reference: r.ord === null ? `[use: ppt:${r.pid}]` : `[use: ppt:${r.pid}#${r.ord}]`,
    renderAbsPath: renderPath(root, r.pid, r.ord)
  }
}

/** Browse (no free-text query): all slides matching the filters, NEWEST DECK FIRST. */
export async function browseArchive(root: string, cacheDir: string, rawQuery: string, filters: SearchFilters, limit = 200): Promise<EnrichedCluster[]> {
  const index = loadDeckMeta(root, cacheDir)
  const parsed = parseQuery(rawQuery)
  const dateFilter = combinedDateFilter(parsed, filters.era)
  const ownerFilter = resolveOwnershipFilter(parsed.owner, filters.owner)
  const catSubs = [...(filters.category ? [filters.category.toLowerCase()] : []), ...parsed.categorySubstrings]
  const deckSubs = [...parsed.deckSubstrings, ...(filters.deck ? [filters.deck.toLowerCase()] : [])]

  const pids = Object.keys(index)
    .filter((pid) => {
      const m = index[pid]
      if (dateFilter && !dateMatches(dateFilter, m.date ?? null)) return false
      if (ownerFilter !== 'all' && (m?.ownership ?? 'unknown') !== ownerFilter) return false
      for (const s of deckSubs) if (!deckMatchesSubstring(m, pid, s)) return false
      for (const s of catSubs) if (!categoryMatches(m?.category, s)) return false
      return true
    })
    .sort((a, b) => String(index[b].date || '').localeCompare(String(index[a].date || '')))
  if (pids.length === 0) return []

  const chosen = pids.slice(0, 120) // cap decks scanned for an unfiltered browse
  const placeholders = chosen.map(() => '?').join(',')
  const roleClause = filters.role === 'content' ? `AND (l.role = 'content' OR l.role IS NULL)` : ''
  const rows = await query<BrowseRow>({
    binary: sqlite3Binary(),
    dbPath: slidesDb(root),
    sql: `SELECT s.content_hash, s.title, s.text_content, l.presentation_id AS pid, l.slide_order AS ord
          FROM slide_locations l JOIN slides s ON s.content_hash = l.content_hash
          WHERE l.presentation_id IN (${placeholders}) ${roleClause}`,
    params: chosen
  })
  // newest deck first, then slide order; dedupe identical slides across decks (keep first = newest).
  rows.sort((a, b) => {
    const d = String(index[b.pid]?.date || '').localeCompare(String(index[a.pid]?.date || ''))
    return d !== 0 ? d : a.ord - b.ord
  })
  const seen = new Set<string>()
  const hits: EnrichedHit[] = []
  for (const r of rows) {
    if (seen.has(r.content_hash)) continue
    seen.add(r.content_hash)
    hits.push(toEnriched(root, index, r))
    if (hits.length >= limit) break
  }
  if (!filters.cluster) return hits.map((h) => ({ representative: h, members: [h], size: 1, deckCount: h.deck ? 1 : 0 }))
  return clusterHits(hits)
}

/** Entry point: FTS search when there's free text (≥2 chars), else a newest-first browse. */
export async function archiveResults(root: string, cacheDir: string, rawQuery: string, filters: SearchFilters): Promise<EnrichedCluster[]> {
  const parsed = parseQuery(rawQuery)
  if (parsed.text.trim().length >= 2) return searchArchive(root, cacheDir, rawQuery, filters)
  return browseArchive(root, cacheDir, rawQuery, filters)
}

// ---------- Deck mode: browse presentations by their title slide ----------
export interface DeckCard {
  id: string
  title: string
  date: string | null
  category: string
  filename: string
  ownership: string
  slideCount: number
  coverAbsPath: string | null // render of slide 0 (the title slide)
}

async function slideCounts(root: string, contentOnly: boolean): Promise<Record<string, number>> {
  const roleClause = contentOnly ? `WHERE role = 'content' OR role IS NULL` : ''
  const rows = await query<{ pid: string; n: number }>({
    binary: sqlite3Binary(),
    dbPath: slidesDb(root),
    sql: `SELECT presentation_id AS pid, COUNT(*) AS n FROM slide_locations ${roleClause} GROUP BY presentation_id`
  })
  const out: Record<string, number> = {}
  for (const r of rows) out[r.pid] = Number(r.n) || 0
  return out
}

/** One card per presentation (cover = title-slide render), filtered by the same Date/Owner/Category/Deck filters. */
export async function listDecks(root: string, cacheDir: string, filters: SearchFilters): Promise<DeckCard[]> {
  const index = loadDeckMeta(root, cacheDir)
  const dateFilter = combinedDateFilter(parseQuery(''), filters.era)
  const cat = (filters.category || '').toLowerCase()
  const deckNeedle = (filters.deck || '').toLowerCase()
  const counts = await slideCounts(root, filters.role === 'content')
  return Object.keys(index)
    .filter((pid) => {
      const m = index[pid]
      if (dateFilter && !dateMatches(dateFilter, m.date ?? null)) return false
      if (filters.owner !== 'all' && (m.ownership ?? 'unknown') !== filters.owner) return false
      if (cat && !categoryMatches(m.category, cat)) return false
      if (deckNeedle && !deckMatchesSubstring(m, pid, deckNeedle)) return false
      return true
    })
    .map((pid) => {
      const m = index[pid]
      return {
        id: pid,
        title: m.title || pid,
        date: m.date,
        category: m.category,
        filename: m.filename,
        ownership: m.ownership,
        slideCount: counts[pid] ?? 0,
        coverAbsPath: renderPath(root, pid, 0)
      }
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
}

export interface DeckDetail {
  id: string
  title: string
  date: string | null
  dateSource: string
  category: string
  filename: string
  ownership: string
  sourcePath: string
  sectionCount: number
  slideCount: number
}

/** Full metadata for one deck (reads its presentation.json for section/slide counts) — for the sidebar. */
export function deckDetail(root: string, cacheDir: string, pid: string): DeckDetail | null {
  if (!pid) return null
  const m = loadDeckMeta(root, cacheDir)[pid]
  let sectionCount = 0
  let slideCount = 0
  try {
    const doc = JSON.parse(readFileSync(join(root, 'extracted', pid, 'presentation.json'), 'utf8')) as {
      sections?: Array<{ slides?: unknown[] }>
    }
    sectionCount = (doc.sections ?? []).length
    for (const s of doc.sections ?? []) slideCount += (s.slides ?? []).length
  } catch {
    /* no json */
  }
  return {
    id: pid,
    title: m?.title || pid,
    date: m?.date ?? null,
    dateSource: m?.dateSource ?? 'none',
    category: m?.category || '',
    filename: m?.filename || '',
    ownership: m?.ownership || 'unknown',
    sourcePath: m?.sourcePath || '',
    sectionCount,
    slideCount
  }
}

/** All slides of one presentation, in slide order — for "see in context". */
export async function deckSlides(root: string, cacheDir: string, pid: string): Promise<EnrichedHit[]> {
  if (!pid) return []
  const index = loadDeckMeta(root, cacheDir)
  const rows = await query<{ title: string | null; text_content: string | null; ord: number }>({
    binary: sqlite3Binary(),
    dbPath: slidesDb(root),
    sql: `SELECT s.title, s.text_content, l.slide_order AS ord
          FROM slide_locations l JOIN slides s ON s.content_hash = l.content_hash
          WHERE l.presentation_id = ? ORDER BY l.slide_order`,
    params: [pid]
  })
  return rows.map((r) => toEnriched(root, index, { title: r.title, text_content: r.text_content, pid, ord: r.ord }))
}

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
import { existsSync } from 'node:fs'

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

/** Search slides (slide FTS + OCR FTS merged), content-only by default. */
export async function searchSlides(root: string, rawQuery: string, limit = 60): Promise<SlideHit[]> {
  const q = safeFtsQuery(rawQuery)
  if (!q) return []
  const binary = sqlite3Binary()
  const db = slidesDb(root)

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
      AND EXISTS (SELECT 1 FROM slide_locations l2
                  WHERE l2.content_hash = s.content_hash
                    AND (l2.role = 'content' OR l2.role IS NULL))
    ORDER BY fts.rank LIMIT ?`
  const slideRows = await query<SlideRow>({
    binary,
    dbPath: db,
    sql: slideSql,
    params: [MATCH_OPEN, MATCH_CLOSE, '…', q, limit]
  })

  const hits: Array<SlideHit & { rank: number }> = slideRows.map((r) => ({
    kind: 'slide',
    title: r.title || '(untitled slide)',
    snippet: plainSnippet(r.snippet || r.text_content || ''),
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
      deck: r.presentation_id || '',
      slideOrder: r.slide_order ?? null,
      usedInDecks: 1,
      reference: r.slide_order === null ? `[use: ppt:${r.presentation_id}]` : `[use: ppt:${r.presentation_id}#${r.slide_order}]`,
      renderAbsPath: renderPath(root, r.presentation_id || '', r.slide_order ?? null),
      rank: r.rank
    })
  }

  hits.sort((a, b) => a.rank - b.rank)
  return hits.slice(0, limit).map(({ rank: _rank, ...h }) => h)
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
  const tokens = rawQuery
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[%_]/g, (m) => `\\${m}`))
    .filter(Boolean)
  if (tokens.length === 0) return []
  const whereLikes = tokens.map(() => `o.text LIKE ? ESCAPE '\\'`).join(' AND ')
  const params: Array<string | number> = tokens.map((t) => `%${t}%`)
  params.push(limit)

  const rows = await query<ImageRow>({
    binary,
    dbPath: mediaDb(root),
    sql: `SELECT o.asset_key, o.presentation_id, o.rel_path, o.text, o.line_count AS rank
          FROM ocr_assets o
          WHERE o.kind = 'image' AND o.text IS NOT NULL AND ${whereLikes}
          ORDER BY length(o.text) DESC LIMIT ?`,
    params
  })

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

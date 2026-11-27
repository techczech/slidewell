import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { renderPath } from '../archive'
import { BIN_AFTER_DAYS } from '../review/piles'
import { downloadedOnDisk } from '../review/picture'
import { inspect, signature, type Rendition, type Source } from './rendition'

const SLIDE_SELECT = `SELECT s.title, substr(s.text_content, 1, 600) AS snippet,
  s.content_hash, l.presentation_id, l.slide_order FROM slides s
  JOIN slide_locations l ON l.content_hash = s.content_hash`
const WELL_SELECT = `SELECT id, slug, substr(coalesce(nullif(ocr_text, ''), notes), 1, 600) AS snippet,
  rel_path, added_at FROM well_fts w WHERE w.root = 'well' AND w.source = 'screenshot'`
const VISIBLE = ` AND NOT EXISTS (SELECT 1 FROM well_sources src JOIN triage.triage_decisions d
  ON d.hash = src.source_hash WHERE src.well_id = w.id AND d.state IN ('excluded', 'emptied'))`

type Slide = { title: string | null; snippet: string | null; content_hash: string; presentation_id: string; slide_order: number }
type Well = { id: string; slug: string; snippet: string | null; rel_path: string; added_at: string }
export type FinderScope = {
  libraryId: string
  archiveRoot: string
  wellRoot: string
  presentations: readonly string[]
  wellImages: readonly string[]
}

export function openCatalogue(scope: FinderScope) {
  const { archiveRoot, wellRoot } = scope
  const slidesPath = join(archiveRoot, 'registry', 'slides.db')
  const wellPath = join(wellRoot, 'well.db')
  const triagePath = join(wellRoot, 'triage.db')
  const presentations = new Set(scope.presentations)
  const wellImages = new Set(scope.wellImages)
  const presentationList = JSON.stringify([...presentations])
  const wellImageList = JSON.stringify([...wellImages])

  function read<T>(path: string, action: (db: DatabaseSync) => T): T {
    if (realpathSync(path) !== path) throw new Error('Library database moved')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 500')
      return action(db)
    } finally {
      db.close()
    }
  }

  function readWell<T>(action: (db: DatabaseSync, visible: string) => T): T {
    return read(wellPath, (db) => {
      // No writer or migration here. If review is present and visibility cannot be determined,
      // fail closed instead of treating the Bin as empty.
      if (realpathSync(triagePath) !== triagePath) throw new Error('Review database moved')
      db.prepare('ATTACH ? AS triage').run(`${pathToFileURL(triagePath).href}?mode=ro`)
      const backfilled = db.prepare("SELECT 1 FROM well_meta WHERE key = 'well_sources_backfilled'").get()
      if (!backfilled) throw new Error('Well source identity not ready')
      const hasProposals = db.prepare("SELECT 1 FROM triage.sqlite_master WHERE type = 'table' AND name = 'sorter_proposals'").get()
      const hasClock = hasProposals && db.prepare('PRAGMA triage.table_info(sorter_proposals)').all().some((c) => c.name === 'throwaway_since')
      const clock = hasClock ? 'coalesce(p.throwaway_since, p.proposed_at)' : 'p.proposed_at'
      const outsideBin = hasProposals ? ` AND NOT EXISTS (
        SELECT 1 FROM well_sources src JOIN triage.sorter_proposals p ON p.hash = src.source_hash
        LEFT JOIN triage.triage_decisions d ON d.hash = src.source_hash
        WHERE src.well_id = w.id AND p.proposal = 'throwaway'
          AND coalesce(d.state, '') NOT IN ('selected', 'included')
          AND julianday(${clock}) <= julianday('now', '-${BIN_AFTER_DAYS} days'))` : ''
      return action(db, VISIBLE + outsideBin)
    })
  }

  function slide(row: Slide): Source | null {
    if (!presentations.has(row.presentation_id)) return null
    const dir = join(archiveRoot, 'extracted', row.presentation_id)
    const manifest = join(dir, 'presentation.json')
    let label = row.presentation_id
    try {
      if (realpathSync(dir) !== dir) return null
      const st = lstatSync(manifest)
      if (st.isFile() && st.size <= 4 * 1024 * 1024 && downloadedOnDisk(manifest)) {
        const metadata = (JSON.parse(readFileSync(manifest, 'utf8')) as { metadata?: { title?: unknown } }).metadata
        if (typeof metadata?.title === 'string' && metadata.title.trim()) label = metadata.title.trim().slice(0, 180)
      }
    } catch {
      // Older extractions can still resolve by their presentation ID.
    }
    const path = renderPath(archiveRoot, row.presentation_id, row.slide_order)
    if (!path) return null
    return {
      corpusId: 'slides', itemId: `slide:${row.presentation_id}#${row.slide_order}`,
      title: row.title || 'Untitled slide', snippet: row.snippet || '',
      source: `${label} · slide ${row.slide_order}`, revision: row.content_hash,
      path, root: join(dir, 'renders')
    }
  }

  function well(row: Well): Source | null {
    if (!wellImages.has(row.id)) return null
    return {
      corpusId: 'well', itemId: `well:${row.id}`, title: row.slug.replace(/-/g, ' '),
      snippet: row.snippet || '', source: ['Added image', row.added_at?.slice(0, 10)].filter(Boolean).join(' · '),
      revision: row.id, path: join(wellRoot, row.rel_path), root: join(wellRoot, 'images')
    }
  }

  function eligibleWellIds(): string[] {
    return wellImages.size ? readWell((db, visible) =>
      (db.prepare("SELECT id FROM well_fts w WHERE w.root = 'well' AND w.source = 'screenshot'" +
        visible + ' AND w.id IN (SELECT value FROM json_each(?))')
        .all(wellImageList) as Array<{ id: string }>).map(({ id }) => `well:${id}`)) : []
  }

  async function resolve(id: string): Promise<Rendition | null> {
    const match = /^slide:([\w.-]+)#(\d+)$/.exec(id)
    if (match && presentations.has(match[1])) {
      const row = read(slidesPath, (db) => db.prepare(SLIDE_SELECT + ' WHERE l.presentation_id = ? AND l.slide_order = ?')
        .get(match[1], Number(match[2]))) as Slide | undefined
      return inspect(row ? slide(row) : null)
    }
    if (id.startsWith('well:') && wellImages.has(id.slice(5))) {
      const row = readWell((db, visible) => db.prepare(WELL_SELECT + visible + ' AND w.id = ?')
        .get(id.slice(5))) as Well | undefined
      return inspect(row ? well(row) : null)
    }
    return null
  }

  async function words(text: string): Promise<Rendition[]> {
    // A quoted phrase or space-separated words, using the stores' existing FTS tokenisers.
    const terms = text.match(/"[^"]+"|[^\s"]+/g) ?? []
    if (!terms.length) return []
    const fts = terms.map((t) => `"${t.replaceAll('"', '')}"`).join(' ')
    const slides = presentations.size ? read(slidesPath, (db) =>
      db.prepare(SLIDE_SELECT + ` JOIN slides_fts ON s.rowid = slides_fts.rowid WHERE slides_fts MATCH ?
        AND l.presentation_id IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT 30`)
        .all(fts, presentationList) as unknown as Slide[]) : []
    const images = wellImages.size ? readWell((db, visible) =>
      db.prepare(WELL_SELECT + visible + ` AND w.id IN (SELECT value FROM json_each(?))
        AND well_fts MATCH ? ORDER BY rank LIMIT 20`)
        .all(wellImageList, fts) as unknown as Well[]) : []
    return (await Promise.all([...slides.map(slide), ...images.map(well)].map(inspect))).filter((item) => item !== null)
  }

  async function generation(): Promise<string> {
    const files = [...(presentations.size ? [slidesPath] : []), ...(wellImages.size ? [wellPath, triagePath] : [])]
    const values = await Promise.all(files.flatMap((path) => [path, path + '-wal']).map(async (path) => {
      try {
        const st = await lstat(path, { bigint: true })
        return signature(st)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && path.endsWith('-wal')) return ''
        throw e
      }
    }))
    return createHash('sha256').update(values.join('|')).digest('hex')
  }

  return { words, resolve, eligibleWellIds, generation }
}

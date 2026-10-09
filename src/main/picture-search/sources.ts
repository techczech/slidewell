/**
 * What the indexer embeds: every archive slide render (Core A's extracted/<id>/renders/) and every
 * image in the well (screenshots and indexed TalkWeaver vault images). Read-only; async stats so a
 * 60k-render archive does not block the main process.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from '../sqlite'
import { slideId, wellImageId, type IndexItem } from './vector-store'

const IMAGE_EXT = /\.(webp|png|jpe?g|gif|bmp|tiff?)$/i

type RenderEntry = { slide_order?: number; render?: string | null }

async function statItems<T>(rows: T[], pathOf: (r: T) => string, make: (r: T, size: number, mtimeMs: number) => IndexItem): Promise<IndexItem[]> {
  const out: IndexItem[] = []
  for (let i = 0; i < rows.length; i += 256) {
    const chunk = rows.slice(i, i + 256)
    const stats = await Promise.all(chunk.map((r) => stat(pathOf(r)).catch(() => null)))
    chunk.forEach((r, k) => {
      const s = stats[k]
      if (s && s.isFile() && s.size > 0) out.push(make(r, s.size, Math.round(s.mtimeMs)))
    })
  }
  return out
}

/** Slide renders of one archive store: the renders.json pairing when present, else slide_NNNN = order. */
/** `tag` (the canonical root) is recorded on every item, so its result is only kept under that root. */
export async function archiveRenders(archiveRoot: string, tag: string = archiveRoot): Promise<IndexItem[]> {
  const extracted = join(archiveRoot, 'extracted')
  if (!existsSync(extracted)) return []
  const rows: Array<{ pid: string; order: number; path: string }> = []
  const dirs = await readdir(extracted, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const base = join(extracted, d.name)
    let entries: RenderEntry[] | null = null
    try {
      entries = (JSON.parse(await readFile(join(base, 'renders.json'), 'utf8')) as { renders?: RenderEntry[] }).renders ?? []
    } catch {
      entries = null
    }
    if (entries) {
      for (const e of entries) {
        if (typeof e.slide_order !== 'number' || typeof e.render !== 'string' || !e.render) continue
        if (e.render.split(/[\\/]/).includes('..') || !IMAGE_EXT.test(e.render)) continue
        rows.push({ pid: d.name, order: e.slide_order, path: join(base, e.render) })
      }
      continue
    }
    const files = await readdir(join(base, 'renders')).catch(() => [] as string[])
    for (const f of files) {
      const m = f.match(/^slide_(\d+)\.webp$/)
      if (m) rows.push({ pid: d.name, order: Number(m[1]), path: join(base, 'renders', f) })
    }
  }
  return statItems(
    rows,
    (r) => r.path,
    (r, size, mtimeMs) => ({ id: slideId(r.pid, r.order), kind: 'slide', path: r.path, size, mtimeMs, presentationId: r.pid, slideOrder: r.order, root: tag })
  )
}

/** Images in the well: SlideWell-owned files under the well root, and vault images indexed in place. */
export async function wellImages(wellRoot: string, vaultRoot: string | null): Promise<IndexItem[]> {
  const db = join(wellRoot, 'well.db')
  if (!existsSync(db)) return []
  const rows = await query<{ id: string; rel_path: string; root: string }>(db, 'SELECT id, rel_path, root FROM well_fts').catch(() => [])
  const located = rows
    .filter((r) => IMAGE_EXT.test(r.rel_path))
    .map((r) => ({ id: r.id, path: r.root === 'vault' ? (vaultRoot ? join(vaultRoot, r.rel_path) : '') : join(wellRoot, r.rel_path) }))
    .filter((r) => r.path)
  return statItems(
    located,
    (r) => r.path,
    (r, size, mtimeMs) => ({ id: wellImageId(r.id), kind: 'well-image', path: r.path, size, mtimeMs, wellId: r.id })
  )
}

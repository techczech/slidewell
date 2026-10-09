/**
 * SlideWell's picture-search store: one SQLite file (`picture-search.db`) next to well.db and
 * triage.db. SlideWell is the only writer; TalkWeaver may open it read-only (ADR-0026). WAL mode so
 * readers never block the indexer.
 *
 * Schema (version 1):
 *   meta(key TEXT PRIMARY KEY, value TEXT)            model, model_revision, dim, vector_format, query_prefix
 *   vectors(id TEXT PRIMARY KEY, kind, presentation_id, slide_order, well_id, path,
 *           file_size, file_mtime_ms, embedded_at, vector BLOB)
 *   failures(id TEXT PRIMARY KEY, path, file_size, file_mtime_ms, error, failed_at)
 * `vector` is `dim` float32 values, little-endian, L2-normalised: cosine similarity = dot product.
 * ids: `slide:<presentation_id>#<slide_order>` for archive slide renders, `well:<id>` for well images.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const STORE_FILE = 'picture-search.db'
export const SCHEMA_VERSION = '1'

export type ItemKind = 'slide' | 'well-image'

/** One image the indexer should embed (a slide render or a well image). */
export type IndexItem = {
  id: string
  kind: ItemKind
  path: string
  size: number
  mtimeMs: number
  presentationId?: string
  slideOrder?: number
  wellId?: string
}

export type Fingerprint = { size: number; mtimeMs: number }

export type StoredVector = { id: string; kind: ItemKind; vector: Float32Array }

export function slideId(presentationId: string, slideOrder: number): string {
  return `slide:${presentationId}#${slideOrder}`
}
export function wellImageId(wellId: string): string {
  return `well:${wellId}`
}

function toBlob(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i], true)
  return out
}
function fromBlob(b: Uint8Array): Float32Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = new Float32Array(b.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true)
  return out
}

export class VectorStore {
  private db: DatabaseSync

  constructor(
    readonly file: string,
    meta: Record<string, string> = {}
  ) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=4000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        presentation_id TEXT,
        slide_order INTEGER,
        well_id TEXT,
        path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_mtime_ms INTEGER NOT NULL,
        embedded_at TEXT NOT NULL,
        vector BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vectors_kind ON vectors(kind);
      CREATE TABLE IF NOT EXISTS failures (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_mtime_ms INTEGER NOT NULL,
        error TEXT NOT NULL,
        failed_at TEXT NOT NULL
      );
    `)
    const put = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    for (const [k, v] of Object.entries({ schema_version: SCHEMA_VERSION, ...meta })) put.run(k, v)
  }

  meta(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  /** Fingerprints of everything already handled (embedded or failed), for resume planning. */
  fingerprints(): Map<string, Fingerprint> {
    const out = new Map<string, Fingerprint>()
    for (const table of ['vectors', 'failures']) {
      const rows = this.db.prepare(`SELECT id, file_size, file_mtime_ms FROM ${table}`).all() as Array<{ id: string; file_size: number; file_mtime_ms: number }>
      for (const r of rows) out.set(r.id, { size: Number(r.file_size), mtimeMs: Number(r.file_mtime_ms) })
    }
    return out
  }

  put(item: IndexItem, vector: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO vectors (id, kind, presentation_id, slide_order, well_id, path, file_size, file_mtime_ms, embedded_at, vector)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, presentation_id = excluded.presentation_id, slide_order = excluded.slide_order,
           well_id = excluded.well_id, path = excluded.path, file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms,
           embedded_at = excluded.embedded_at, vector = excluded.vector`
      )
      .run(item.id, item.kind, item.presentationId ?? null, item.slideOrder ?? null, item.wellId ?? null, item.path, item.size, Math.round(item.mtimeMs), new Date().toISOString(), toBlob(vector))
    this.db.prepare('DELETE FROM failures WHERE id = ?').run(item.id)
  }

  putFailure(item: IndexItem, error: string): void {
    this.db
      .prepare(
        `INSERT INTO failures (id, path, file_size, file_mtime_ms, error, failed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms,
           error = excluded.error, failed_at = excluded.failed_at`
      )
      .run(item.id, item.path, item.size, Math.round(item.mtimeMs), error.slice(0, 500), new Date().toISOString())
  }

  get(id: string): StoredVector | null {
    const r = this.db.prepare('SELECT id, kind, vector FROM vectors WHERE id = ?').get(id) as { id: string; kind: ItemKind; vector: Uint8Array } | undefined
    return r ? { id: r.id, kind: r.kind, vector: fromBlob(r.vector) } : null
  }

  /** Every stored vector (the query engine keeps these in memory). */
  all(): StoredVector[] {
    const rows = this.db.prepare('SELECT id, kind, vector FROM vectors').all() as Array<{ id: string; kind: ItemKind; vector: Uint8Array }>
    return rows.map((r) => ({ id: r.id, kind: r.kind, vector: fromBlob(r.vector) }))
  }

  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number }
    return Number(r.n)
  }

  failedCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM failures').get() as { n: number }
    return Number(r.n)
  }

  close(): void {
    this.db.close()
  }
}

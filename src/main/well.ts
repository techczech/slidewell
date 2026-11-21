/**
 * The image well — SlideWell's authoritative store for net-new images plus an index over
 * TalkWeaver vault images. Survives Core A registry rebuilds (it's not derived from extracted/).
 *
 * Sources (well_fts.source): 'screenshot' (Raycast/inbox, copied + owned), 'talkweaver' (vault
 * _assets, INDEXED IN PLACE — the vault owns the file, we never copy), future others.
 * Files SlideWell owns are content-addressed `{slug}--{id}.{ext}` (ADR-0026). OCR via Core A's
 * macOS Vision binary. Tiny well.db (FTS5, no native module — sqlite3 CLI).
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, copyFileSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type BigIntStats
} from 'node:fs'
import { join, dirname, extname, basename } from 'node:path'
import sharp from 'sharp'
import { query, run, safeFtsQuery } from './sqlite'

export function wellRoot(archiveRoot: string, override?: string | null): string {
  return override || join(archiveRoot, 'well')
}
function wellDb(root: string): string {
  return join(root, 'well.db')
}

export async function ensureWell(root: string): Promise<void> {
  mkdirSync(join(root, 'images'), { recursive: true })
  mkdirSync(join(root, '_inbox'), { recursive: true })
  await run(
    wellDb(root),
    `CREATE VIRTUAL TABLE IF NOT EXISTS well_fts USING fts5(
       id UNINDEXED, slug UNINDEXED, ext UNINDEXED, rel_path UNINDEXED,
       root UNINDEXED, source UNINDEXED, tags, notes, ocr_text, added_at UNINDEXED
     )`
  )
  await ensureWellSources(root)
}

/**
 * Content identity of well items (ticket 08). well_sources links a well id to the content hash of the
 * file it was made from: sha256 of the source bytes, first 12 hex characters — the same hash triage
 * uses as its decision key. Every ingest records it. Rows from before this table are backfilled by
 * joining through triage_decisions.well_id (what ingest already recorded); the source hash cannot be
 * recomputed from a well copy, which is re-encoded. Regular table beside the FTS index.
 * No 'emptied' marker can predate this table (Empty Bin arrived with it), and every item emptied from
 * now on got its well_sources row at ingest, so the backfill misses nothing that hiding depends on.
 */
const sourcesReady = new Set<string>()
const BACKFILL_FLAG = 'well_sources_backfilled'
async function ensureWellSources(root: string): Promise<void> {
  if (sourcesReady.has(root)) return
  const db = wellDb(root)
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS well_sources (well_id TEXT NOT NULL, source_hash TEXT NOT NULL, PRIMARY KEY (well_id, source_hash));
     CREATE TABLE IF NOT EXISTS well_meta (key TEXT PRIMARY KEY, value TEXT)`
  )
  // The backfill runs once per well, ever: a flag in well_meta, set in the same transaction and
  // checked inside it (two processes cannot both run it). Later decisions are never re-linked here,
  // because a decision's well id can name content other than its key (a file replaced after its scan).
  const done = await query<{ x: number }>(db, `SELECT 1 AS x FROM well_meta WHERE key = '${BACKFILL_FLAG}'`)
  if (!done.length) {
    const tdb = join(root, 'triage.db')
    const hasDecisions = existsSync(tdb) && Number((await query<{ n: number }>(tdb, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'triage_decisions'"))[0]?.n) > 0
    const at = new Date().toISOString()
    if (hasDecisions) {
      await run(
        db,
        `ATTACH ? AS t; BEGIN IMMEDIATE;
         INSERT OR IGNORE INTO well_sources (well_id, source_hash)
           SELECT well_id, hash FROM t.triage_decisions WHERE well_id IS NOT NULL AND well_id != ''
           AND NOT EXISTS (SELECT 1 FROM well_meta WHERE key = '${BACKFILL_FLAG}');
         INSERT OR IGNORE INTO well_meta (key, value) VALUES ('${BACKFILL_FLAG}', ?);
         COMMIT; DETACH t`,
        [tdb, at]
      )
    } else {
      await run(db, `INSERT OR IGNORE INTO well_meta (key, value) VALUES ('${BACKFILL_FLAG}', ?)`, [at])
    }
  }
  sourcesReady.add(root)
}

/** Link a well id to a source content hash (ingest; and Triage promote, with its decision key). */
export async function recordWellSource(root: string, wellId: string, sourceHash: string): Promise<void> {
  await ensureWellSources(root)
  await run(wellDb(root), 'INSERT OR IGNORE INTO well_sources (well_id, source_hash) VALUES (?, ?)', [wellId, sourceHash])
}
const recordSource = recordWellSource

function ocrBin(archiveRoot: string): { cmd: string; pre: string[] } {
  const bin = join(archiveRoot, 'tools', 'ocr', 'vision_ocr')
  if (existsSync(bin)) return { cmd: bin, pre: [] }
  return { cmd: 'swift', pre: [join(archiveRoot, 'tools', 'ocr', 'vision_ocr.swift')] }
}

/** OCR one image via Core A's macOS Vision helper. Returns recognised text ('' on any failure). */
export function ocrImage(archiveRoot: string, absPath: string): Promise<string> {
  const { cmd, pre } = ocrBin(archiveRoot)
  return new Promise((resolve) => {
    execFile(cmd, [...pre, absPath], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve('')
      const line = (stdout || '').toString().trim().split('\n')[0]
      try {
        resolve((JSON.parse(line).text as string) || '')
      } catch {
        resolve('')
      }
    })
  })
}

function slugify(text: string, fallback: string): string {
  const base = (text || '')
    .split('\n')[0]
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const words = base.split('-').filter(Boolean).slice(0, 6).join('-')
  return words || fallback
}

function nowIso(): string {
  return new Date().toISOString()
}

async function alreadyIndexed(root: string, id: string): Promise<boolean> {
  const r = await query<{ id: string }>(wellDb(root), 'SELECT id FROM well_fts WHERE id = ? LIMIT 1', [id])
  return r.length > 0
}

async function upsert(
  root: string,
  rec: { id: string; slug: string; ext: string; relPath: string; storeRoot: string; source: string; tags: string; notes: string; ocr: string }
): Promise<void> {
  await run(wellDb(root), 'DELETE FROM well_fts WHERE id = ?', [rec.id])
  await run(
    wellDb(root),
    `INSERT INTO well_fts (id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rec.id, rec.slug, rec.ext, rec.relPath, rec.storeRoot, rec.source, rec.tags, rec.notes, rec.ocr, nowIso()]
  )
}

type Ingested = {
  id: string
  relPath: string
  created: boolean
  sourceHash: string
  stored: BigIntStats
}

const OWNED_TEMP_NAME = /^\.slidewell-[0-9a-f-]{36}\.tmp(?:\.[^.]+)?$/
const activeWellTemps = new Set<string>()
export const INBOX_SETTLE_MS = 3000
const INBOX_VIDEOS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'])

function fileStat(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false })
}

function sameFile(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  if (!a || !b) return a === b
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function publishWellFile(
  dest: string,
  write: (tmp: string) => void | boolean | Promise<boolean>,
  verify?: { temp: (tmp: string) => Promise<void>; previous: BigIntStats | undefined }
): Promise<void> {
  const directory = dirname(dest)
  const tmp = join(directory, `.slidewell-${randomUUID()}.tmp${extname(dest)}`)
  activeWellTemps.add(tmp)
  try {
    if ((await write(tmp)) === false) return
    syncPath(tmp)
    if (verify) {
      await verify.temp(tmp)
      if (!sameFile(verify.previous, fileStat(dest))) throw new Error('The well destination changed during the write.')
      if (verify.previous) {
        const ext = extname(dest)
        const date = nowIso().replace(/[:.]/g, '-')
        const recovery = join(directory, `${basename(dest, ext)}.recovered-${date}-${randomUUID()}${ext}`)
        renameSync(dest, recovery)
      }
    } else if (fileStat(dest)) {
      return // a concurrent import already published this sidecar or poster
    }
    renameSync(tmp, dest)
    syncPath(directory)
  } finally {
    activeWellTemps.delete(tmp)
    rmSync(tmp, { force: true })
  }
}

async function inspectCopy(path: string, before: BigIntStats): Promise<string> {
  const hash = await hashFileStream(path)
  if (!sameFile(before, fileStat(path))) throw new Error('The well copy changed during verification.')
  return hash
}

async function storeCopy(
  dest: string,
  size: bigint,
  digest: string,
  write: (tmp: string) => void
): Promise<{ created: boolean; stored: BigIntStats }> {
  const before = fileStat(dest)
  if (before && !before.isFile()) throw new Error('The well copy path is not a regular file.')
  if (before) {
    const existing = await inspectCopy(dest, before)
    if (before.size === size && existing === digest) {
      syncPath(dest)
      syncPath(dirname(dest))
      return { created: false, stored: before }
    }
    // A genuine collision under the existing short filename must not destroy another complete copy.
    if (existing.startsWith(digest.slice(0, 7))) throw new Error('Two different well files have the same short ID.')
  }

  await publishWellFile(dest, write, {
    previous: before,
    async temp(tmp) {
      const candidate = fileStat(tmp)
      if (!candidate || candidate.size !== size || await inspectCopy(tmp, candidate) !== digest) {
        throw new Error('The temporary well copy did not verify.')
      }
    }
  })
  const stored = fileStat(dest)
  if (!stored?.isFile() || stored.size !== size || await inspectCopy(dest, stored) !== digest) {
    throw new Error('The stored well copy did not verify.')
  }
  return { created: true, stored }
}

function cleanStaleWellTemps(root: string): void {
  const cutoff = Date.now() - 60_000
  for (const directory of [join(root, 'images'), join(root, 'videos')]) {
    let names: string[]
    try {
      if (!fileStat(directory)?.isDirectory()) continue
      names = readdirSync(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (!OWNED_TEMP_NAME.test(name)) continue
      const path = join(directory, name)
      if (activeWellTemps.has(path)) continue
      try {
        const entry = fileStat(path)
        if (entry?.isFile() && Number(entry.mtimeMs) < cutoff) rmSync(path, { force: true })
      } catch {
        /* a failed cleanup need not stop an inbox retry */
      }
    }
  }
}

/** Ingest a net-new image (screenshot etc.): normalise to WebP, content-address, OCR, store + index. */
export async function ingestScreenshot(
  archiveRoot: string,
  root: string,
  srcPath: string,
  source = 'screenshot'
): Promise<Ingested | null> {
  if (!existsSync(srcPath)) return null
  await ensureWell(root)
  const orig = readFileSync(srcPath)
  const sourceHash = createHash('sha256').update(orig).digest('hex').slice(0, 12)
  let buf: Buffer = orig
  let ext = (extname(srcPath).slice(1) || 'png').toLowerCase()
  // Inbox videos keep their original searchable well row and must keep their original bytes.
  if (!INBOX_VIDEOS.has(`.${ext}`)) {
    try {
      const webp = await sharp(orig).webp({ quality: 82 }).toBuffer()
      if (webp.length > 0 && webp.length <= orig.length) {
        buf = webp
        ext = 'webp'
      }
    } catch {
      /* keep original */
    }
  }
  const digest = createHash('sha256').update(buf).digest('hex')
  const id = digest.slice(0, 7)
  const text = await ocrImage(archiveRoot, srcPath)
  const slug = slugify(text, 'screenshot')
  const relPath = join('images', `${slug}--${id}.${ext}`)
  const dest = join(root, relPath)
  const { created, stored } = await storeCopy(dest, BigInt(buf.length), digest, (tmp) => writeFileSync(tmp, buf, { flag: 'wx' }))
  const sidecar = join(root, 'images', `${slug}--${id}.yml`)
  if (!existsSync(sidecar)) {
    const yaml = [`id: ${id}`, `created: ${nowIso().slice(0, 10)}`, 'provenance: added', `source: ${source}`, 'alt: ""', 'caption: ""', 'tags: []', 'notes: ""'].join('\n') + '\n'
    await publishWellFile(sidecar, (tmp) => writeFileSync(tmp, yaml, { flag: 'wx' }))
  }
  await upsert(root, { id, slug, ext, relPath, storeRoot: 'well', source, tags: '', notes: '', ocr: text })
  await recordSource(root, id, sourceHash)
  return { id, relPath, created, sourceHash, stored }
}

export function findFfmpeg(): string {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (existsSync(p)) return p
  return 'ffmpeg'
}

/** Grab one representative frame from a video (1s in; fall back to frame 0 for very short clips). */
export function makePoster(srcAbs: string, destAbs: string): Promise<boolean> {
  const ff = findFfmpeg()
  const args = (ss: string): string[] => ['-loglevel', 'error', '-ss', ss, '-i', srcAbs, '-frames:v', '1', '-q:v', '3', '-y', destAbs]
  return new Promise((resolve) => {
    execFile(ff, args('1'), { timeout: 25000 }, (err) => {
      if (!err && existsSync(destAbs)) return resolve(true)
      execFile(ff, args('0'), { timeout: 25000 }, (e2) => resolve(!e2 && existsSync(destAbs)))
    })
  })
}

function hashFileStream(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

/**
 * Promote a short video into the well (ADR-0029): copy as-is (never re-encoded — ADR-0028), generate
 * a poster, write a `vid`-style sidecar. Stored as `{slug}--{id}.{ext}` under `videos/` so it is
 * discoverable on disk without the app (ADR-0026) and reusable by TalkWeaver. The 20 MB gate is
 * enforced by the caller (triage), so a forced large video still copies here.
 */
export async function ingestVideo(archiveRoot: string, root: string, srcPath: string): Promise<Ingested | null> {
  if (!existsSync(srcPath)) return null
  await ensureWell(root)
  mkdirSync(join(root, 'videos'), { recursive: true })
  const ext = (extname(srcPath).slice(1) || 'mp4').toLowerCase()
  const size = statSync(srcPath, { bigint: true, throwIfNoEntry: false })?.size
  if (size === undefined) return null
  const full = await hashFileStream(srcPath)
  const id = full.slice(0, 7)
  const slug = slugify(basename(srcPath).replace(/\.[^.]+$/, ''), 'video')
  const relPath = join('videos', `${slug}--${id}.${ext}`)
  const dest = join(root, relPath)
  const { created, stored } = await storeCopy(dest, size, full, (tmp) => copyFileSync(srcPath, tmp, constants.COPYFILE_EXCL))
  const poster = join(root, 'videos', `${slug}--${id}.jpg`)
  if (!existsSync(poster)) await publishWellFile(poster, (tmp) => makePoster(dest, tmp))
  const sidecar = join(root, 'videos', `${slug}--${id}.yml`)
  if (!existsSync(sidecar)) {
    const yaml = [`id: ${id}`, `created: ${nowIso().slice(0, 10)}`, 'provenance: added', 'source: triage', 'kind: video', 'alt: ""', 'caption: ""', 'tags: []', 'notes: ""'].join('\n') + '\n'
    await publishWellFile(sidecar, (tmp) => writeFileSync(tmp, yaml, { flag: 'wx' }))
  }
  const sourceHash = full.slice(0, 12)
  await recordSource(root, id, sourceHash)
  return { id, relPath, created, sourceHash, stored }
}

function readSidecarField(yml: string, key: string): string {
  const m = yml.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
  if (!m) return ''
  return m[1].trim().replace(/^["']|["']$/g, '').replace(/^\[|\]$/g, '')
}

/** Index a TalkWeaver vault image IN PLACE (no copy). relPath is vault-relative, e.g. _assets/img-ab12cd3.webp. */
export async function indexVaultImage(archiveRoot: string, root: string, vaultRoot: string, relPath: string): Promise<boolean> {
  await ensureWell(root)
  const file = basename(relPath)
  const idMatch = file.match(/img-([0-9a-f]{7,})\./i)
  const id = idMatch ? idMatch[1].slice(0, 7) : createHash('sha256').update(relPath).digest('hex').slice(0, 7)
  if (await alreadyIndexed(root, id)) return false
  const abs = join(vaultRoot, relPath)
  if (!existsSync(abs)) return false
  const text = await ocrImage(archiveRoot, abs)
  let tags = ''
  let notes = ''
  const sidecar = join(vaultRoot, dirname(relPath), file.replace(/\.[^.]+$/, '.yml'))
  if (existsSync(sidecar)) {
    const yml = readFileSync(sidecar, 'utf8')
    tags = readSidecarField(yml, 'tags')
    notes = [readSidecarField(yml, 'caption'), readSidecarField(yml, 'alt')].filter(Boolean).join(' — ')
  }
  const ext = (extname(relPath).slice(1) || 'webp').toLowerCase()
  const slug = slugify(text || notes, file.replace(/\.[^.]+$/, ''))
  await upsert(root, { id, slug, ext, relPath, storeRoot: 'vault', source: 'talkweaver', tags, notes, ocr: text })
  return true
}

export interface WellRow {
  id: string
  slug: string
  ext: string
  rel_path: string
  root: string // 'well' | 'vault'
  source: string
  tags: string
  notes: string
  ocr_text: string
  added_at: string
}

/**
 * Well ids hidden because their content was emptied from the review's Bin (ticket 08). Hidden by
 * content identity only: any well row whose source content hash (well_sources) has an 'emptied'
 * decision. Not by the well id a decision names, which can point at other content (a file replaced
 * after its scan). Nothing is deleted; the rows stay, hidden from every well
 * listing (searchWell, wellByIds — which every picture-search resolve path goes through).
 *
 * picture-search.db still holds vectors for emptied items (`well:<id>`, `triage:<hash>`); SlideWell's
 * resolve drops them here. Other readers of that store (TalkWeaver later) must filter by the emptied
 * markers in triage.db themselves.
 */
async function hiddenWellIds(root: string): Promise<string[]> {
  const tdb = join(root, 'triage.db')
  if (!existsSync(tdb) || !existsSync(wellDb(root))) return []
  let emptied: Array<{ hash: string }>
  try {
    emptied = await query<{ hash: string }>(tdb, "SELECT hash FROM triage_decisions WHERE state = 'emptied'", [])
  } catch {
    return [] // no decisions table yet
  }
  if (!emptied.length) return []
  await ensureWellSources(root)
  const ids = new Set<string>()
  const hashes = emptied.map((e) => e.hash)
  for (let i = 0; i < hashes.length; i += 400) {
    const chunk = hashes.slice(i, i + 400)
    const r = await query<{ well_id: string }>(wellDb(root), `SELECT well_id FROM well_sources WHERE source_hash IN (${chunk.map(() => '?').join(',')})`, chunk)
    for (const x of r) ids.add(x.well_id)
  }
  return [...ids]
}

/** Search the well (FTS over ocr/tags/notes); empty query lists newest first. */
export async function searchWell(root: string, raw: string, limit = 60, onlyIds?: string[]): Promise<WellRow[]> {
  const db = wellDb(root)
  if (!existsSync(db)) return []
  if (onlyIds && onlyIds.length === 0) return []
  const cols = 'id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at'
  const idIn = onlyIds ? ` AND id IN (${onlyIds.map(() => '?').join(',')})` : ''
  const idParams = onlyIds ?? []
  const hidden = await hiddenWellIds(root)
  const notHidden = hidden.length ? ` AND id NOT IN (${hidden.map(() => '?').join(',')})` : ''
  if (raw && raw.trim().length >= 2) {
    const q = safeFtsQuery(raw)
    return query<WellRow>(db, `SELECT ${cols} FROM well_fts WHERE well_fts MATCH ?${idIn}${notHidden} ORDER BY rank LIMIT ?`, [q, ...idParams, ...hidden, limit])
  }
  return query<WellRow>(db, `SELECT ${cols} FROM well_fts WHERE 1=1${idIn}${notHidden} ORDER BY added_at DESC LIMIT ?`, [...idParams, ...hidden, limit])
}

/** Well rows by id (picture-search hits resolve to these). Unknown and hidden ids are simply absent. */
export async function wellByIds(root: string, ids: string[]): Promise<WellRow[]> {
  const db = wellDb(root)
  if (!existsSync(db) || ids.length === 0) return []
  const hidden = new Set(await hiddenWellIds(root))
  const want = ids.filter((id) => !hidden.has(id))
  if (!want.length) return []
  const cols = 'id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at'
  return query<WellRow>(db, `SELECT ${cols} FROM well_fts WHERE id IN (${want.map(() => '?').join(',')})`, want)
}

/** Scan the TalkWeaver vault _assets pool and index any not-yet-indexed images. Returns count added. */
export async function scanVault(archiveRoot: string, root: string, vaultRoot: string): Promise<number> {
  const assets = join(vaultRoot, '_assets')
  if (!existsSync(assets)) return 0
  let added = 0
  for (const f of readdirSync(assets)) {
    if (!/^img-[0-9a-f]{7,}\.(webp|png|jpg|jpeg)$/i.test(f)) continue
    if (await indexVaultImage(archiveRoot, root, vaultRoot, join('_assets', f))) added++
  }
  return added
}

/** Resolve a well row to an absolute file path (well store or vault). */
export function wellAbsPath(root: string, vaultRoot: string | null, row: WellRow): string | null {
  if (row.root === 'vault') return vaultRoot ? join(vaultRoot, row.rel_path) : null
  return join(root, row.rel_path)
}

/** Process any files sitting in the inbox: ingest each, then remove the inbox copy. */
export async function drainInbox(archiveRoot: string, root: string, retryWhenSettled?: () => void): Promise<number> {
  const inbox = join(root, '_inbox')
  if (!existsSync(inbox)) return 0
  cleanStaleWellTemps(root)
  let n = 0
  for (const f of readdirSync(inbox)) {
    if (f.startsWith('.')) continue
    const p = join(inbox, f)
    try {
      const original = fileStat(p)
      if (!original?.isFile() || original.size === 0n) continue
      if (Date.now() - Number(original.mtimeMs) < INBOX_SETTLE_MS) {
        retryWhenSettled?.()
        continue
      }
      const res = await ingestScreenshot(archiveRoot, root, p, 'screenshot')
      if (res && sameFile(res.stored, fileStat(join(root, res.relPath))) && sameFile(original, fileStat(p))) {
        rmSync(p, { force: true })
        n++
      }
    } catch {
      /* leave it for next pass */
    }
  }
  return n
}


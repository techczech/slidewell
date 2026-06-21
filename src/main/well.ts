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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, createReadStream } from 'node:fs'
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
}

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

/** Ingest a net-new image (screenshot etc.): normalise to WebP, content-address, OCR, store + index. */
export async function ingestScreenshot(
  archiveRoot: string,
  root: string,
  srcPath: string,
  source = 'screenshot'
): Promise<{ id: string; relPath: string } | null> {
  if (!existsSync(srcPath)) return null
  await ensureWell(root)
  const orig = readFileSync(srcPath)
  let buf = orig
  let ext = (extname(srcPath).slice(1) || 'png').toLowerCase()
  try {
    const webp = await sharp(orig).webp({ quality: 82 }).toBuffer()
    if (webp.length > 0 && webp.length <= orig.length) {
      buf = webp
      ext = 'webp'
    }
  } catch {
    /* keep original */
  }
  const id = createHash('sha256').update(buf).digest('hex').slice(0, 7)
  const text = await ocrImage(archiveRoot, srcPath)
  const slug = slugify(text, 'screenshot')
  const relPath = join('images', `${slug}--${id}.${ext}`)
  const dest = join(root, relPath)
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
    const sidecar = join(root, 'images', `${slug}--${id}.yml`)
    writeFileSync(
      sidecar,
      [`id: ${id}`, `created: ${nowIso().slice(0, 10)}`, 'provenance: added', `source: ${source}`, 'alt: ""', 'caption: ""', 'tags: []', 'notes: ""'].join('\n') + '\n',
      'utf8'
    )
  }
  await upsert(root, { id, slug, ext, relPath, storeRoot: 'well', source, tags: '', notes: '', ocr: text })
  return { id, relPath }
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
  return new Promise((resolve) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex').slice(0, 7)))
    s.on('error', () => resolve(createHash('sha256').update(path).digest('hex').slice(0, 7)))
  })
}

/**
 * Promote a short video into the well (ADR-0029): copy as-is (never re-encoded — ADR-0028), generate
 * a poster, write a `vid`-style sidecar. Stored as `{slug}--{id}.{ext}` under `videos/` so it is
 * discoverable on disk without the app (ADR-0026) and reusable by TalkWeaver. The 20 MB gate is
 * enforced by the caller (triage), so a forced large video still copies here.
 */
export async function ingestVideo(archiveRoot: string, root: string, srcPath: string): Promise<{ id: string; relPath: string } | null> {
  if (!existsSync(srcPath)) return null
  await ensureWell(root)
  mkdirSync(join(root, 'videos'), { recursive: true })
  const ext = (extname(srcPath).slice(1) || 'mp4').toLowerCase()
  const id = await hashFileStream(srcPath)
  const slug = slugify(basename(srcPath).replace(/\.[^.]+$/, ''), 'video')
  const relPath = join('videos', `${slug}--${id}.${ext}`)
  const dest = join(root, relPath)
  if (!existsSync(dest)) {
    copyFileSync(srcPath, dest)
    const posterAbs = join(root, 'videos', `${slug}--${id}.jpg`)
    await makePoster(srcPath, posterAbs)
    const sidecar = join(root, 'videos', `${slug}--${id}.yml`)
    writeFileSync(
      sidecar,
      [`id: ${id}`, `created: ${nowIso().slice(0, 10)}`, 'provenance: added', 'source: triage', 'kind: video', 'alt: ""', 'caption: ""', 'tags: []', 'notes: ""'].join('\n') + '\n',
      'utf8'
    )
  }
  return { id, relPath }
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

/** Search the well (FTS over ocr/tags/notes); empty query lists newest first. */
export async function searchWell(root: string, raw: string, limit = 60): Promise<WellRow[]> {
  const db = wellDb(root)
  if (!existsSync(db)) return []
  const cols = 'id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at'
  if (raw && raw.trim().length >= 2) {
    const q = safeFtsQuery(raw)
    return query<WellRow>(db, `SELECT ${cols} FROM well_fts WHERE well_fts MATCH ? ORDER BY rank LIMIT ?`, [q, limit])
  }
  return query<WellRow>(db, `SELECT ${cols} FROM well_fts ORDER BY added_at DESC LIMIT ?`, [limit])
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
export async function drainInbox(archiveRoot: string, root: string): Promise<number> {
  const inbox = join(root, '_inbox')
  if (!existsSync(inbox)) return 0
  let n = 0
  for (const f of readdirSync(inbox)) {
    if (f.startsWith('.')) continue
    const p = join(inbox, f)
    try {
      const res = await ingestScreenshot(archiveRoot, root, p, 'screenshot')
      if (res) {
        rmSync(p, { force: true }) // remove the inbox copy (the stored copy lives in images/)
        n++
      }
    } catch {
      /* leave it for next pass */
    }
  }
  return n
}

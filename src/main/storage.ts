/**
 * Per-store storage backend (spec 2026-06-24): when a store is R2-backed, its media files live in
 * R2 (path-mirrored keys `<prefix>/<store>/<relPath>`) and the local store directory doubles as the
 * cache. This module is the engine: which store a path belongs to, the R2 key for it, fetch-on-miss,
 * and a media sync (upload). It takes R2 settings/creds as arguments — index.ts wires the config.
 *
 * This increment implements read-through (fetch-on-miss) + upload. Bounded-cache eviction is a
 * later sub-increment; until then nothing is ever auto-deleted locally (full-mirror semantics).
 */
import { join, relative, dirname, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { makeR2, r2KeyFor, type R2Settings, type R2Creds } from './r2'
import { folderUnderRoots, makeableUnderRoots, plainWritePath } from './swarchive-guard'

export type StoreName = 'archive' | 'others' | 'well'

// Media this engine offloads to R2. Relational indexes (*.db) and structure (*.json) stay local.
const MEDIA_EXTS = new Set(['webp', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'mp4', 'webm', 'mov', 'm4v'])

function mediaExt(name: string): boolean {
  return MEDIA_EXTS.has(name.split('.').pop()?.toLowerCase() ?? '')
}

/** Which store root contains absPath (exact directory boundary — '/a/well' ≠ '/a/wellington'). */
export function pickStore(roots: Partial<Record<StoreName, string>>, absPath: string): { store: StoreName; root: string } | null {
  const target = resolve(absPath)
  for (const [store, root] of Object.entries(roots)) {
    if (!root) continue
    const r = resolve(root)
    if (target === r || target.startsWith(r + sep)) return { store: store as StoreName, root }
  }
  return null
}

/** Path-mirrored R2 key for a file under a store root: `<prefix>/<store>/<relPathFromRoot>`. */
export function keyForPath(prefix: string, store: StoreName, root: string, absPath: string): string {
  return r2KeyFor(prefix, store, relative(root, absPath))
}

/** Write all of `bytes` to `fd`; a write that makes no progress (disk full) throws. */
function writeAll(fd: number, bytes: Buffer): void {
  let off = 0
  while (off < bytes.length) {
    const n = writeSync(fd, bytes, off, bytes.length - off)
    if (n <= 0) throw new Error('short write')
    off += n
  }
}

/** Remove a temporary file if it is there; never throws. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // nothing more to do: a leftover .part file is never served or uploaded
  }
}

/**
 * Fetch one object from R2 into destAbs (creating parent dirs). Returns true on success.
 * A destAbs that is relative or has a '..' segment is refused before anything is fetched or touched
 * (plainWritePath); every later step uses that one validated path.
 * The folder is checked before any folder is made (its nearest existing ancestor under `roots`), then again once
 * made. The bytes go to a new temporary file in that folder (exclusive create, a short random name independent of
 * destAbs, so a long file name stays within the name limit), every byte written, the folder re-checked (anything
 * may have changed during the download), and the file renamed into place: a rename replaces a link planted at
 * destAbs instead of writing through it. On any failure the temporary file is removed and nothing is written at
 * destAbs.
 */
export async function fetchFromR2(cfg: R2Settings, creds: R2Creds, key: string, destAbs: string, roots: string[]): Promise<boolean> {
  const dest = plainWritePath(destAbs)
  if (dest === null) return false
  let tmp: string | null = null
  try {
    const resp = await makeR2(cfg, creds).get(key)
    if (!resp.ok) return false
    const bytes = Buffer.from(await resp.arrayBuffer())
    const dir = dirname(dest)
    if (!makeableUnderRoots(dir, roots)) return false
    mkdirSync(dir, { recursive: true })
    if (!folderUnderRoots(dir, roots)) return false
    // not a media extension, so a leftover is never uploaded by syncDirToR2
    const name = join(dir, `.sw-${randomBytes(8).toString('hex')}.part`)
    const fd = openSync(name, 'wx')
    tmp = name // ours from here on: removed on any failure (never a file this call did not create)
    try {
      writeAll(fd, bytes)
    } finally {
      closeSync(fd)
    }
    if (!folderUnderRoots(dir, roots)) return false
    renameSync(tmp, dest)
    tmp = null
    return true
  } catch {
    return false
  } finally {
    if (tmp) removeQuietly(tmp)
  }
}

/** List media files (absolute paths) under a directory tree. */
export function listMedia(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (mediaExt(e.name)) out.push(p)
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

/** Mirror a store's media to R2 (idempotent: skip objects already present). */
export async function syncDirToR2(
  cfg: R2Settings,
  creds: R2Creds,
  prefix: string,
  store: StoreName,
  root: string,
  onLine?: (s: string) => void
): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const r = makeR2(cfg, creds)
  const files = listMedia(root)
  let uploaded = 0
  let skipped = 0
  let failed = 0
  onLine?.(`Syncing ${files.length} media file(s) from ${store} → R2…`)
  for (const abs of files) {
    const key = keyForPath(prefix, store, root, abs)
    try {
      const head = await r.head(key)
      if (head.ok) {
        skipped++
        continue
      }
      const put = await r.put(key, readFileSync(abs))
      if (put.ok) uploaded++
      else {
        failed++
        onLine?.(`⚠ upload failed (${put.status}): ${key}`)
      }
    } catch (e) {
      failed++
      onLine?.(`⚠ ${key}: ${(e as Error).message}`)
    }
  }
  onLine?.(`✓ R2 sync: ${uploaded} uploaded, ${skipped} already present${failed ? `, ${failed} failed` : ''}`)
  return { uploaded, skipped, failed }
}

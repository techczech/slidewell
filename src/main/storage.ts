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
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { makeR2, r2KeyFor, type R2Settings, type R2Creds } from './r2'

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

/** Fetch one object from R2 into destAbs (creating parent dirs). Returns true on success. */
export async function fetchFromR2(cfg: R2Settings, creds: R2Creds, key: string, destAbs: string): Promise<boolean> {
  try {
    const resp = await makeR2(cfg, creds).get(key)
    if (!resp.ok) return false
    mkdirSync(dirname(destAbs), { recursive: true })
    writeFileSync(destAbs, Buffer.from(await resp.arrayBuffer()))
    return true
  } catch {
    return false
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

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, relative } from 'node:path'
import { downloadedOnDisk } from '../review/picture'

export const MAX_RENDITION = 20 * 1024 * 1024
const TYPES: Record<string, string> = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
}

export type Source = {
  itemId: string; corpusId: 'slides' | 'well'; title: string; snippet: string; source: string
  revision: string; path: string; root: string
}
export type Rendition = Source & { sourceRevision: string; mime: string; path: string; size: number }

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

export function signature(st: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':')
}

function revision(source: Source, st: Parameters<typeof signature>[0]): string {
  return createHash('sha256').update(source.revision).update(signature(st)).digest('hex')
}

export async function inspect(source: Source | null): Promise<Rendition | null> {
  if (!source || !inside(source.root, source.path)) return null
  const mime = TYPES[extname(source.path).toLowerCase()]
  if (!mime) return null
  try {
    const canonical = await realpath(source.path)
    // Require canonical components throughout. Managed roots themselves are canonicalised at startup.
    if (canonical !== source.path || !downloadedOnDisk(canonical)) return null
    const st = await lstat(canonical, { bigint: true })
    if (!st.isFile() || st.size < 1n || st.size > BigInt(MAX_RENDITION)) return null
    return { ...source, mime, size: Number(st.size), sourceRevision: revision(source, st) }
  } catch {
    return null
  }
}

async function withVerifiedFile<T>(item: Rendition, read: (file: FileHandle) => Promise<T | null>): Promise<T | null> {
  // Recheck both the open inode and the canonical path after using the file.
  const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!file) return null
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || revision(item, before) !== item.sourceRevision) return null
    const result = await read(file)
    const after = await file.stat({ bigint: true })
    const current = await inspect(item)
    if (revision(item, after) !== item.sourceRevision || current?.sourceRevision !== item.sourceRevision) return null
    return result
  } finally {
    await file.close()
  }
}

export function readRendition(item: Rendition): Promise<Buffer | null> {
  return withVerifiedFile(item, async (file) => {
    const bytes = Buffer.alloc(item.size)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    return bytesRead === item.size ? bytes : null
  })
}

export async function verifyRendition(item: Rendition): Promise<boolean> {
  // A cached preview can skip rereading bytes of the same verified file.
  return await withVerifiedFile(item, async () => true) === true
}

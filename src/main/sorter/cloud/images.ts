/**
 * A screenshot read and shrunk for Luna.
 *
 *   readVerified(path, hash): the file's bytes, only when the path is a regular file (not a symlink,
 *     not a folder or device) and the bytes hash to the content hash the screenshot was classified
 *     under (sha256, first 12 hex characters, as triage.ts hashes). The bytes that were hashed are
 *     the bytes that get shrunk and sent: one open file descriptor, no second read of the path.
 *   shrinkForLuna(bytes): long edge at most LUNA.longEdge pixels, JPEG, transparency on white.
 *
 * Reads the original only; nothing is written to disk.
 */
import { createHash } from 'node:crypto'
import { constants, promises as fsp } from 'node:fs'
import sharp from 'sharp'
import { LUNA } from './luna'

/** Larger files are not screenshots worth sending; they are refused rather than read into memory. */
export const MAX_SEND_BYTES = 64 * 1024 * 1024

export type VerifyRefusal = 'symlink' | 'not-a-file' | 'too-large' | 'changed' | 'unreadable'
export type Verified = { ok: true; bytes: Buffer } | { ok: false; why: VerifyRefusal }

/** The content hash triage.ts records for a file's bytes. */
export function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

export async function readVerified(path: string, hash: string): Promise<Verified> {
  let fh: fsp.FileHandle | null = null
  try {
    try {
      // O_NOFOLLOW: a symlink at the last path component fails to open (ELOOP) instead of being followed
      fh = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      return { ok: false, why: code === 'ELOOP' || code === 'EMLINK' ? 'symlink' : 'unreadable' }
    }
    const st = await fh.stat()
    if (!st.isFile()) return { ok: false, why: 'not-a-file' }
    if (st.size > MAX_SEND_BYTES) return { ok: false, why: 'too-large' }
    const bytes = await fh.readFile()
    if (bytes.length > MAX_SEND_BYTES) return { ok: false, why: 'too-large' }
    return contentHash(bytes) === hash ? { ok: true, bytes } : { ok: false, why: 'changed' }
  } catch {
    return { ok: false, why: 'unreadable' }
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

export async function shrinkForLuna(input: Buffer, longEdge: number = LUNA.longEdge): Promise<{ mime: string; base64: string; width: number; height: number }> {
  const { data, info } = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: LUNA.jpegQuality })
    .toBuffer({ resolveWithObject: true })
  return { mime: 'image/jpeg', base64: data.toString('base64'), width: info.width, height: info.height }
}

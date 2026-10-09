/**
 * The pixel fingerprint of an image file: a 64-bit dHash (groups.ts) from a 9×8 greyscale resize.
 * Reads the file locally with sharp (no network); remembered per path + size + mtime so a result
 * list asks the disk once per image. Never throws: an unreadable image has no fingerprint.
 */
import sharp from 'sharp'
import { statSync } from 'node:fs'
import { dHashFromGrey } from './groups'

export async function dHashOfFile(path: string): Promise<bigint | null> {
  try {
    const { data, info } = await sharp(path, { failOn: 'none', limitInputPixels: 268_402_689 })
      .greyscale()
      .resize(9, 8, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== 9 || info.height !== 8 || data.length < 72) return null
    return dHashFromGrey(data)
  } catch {
    return null
  }
}

const cache = new Map<string, bigint | null>()
const CACHE_MAX = 5000

/** dHash with a small in-memory memo keyed by path, size and mtime. */
export async function cachedDHash(path: string): Promise<bigint | null> {
  let key = path
  try {
    const st = statSync(path)
    key = `${path}|${st.size}|${Math.round(st.mtimeMs)}`
  } catch {
    return null
  }
  if (cache.has(key)) return cache.get(key) ?? null
  const h = await dHashOfFile(path)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, h)
  return h
}

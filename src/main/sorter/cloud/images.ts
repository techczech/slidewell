/**
 * A screenshot shrunk for Luna: long edge at most LUNA.longEdge pixels, JPEG, transparency on white.
 * Reads the original only; nothing is written to disk.
 */
import sharp from 'sharp'
import { LUNA } from './luna'

export async function shrinkForLuna(path: string, longEdge: number = LUNA.longEdge): Promise<{ mime: string; base64: string; width: number; height: number }> {
  const { data, info } = await sharp(path, { failOn: 'error' })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: LUNA.jpegQuality })
    .toBuffer({ resolveWithObject: true })
  return { mime: 'image/jpeg', base64: data.toString('base64'), width: info.width, height: info.height }
}

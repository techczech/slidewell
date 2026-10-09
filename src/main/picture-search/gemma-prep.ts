/**
 * EmbeddingGemma 2 input preparation in the main process, without transformers.js at runtime:
 *   - images: the Gemma4 image processor (aspect-preserving bicubic resize to the soft-token
 *     budget, rescale to 0..1, 16×16 patches, (col,row) position ids, -1 padding), done with sharp;
 *   - text: the model's tokenizer (`@huggingface/tokenizers` over the downloaded tokenizer.json).
 * This mirrors transformers.js 4.3.0 `Gemma4ImageProcessor` step for step (same sharp calls), so
 * the pixels match the spike that produced the recorded quality numbers; test/gemma-prep.test.ts
 * checks equality against transformers.js when the model is on disk.
 */
import sharp from 'sharp'
import { Tokenizer } from '@huggingface/tokenizers'

export type ImageProcessorConfig = {
  patch_size: number
  max_soft_tokens: number
  pooling_kernel_size: number
  rescale_factor: number
}

export type PreparedImage = {
  pixelValues: Float32Array
  dims: [number, number, number]
  positions: BigInt64Array
  posDims: [number, number, number]
  numSoftTokens: number
}

/** Target (height, width): multiples of pooling·patch, as large as fits max_patches. */
export function aspectSize(height: number, width: number, patch: number, maxPatches: number, pool: number): [number, number] {
  const targetPx = maxPatches * patch ** 2
  const factor = Math.sqrt(targetPx / (height * width))
  const side = pool * patch
  let th = Math.floor((factor * height) / side) * side
  let tw = Math.floor((factor * width) / side) * side
  if (th === 0 && tw === 0) throw new Error('image too small to embed')
  const maxSide = Math.floor(maxPatches / pool ** 2) * side
  if (th === 0) {
    th = side
    tw = Math.min(Math.floor(width / height) * side, maxSide)
  } else if (tw === 0) {
    tw = side
    th = Math.min(Math.floor(height / width) * side, maxSide)
  }
  return [th, tw]
}

/** HWC float pixels → [maxPatches, patch²·C] patches + [maxPatches, 2] (col,row) ids, -1 padded. */
export function patchify(hwc: Float32Array, H: number, W: number, C: number, patch: number, maxPatches: number, pool: number): Omit<PreparedImage, 'dims' | 'posDims'> {
  const ph = Math.floor(H / patch)
  const pw = Math.floor(W / patch)
  const patchDim = patch * patch * C
  const data = new Float32Array(maxPatches * patchDim)
  let out = 0
  for (let r = 0; r < ph; ++r)
    for (let c = 0; c < pw; ++c)
      for (let dy = 0; dy < patch; ++dy) {
        const row = (r * patch + dy) * W * C + c * patch * C
        for (let dx = 0; dx < patch; ++dx) {
          const src = row + dx * C
          for (let k = 0; k < C; ++k) data[out++] = hwc[src + k]
        }
      }
  const pos = new BigInt64Array(maxPatches * 2).fill(-1n)
  let i = 0
  for (let r = 0; r < ph; ++r)
    for (let c = 0; c < pw; ++c) {
      pos[i++] = BigInt(c)
      pos[i++] = BigInt(r)
    }
  return { pixelValues: data, positions: pos, numSoftTokens: Math.floor((ph * pw) / pool ** 2) }
}

type Raw = { data: Uint8Array; width: number; height: number; channels: number }

async function decode(img: sharp.Sharp): Promise<Raw> {
  const { data, info } = await img.rotate().raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, channels: info.channels }
}

function toRgb(im: Raw): Raw {
  if (im.channels === 3) return im
  const px = im.width * im.height
  const out = new Uint8Array(px * 3)
  for (let i = 0; i < px; i++) {
    const s = i * im.channels
    const g = im.channels <= 2
    out[i * 3] = im.data[s]
    out[i * 3 + 1] = g ? im.data[s] : im.data[s + 1]
    out[i * 3 + 2] = g ? im.data[s] : im.data[s + 2]
  }
  return { data: out, width: im.width, height: im.height, channels: 3 }
}

/** Decode, resize and patchify one image file (or encoded buffer) for the vision encoder. */
export async function prepareImage(input: string | Buffer, cfg: ImageProcessorConfig): Promise<PreparedImage> {
  const maxPatches = cfg.max_soft_tokens * cfg.pooling_kernel_size ** 2
  let im = toRgb(await decode(sharp(input)))
  const [th, tw] = aspectSize(im.height, im.width, cfg.patch_size, maxPatches, cfg.pooling_kernel_size)
  if (th !== im.height || tw !== im.width) {
    const resized = sharp(im.data, { raw: { width: im.width, height: im.height, channels: 3 } }).affine([tw / im.width, 0, 0, th / im.height], { interpolator: 'bicubic' })
    im = toRgb(await decode(resized))
  }
  const px = new Float32Array(im.data.length)
  for (let i = 0; i < px.length; i++) px[i] = im.data[i] * cfg.rescale_factor
  const p = patchify(px, im.height, im.width, 3, cfg.patch_size, maxPatches, cfg.pooling_kernel_size)
  const patchDim = cfg.patch_size * cfg.patch_size * 3
  return { ...p, dims: [1, maxPatches, patchDim], posDims: [1, maxPatches, 2] }
}

/** The tokenizer plus the image-token sequence the text model expects around image features. */
export class GemmaText {
  private tok: Tokenizer
  private boi: string
  private img: string
  private eoi: string
  private imageIdsMemo = new Map<number, Int32Array>()

  constructor(tokenizerJson: string, tokenizerConfigJson: string) {
    const cfg = JSON.parse(tokenizerConfigJson) as Record<string, unknown>
    this.tok = new Tokenizer(JSON.parse(tokenizerJson), cfg)
    this.boi = String(cfg.boi_token ?? '<|image>')
    this.img = String(cfg.image_token ?? '<|image|>')
    this.eoi = String(cfg.eoi_token ?? '<image|>')
  }

  ids(text: string): Int32Array {
    return Int32Array.from(this.tok.encode(text).ids)
  }

  /** BOS, <|image>, <|image|>×n, <image|>, EOS — as the spike validated against the reference. */
  imageIds(numSoftTokens: number): Int32Array {
    let v = this.imageIdsMemo.get(numSoftTokens)
    if (!v) {
      v = this.ids(this.boi + this.img.repeat(numSoftTokens) + this.eoi)
      this.imageIdsMemo.set(numSoftTokens, v)
    }
    return v
  }
}

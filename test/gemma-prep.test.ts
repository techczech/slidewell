import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'
import { aspectSize, patchify, prepareImage, GemmaText } from '../src/main/picture-search/gemma-prep'

const cfg = { patch_size: 16, max_soft_tokens: 280, pooling_kernel_size: 3, rescale_factor: 1 / 255 }

describe('Gemma image prep (pure parts)', () => {
  it('sizes a 16:9 slide render to multiples of 48 within the 2520-patch budget', () => {
    const [h, w] = aspectSize(1125, 2000, 16, 2520, 3)
    expect(h % 48).toBe(0)
    expect(w % 48).toBe(0)
    expect((h / 16) * (w / 16)).toBeLessThanOrEqual(2520)
    expect(w / h).toBeCloseTo(2000 / 1125, 0)
  })

  it('patchifies row-major with (col,row) ids and -1 padding', () => {
    const H = 32
    const W = 48
    const px = new Float32Array(H * W * 3).map((_, i) => i)
    const p = patchify(px, H, W, 3, 16, 10, 1)
    expect(p.numSoftTokens).toBe(6)
    expect(Array.from(p.positions.slice(0, 6), Number)).toEqual([0, 0, 1, 0, 2, 0])
    expect(p.positions[12]).toBe(-1n)
    expect(p.pixelValues[0]).toBe(0)
    expect(p.pixelValues[3 * 16]).toBe(W * 3) // second row of the first patch
  })

  it('prepares a real encoded image into the fixed-size encoder input', async () => {
    const png = await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 200, g: 40, b: 10, alpha: 0.5 } } }).png().toBuffer()
    const p = await prepareImage(png, cfg)
    expect(p.dims).toEqual([1, 2520, 768])
    expect(p.pixelValues.length).toBe(2520 * 768)
    expect(p.numSoftTokens).toBeGreaterThan(200)
    expect(p.numSoftTokens).toBeLessThanOrEqual(280)
    expect(p.pixelValues[0]).toBeCloseTo(200 / 255, 5)
  })
})

// Equivalence with transformers.js (the processor the spike measured). Needs the downloaded model
// folder: SLIDEWELL_TEST_MODEL_DIR=<userData>/models/embeddinggemma-2-onnx-fp16 npx vitest run
const modelDir = process.env.SLIDEWELL_TEST_MODEL_DIR
describe.skipIf(!modelDir || !existsSync(join(modelDir, 'tokenizer.json')))('matches transformers.js Gemma4Processor', () => {
  it('pixels, position ids, soft-token count and token ids are identical', async () => {
    const tf = await import('@huggingface/transformers')
    tf.env.localModelPath = dirname(modelDir!)
    tf.env.allowRemoteModels = false
    const P = await tf.Gemma4Processor.from_pretrained(basename(modelDir!))
    const shapes: Array<[number, number, number]> = [[1333, 750, 3], [640, 480, 4], [300, 1200, 3], [97, 61, 1]]
    for (const [w, h, ch] of shapes) {
      const raw = Buffer.alloc(w * h * ch)
      for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24
      const png = await sharp(raw, { raw: { width: w, height: h, channels: ch as 1 | 3 | 4 } }).png().toBuffer()
      const mine = await prepareImage(png, cfg)
      const ref = await P.image_processor([await tf.RawImage.fromBlob(new Blob([new Uint8Array(png)]))])
      expect(mine.numSoftTokens).toBe(ref.num_soft_tokens_per_image[0])
      expect(Array.from(mine.dims)).toEqual(ref.pixel_values.dims)
      const a = mine.pixelValues
      const b = ref.pixel_values.data as Float32Array
      let maxDiff = 0
      for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]))
      expect(maxDiff).toBeLessThan(1e-6)
      expect(Buffer.from(mine.positions.buffer).equals(Buffer.from((ref.image_position_ids.data as BigInt64Array).buffer))).toBe(true)
    }
    const text = new GemmaText(readFileSync(join(modelDir!, 'tokenizer.json'), 'utf8'), readFileSync(join(modelDir!, 'tokenizer_config.json'), 'utf8'))
    const q = 'task: search result | query: robots in a classroom'
    expect(Array.from(text.ids(q))).toEqual(Array.from(P.tokenizer(q).input_ids.data as BigInt64Array, Number))
    const inner = P.boi_token + P.image_token.repeat(12) + P.eoi_token
    expect(Array.from(text.imageIds(12))).toEqual(Array.from(P.tokenizer(inner).input_ids.data as BigInt64Array, Number))
  }, 120000)
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadModel, modelState, deleteModel, type FetchLike } from '../src/main/picture-search/model-store'
import { MODEL_FILES, MODEL_TOTAL_BYTES, modelFileUrl } from '../src/main/picture-search/model-manifest'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const A = bytes('tokenizer bytes')
const B = bytes('onnx weights '.repeat(50))
const files = [
  { path: 'tokenizer.json', size: A.length, sha256: sha(A) },
  { path: 'onnx/model.onnx_data', size: B.length, sha256: sha(B) }
]
const served: Record<string, Uint8Array> = { 'tokenizer.json': A, 'onnx/model.onnx_data': B }

/** Serves `served` in 7-byte chunks; honours Range; records every request. */
function fakeFetch(log: string[], override: Record<string, Uint8Array> = {}): FetchLike {
  return async (url, init) => {
    log.push(`${url} ${init.headers?.Range ?? ''}`.trim())
    const body0 = override[url] ?? served[url]
    if (!body0) return { ok: false, status: 404, body: null }
    const m = init.headers?.Range?.match(/^bytes=(\d+)-$/)
    const body = m ? body0.slice(Number(m[1])) : body0
    let off = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= body.length) return c.close()
        c.enqueue(body.slice(off, off + 7))
        off += 7
      }
    })
    return { ok: true, status: m ? 206 : 200, body: stream }
  }
}

let dir: string
beforeEach(() => (dir = join(mkdtempSync(join(tmpdir(), 'sw-model-')), 'm')))
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

describe('model download (verify, resume, delete)', () => {
  it('downloads, verifies every file and becomes ready; progress reaches the total', async () => {
    const log: string[] = []
    const seen: number[] = []
    expect(modelState(dir, files)).toBe('absent')
    await downloadModel(dir, fakeFetch(log), { files, urlFor: (p) => p, onProgress: (p) => seen.push(p.receivedBytes) })
    expect(modelState(dir, files)).toBe('ready')
    expect(seen.at(-1)).toBe(A.length + B.length)
    expect(log).toEqual(['tokenizer.json', 'onnx/model.onnx_data'])
    // already complete: verifies again but fetches nothing
    await downloadModel(dir, fakeFetch(log), { files, urlFor: (p) => p })
    expect(log).toHaveLength(2)
    deleteModel(dir)
    expect(modelState(dir, files)).toBe('absent')
  })

  it('resumes a partial file with a Range request', async () => {
    mkdirSync(join(dir, 'onnx'), { recursive: true })
    writeFileSync(join(dir, 'onnx/model.onnx_data.part'), B.slice(0, 100))
    expect(modelState(dir, files)).toBe('partial')
    const log: string[] = []
    await downloadModel(dir, fakeFetch(log), { files, urlFor: (p) => p })
    expect(log).toContain('onnx/model.onnx_data bytes=100-')
    expect(modelState(dir, files)).toBe('ready')
  })

  it('deletes a file whose bytes do not match the pinned hash and never marks the model ready', async () => {
    const tampered = new Uint8Array(B)
    tampered[3] ^= 1
    await expect(downloadModel(dir, fakeFetch([], { 'onnx/model.onnx_data': tampered }), { files, urlFor: (p) => p })).rejects.toThrow(/failed verification/)
    expect(existsSync(join(dir, 'onnx/model.onnx_data'))).toBe(false)
    expect(modelState(dir, files)).not.toBe('ready')
  })

  it('pins one Hugging Face revision for the fp16 text + vision files only', () => {
    expect(MODEL_FILES.some((f) => f.path.includes('audio'))).toBe(false)
    expect(MODEL_FILES.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    expect(MODEL_TOTAL_BYTES).toBeGreaterThan(880e6)
    expect(modelFileUrl('onnx/model_fp16.onnx')).toMatch(/^https:\/\/huggingface\.co\/onnx-community\/embeddinggemma-2-ONNX\/resolve\/[0-9a-f]{40}\/onnx\/model_fp16\.onnx$/)
  })
})

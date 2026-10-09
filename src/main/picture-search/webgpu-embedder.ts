/**
 * The real Embedder: EmbeddingGemma 2 on the Mac GPU, via ONNX Runtime Web (WebGPU) in a hidden
 * window. Input preparation (sharp + tokenizer) runs here in main; the window only runs the two
 * ONNX sessions. Calls are serialised, so a search query waits for at most one image in flight.
 * The window holds ~3 GB while both sessions are loaded: the vision session is dropped when indexing
 * goes idle, and the whole window closes after `idleCloseMs` without calls.
 *
 * The window sits behind `HostFactory` (electron-embed-host.ts in the app, a fake in tests). If the
 * window dies at any point — before it is ready or mid-call — every waiting call is rejected.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UnreadableImageError, type Embedder } from './engine'
import { GemmaText, prepareImage, type ImageProcessorConfig } from './gemma-prep'
import { MODEL_DIM, QUERY_PREFIX } from './model-manifest'

export type Reply = { ok: boolean; value?: unknown; error?: string }
/** Events from the window. `r` and `id` come from the page and are validated by the embedder. */
export type HostEvents = {
  onReady: (r: unknown) => void
  onReply: (id: unknown, r: unknown) => void
  onGone: (reason: string) => void
}
export interface EmbedHost {
  send(id: number, name: string, payload: unknown): void
  destroy(): void
}
export type HostFactory = (ev: HostEvents) => EmbedHost

type Pending = { valid: (v: unknown) => boolean; settle: (r: { ok: true; value: unknown } | { ok: false; error: string }) => void }

/**
 * Per-call time limits. Loading reads ~900 MB and builds GPU sessions, so it gets 120 s; starting
 * the page, an embed or any other call gets 30 s (an image takes ~0.3 s). A call over its limit
 * resets the window, which rejects everything waiting on it.
 */
export const DEFAULT_TIMEOUTS = { startMs: 30_000, loadMs: 120_000, callMs: 30_000 }

const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null
const isInfo = (v: unknown): boolean => isObject(v) && typeof (v as { webgpu?: unknown }).webgpu === 'boolean'

/** Validate a reply from the page: `{ ok: true, value }` with a valid value, or `{ ok: false, error: string }`. */
export function checkReply(r: unknown, valid: (v: unknown) => boolean): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!isObject(r) || typeof (r as Reply).ok !== 'boolean') return { ok: false, error: 'malformed reply from the picture search window' }
  const m = r as Reply
  if (!m.ok) return { ok: false, error: typeof m.error === 'string' && m.error ? m.error.slice(0, 500) : 'picture search window reported an error' }
  return valid(m.value) ? { ok: true, value: m.value } : { ok: false, error: 'unexpected reply from the picture search window' }
}

export type ImageInput = { pv: Float32Array; dims: number[]; pos: BigInt64Array; posDims: number[]; ids: Int32Array }
/** Turns a query / an image file into model inputs (tokenizer + image processor by default). */
export type EmbedInputs = { queryIds: (text: string) => Int32Array; image: (path: string) => Promise<ImageInput> }

/** The default inputs, read from the verified model folder on first use. */
export function gemmaInputs(modelDir: string): EmbedInputs {
  let tok: GemmaText | null = null
  let cfg: ImageProcessorConfig | null = null
  const tokenizer = (): GemmaText => (tok ??= new GemmaText(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8'), readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')))
  const config = (): ImageProcessorConfig => {
    if (!cfg) {
      const c = JSON.parse(readFileSync(join(modelDir, 'processor_config.json'), 'utf8')).image_processor
      cfg = { patch_size: c.patch_size, max_soft_tokens: c.max_soft_tokens, pooling_kernel_size: c.pooling_kernel_size, rescale_factor: c.rescale_factor }
    }
    return cfg
  }
  return {
    queryIds: (text) => tokenizer().ids(QUERY_PREFIX + text),
    image: async (path) => {
      const p = await prepareImage(path, config())
      return { pv: p.pixelValues, dims: p.dims, pos: p.positions, posDims: p.posDims, ids: tokenizer().imageIds(p.numSoftTokens) }
    }
  }
}

export class WebGpuEmbedder implements Embedder {
  private host: EmbedHost | null = null
  private token: object | null = null
  private ready: Promise<void> | null = null
  private rejectReady: ((e: Error) => void) | null = null
  private visionLoaded = false
  private nextId = 0
  private pending = new Map<number, Pending>()
  private chain: Promise<unknown> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private inputs: EmbedInputs
  private idleCloseMs: number
  private dim: number
  private timeouts: { startMs: number; loadMs: number; callMs: number }

  constructor(
    modelDir: string,
    private makeHost: HostFactory,
    opts: { idleCloseMs?: number; inputs?: EmbedInputs; dim?: number; timeouts?: Partial<{ startMs: number; loadMs: number; callMs: number }> } = {}
  ) {
    this.idleCloseMs = opts.idleCloseMs ?? 5 * 60 * 1000
    this.inputs = opts.inputs ?? gemmaInputs(modelDir)
    this.dim = opts.dim ?? MODEL_DIM
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts }
  }

  private openWindow(): Promise<void> {
    if (this.ready) return this.ready
    const token = {}
    this.token = token
    const mine = (): boolean => this.token === token
    const opened = new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(() => {
        if (mine()) this.reset(new Error(`picture search window did not start within ${this.timeouts.startMs / 1000} s`))
      }, this.timeouts.startMs)
      this.rejectReady = (e) => {
        clearTimeout(startTimer)
        reject(e)
      }
      this.host = this.makeHost({
        // Messages from the page are untrusted input: validated here, and nothing thrown back.
        onReady: (r) => {
          if (!mine()) return
          clearTimeout(startTimer)
          const v = checkReply(r, (x) => x === undefined || x === null || typeof x === 'object')
          if (v.ok) resolve()
          else this.reset(new Error(`picture search window failed to start: ${v.error}`))
        },
        onReply: (id, r) => {
          if (!mine() || typeof id !== 'number') return
          const p = this.pending.get(id)
          if (!p) return // unknown id: dropped
          this.pending.delete(id)
          p.settle(checkReply(r, p.valid))
        },
        onGone: (reason) => {
          if (mine()) this.reset(new Error(`picture search window ${String(reason)}`))
        }
      })
    })
    const ready = opened.then(async () => {
      const info = (await this.send('info', {}, isInfo, this.timeouts.callMs)) as { webgpu: boolean }
      if (!info.webgpu) throw new Error('this Mac does not offer WebGPU to SlideWell')
    })
    this.ready = ready
    ready.catch(() => {
      if (this.ready === ready) this.close()
    })
    return ready
  }

  /** The window is gone or unusable: fail readiness and every call in flight, destroy the window. */
  private reset(err: Error): void {
    this.rejectReady?.(err)
    this.rejectReady = null
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const p of waiting) p.settle({ ok: false, error: err.message })
    const h = this.host
    this.host = null
    this.token = null
    this.ready = null
    this.visionLoaded = false
    try {
      h?.destroy() // the host destroys its window once; later calls are no-ops
    } catch {
      /* already gone */
    }
  }

  /** One command to the page; rejects on an error reply, a malformed reply, or after `timeoutMs`. */
  private send(name: string, payload: unknown, valid: (v: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.host) return reject(new Error('picture search window is not open'))
      const id = ++this.nextId
      const timer = setTimeout(() => {
        if (this.pending.has(id)) this.reset(new Error(`picture search window did not answer "${name}" within ${timeoutMs / 1000} s`))
      }, timeoutMs)
      this.pending.set(id, {
        valid,
        settle: (r) => {
          clearTimeout(timer)
          if (r.ok) resolve(r.value)
          else reject(new Error(r.error))
        }
      })
      this.host.send(id, name, payload)
    })
  }

  private isEmbedding = (v: unknown): boolean => v instanceof Float32Array && v.length === this.dim

  /** Run one task after the previous one; restart the idle-close timer. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => undefined)
    run.finally(() => this.armIdle()).catch(() => undefined)
    return run
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), this.idleCloseMs)
  }

  private async ensure(withVision: boolean): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    await this.openWindow()
    if (withVision && !this.visionLoaded) {
      await this.send('load', { withVision: true }, isObject, this.timeouts.loadMs)
      this.visionLoaded = true
    } else if (!withVision) {
      await this.send('load', { withVision: false }, isObject, this.timeouts.loadMs)
    }
  }

  embedText(text: string): Promise<Float32Array> {
    return this.serial(async () => {
      await this.ensure(false)
      return (await this.send('text', { ids: this.inputs.queryIds(text) }, this.isEmbedding, this.timeouts.callMs)) as Float32Array
    })
  }

  embedImage(path: string): Promise<Float32Array> {
    return this.serial(async () => {
      let input: ImageInput
      try {
        input = await this.inputs.image(path)
      } catch (e) {
        throw new UnreadableImageError(`cannot read image: ${(e as Error)?.message ?? e}`)
      }
      await this.ensure(true)
      const v = (await this.send('image', input, this.isEmbedding, this.timeouts.callMs)) as Float32Array
      if (v.some((x) => Number.isNaN(x))) throw new UnreadableImageError('model returned NaN for this image')
      return v
    })
  }

  /** Free the vision session (indexing idle); text stays for queries until the idle timer closes all. */
  releaseVision(): Promise<void> {
    return this.serial(async () => {
      if (this.host && this.visionLoaded) await this.send('unloadVision', {}, () => true, this.timeouts.callMs)
      this.visionLoaded = false
    })
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.reset(new Error('picture search window closed'))
  }

  dispose(): void {
    this.close()
  }
}

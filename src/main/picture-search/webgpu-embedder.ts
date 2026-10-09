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
import { QUERY_PREFIX } from './model-manifest'

export type Reply = { ok: boolean; value?: unknown; error?: string }
export type HostEvents = {
  onReady: (r: Reply) => void
  onReply: (id: number, r: Reply) => void
  onGone: (reason: string) => void
}
export interface EmbedHost {
  send(id: number, name: string, payload: unknown): void
  destroy(): void
}
export type HostFactory = (ev: HostEvents) => EmbedHost

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
  private pending = new Map<number, (r: Reply) => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private inputs: EmbedInputs
  private idleCloseMs: number

  constructor(
    modelDir: string,
    private makeHost: HostFactory,
    opts: { idleCloseMs?: number; inputs?: EmbedInputs } = {}
  ) {
    this.idleCloseMs = opts.idleCloseMs ?? 5 * 60 * 1000
    this.inputs = opts.inputs ?? gemmaInputs(modelDir)
  }

  private openWindow(): Promise<void> {
    if (this.ready) return this.ready
    const token = {}
    this.token = token
    const mine = (): boolean => this.token === token
    const opened = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject
      this.host = this.makeHost({
        onReady: (r) => {
          if (!mine()) return
          if (r.ok) resolve()
          else reject(new Error(r.error ?? 'picture search window failed to start'))
        },
        onReply: (id, r) => {
          if (!mine()) return
          const cb = this.pending.get(id)
          if (cb) {
            this.pending.delete(id)
            cb(r)
          }
        },
        onGone: (reason) => {
          if (mine()) this.reset(new Error(`picture search window ${reason}`))
        }
      })
    })
    const ready = opened.then(async () => {
      const info = (await this.send('info', {})) as { webgpu: boolean }
      if (!info.webgpu) throw new Error('this Mac does not offer WebGPU to SlideWell')
    })
    this.ready = ready
    ready.catch(() => {
      if (this.ready === ready) this.close()
    })
    return ready
  }

  /** The window is gone: fail readiness and every call in flight, forget the window. */
  private reset(err: Error): void {
    this.rejectReady?.(err)
    this.rejectReady = null
    for (const cb of this.pending.values()) cb({ ok: false, error: err.message })
    this.pending.clear()
    this.host = null
    this.token = null
    this.ready = null
    this.visionLoaded = false
  }

  private send(name: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.host) return reject(new Error('picture search window is not open'))
      const id = ++this.nextId
      this.pending.set(id, (r) => (r.ok ? resolve(r.value) : reject(new Error(r.error ?? 'embedder error'))))
      this.host.send(id, name, payload)
    })
  }

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
      await this.send('load', { withVision: true })
      this.visionLoaded = true
    } else if (!withVision) {
      await this.send('load', { withVision: false })
    }
  }

  embedText(text: string): Promise<Float32Array> {
    return this.serial(async () => {
      await this.ensure(false)
      return (await this.send('text', { ids: this.inputs.queryIds(text) })) as Float32Array
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
      const v = (await this.send('image', input)) as Float32Array
      if (v.some((x) => Number.isNaN(x))) throw new UnreadableImageError('model returned NaN for this image')
      return v
    })
  }

  /** Free the vision session (indexing idle); text stays for queries until the idle timer closes all. */
  releaseVision(): Promise<void> {
    return this.serial(async () => {
      if (this.host && this.visionLoaded) await this.send('unloadVision', {})
      this.visionLoaded = false
    })
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const h = this.host
    this.reset(new Error('picture search window closed'))
    h?.destroy()
  }

  dispose(): void {
    this.close()
  }
}

/**
 * The real Embedder: EmbeddingGemma 2 on the Mac GPU, via ONNX Runtime Web (WebGPU) in a hidden
 * BrowserWindow. Input preparation (sharp + tokenizer) runs here in main; the window only runs the
 * two ONNX sessions. Calls are serialised, so a search query waits for at most one image in flight.
 * The window holds ~3 GB while both sessions are loaded: the vision session is dropped when indexing
 * goes idle, and the whole window closes after `idleCloseMs` without calls.
 */
import { BrowserWindow, ipcMain, protocol } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UnreadableImageError, type Embedder } from './engine'
import { GemmaText, prepareImage, type ImageProcessorConfig } from './gemma-prep'
import { QUERY_PREFIX } from './model-manifest'

export const EMBED_SCHEME = 'swembed'
const PAGE = '<!doctype html><meta charset="utf-8"><title>picture search</title><script src="ort.webgpu.min.js"></script>'
const MIME: Record<string, string> = { js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', html: 'text/html' }

/** Folder of onnxruntime-web's browser build (resolved through the package's exported wasm file). */
function ortDistDir(): string {
  return dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm'))
}

/** Serve the hidden page and ONNX Runtime Web's files. Call once, after app ready. */
export function registerEmbedProtocol(): void {
  const dist = ortDistDir()
  protocol.handle(EMBED_SCHEME, async (request) => {
    const url = new URL(request.url)
    const name = url.pathname.replace(/^\/+/, '')
    if (url.host !== 'ort') return new Response('not found', { status: 404 })
    if (name === 'embedder.html') return new Response(PAGE, { headers: { 'content-type': MIME.html } })
    if (!/^ort[\w.-]*\.(m?js|wasm)$/.test(name)) return new Response('not found', { status: 404 })
    const p = join(dist, name)
    if (!existsSync(p)) return new Response('not found', { status: 404 })
    const ext = name.split('.').pop() ?? ''
    return new Response(readFileSync(p), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  })
}

type Reply = { ok: boolean; value?: unknown; error?: string }

export class WebGpuEmbedder implements Embedder {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private visionLoaded = false
  private nextId = 0
  private pending = new Map<number, (r: Reply) => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | null = null
  private textTok: GemmaText | null = null
  private imageCfg: ImageProcessorConfig | null = null
  private replyHandler = (e: Electron.IpcMainEvent, id: number, r: Reply): void => {
    if (!this.win || e.sender !== this.win.webContents) return
    const cb = this.pending.get(id)
    if (cb) {
      this.pending.delete(id)
      cb(r)
    }
  }

  constructor(
    private modelDir: string,
    private preloadPath: string,
    private idleCloseMs = 5 * 60 * 1000
  ) {
    ipcMain.on('embedder:reply', this.replyHandler)
  }

  private tokenizer(): GemmaText {
    if (!this.textTok) this.textTok = new GemmaText(readFileSync(join(this.modelDir, 'tokenizer.json'), 'utf8'), readFileSync(join(this.modelDir, 'tokenizer_config.json'), 'utf8'))
    return this.textTok
  }

  private imageConfig(): ImageProcessorConfig {
    if (!this.imageCfg) {
      const c = JSON.parse(readFileSync(join(this.modelDir, 'processor_config.json'), 'utf8')).image_processor
      this.imageCfg = { patch_size: c.patch_size, max_soft_tokens: c.max_soft_tokens, pooling_kernel_size: c.pooling_kernel_size, rescale_factor: c.rescale_factor }
    }
    return this.imageCfg
  }

  private openWindow(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const win = new BrowserWindow({
        show: false,
        width: 200,
        height: 200,
        webPreferences: { preload: this.preloadPath, sandbox: false, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false }
      })
      this.win = win
      const onReady = (e: Electron.IpcMainEvent, r: Reply): void => {
        if (e.sender !== win.webContents) return
        ipcMain.removeListener('embedder:ready', onReady)
        if (r.ok) resolve()
        else reject(new Error(r.error ?? 'picture search window failed to start'))
      }
      ipcMain.on('embedder:ready', onReady)
      win.on('closed', () => {
        ipcMain.removeListener('embedder:ready', onReady)
        if (this.win === win) this.reset(new Error('picture search window closed'))
      })
      win.webContents.on('render-process-gone', (_e, d) => this.reset(new Error(`picture search window stopped (${d.reason})`)))
      win.loadURL(`${EMBED_SCHEME}://ort/embedder.html`).catch(reject)
    }).then(async () => {
      const info = (await this.send('info', {})) as { webgpu: boolean }
      if (!info.webgpu) throw new Error('this Mac does not offer WebGPU to SlideWell')
    })
    this.ready.catch(() => this.close())
    return this.ready
  }

  private reset(err: Error): void {
    for (const cb of this.pending.values()) cb({ ok: false, error: err.message })
    this.pending.clear()
    this.win = null
    this.ready = null
    this.visionLoaded = false
  }

  private send(name: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.win) return reject(new Error('picture search window is not open'))
      const id = ++this.nextId
      this.pending.set(id, (r) => (r.ok ? resolve(r.value) : reject(new Error(r.error ?? 'embedder error'))))
      this.win.webContents.send('embedder:cmd', id, name, payload)
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
      await this.send('load', { dir: this.modelDir, withVision: true })
      this.visionLoaded = true
    } else if (!withVision) {
      await this.send('load', { dir: this.modelDir, withVision: false })
    }
  }

  embedText(text: string): Promise<Float32Array> {
    return this.serial(async () => {
      await this.ensure(false)
      return (await this.send('text', { ids: this.tokenizer().ids(QUERY_PREFIX + text) })) as Float32Array
    })
  }

  embedImage(path: string): Promise<Float32Array> {
    return this.serial(async () => {
      let p: Awaited<ReturnType<typeof prepareImage>>
      try {
        p = await prepareImage(path, this.imageConfig())
      } catch (e) {
        throw new UnreadableImageError(`cannot read image: ${(e as Error)?.message ?? e}`)
      }
      await this.ensure(true)
      const v = (await this.send('image', { pv: p.pixelValues, dims: p.dims, pos: p.positions, posDims: p.posDims, ids: this.tokenizer().imageIds(p.numSoftTokens) })) as Float32Array
      if (v.some((x) => Number.isNaN(x))) throw new UnreadableImageError('model returned NaN for this image')
      return v
    })
  }

  /** Free the vision session (indexing idle); text stays for queries until the idle timer closes all. */
  releaseVision(): Promise<void> {
    return this.serial(async () => {
      if (this.win && this.visionLoaded) await this.send('unloadVision', {})
      this.visionLoaded = false
    })
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const w = this.win
    this.reset(new Error('picture search window closed'))
    if (w && !w.isDestroyed()) w.destroy()
  }

  dispose(): void {
    this.close()
    ipcMain.removeListener('embedder:reply', this.replyHandler)
  }
}

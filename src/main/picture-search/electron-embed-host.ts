/**
 * The Electron half of the embedder: the hidden window and the swembed:// protocol that serves its
 * page, ONNX Runtime Web's files and the verified model files. The window is sandboxed and
 * context-isolated, cannot navigate or open windows, and only its own webContents is heard on the
 * embedder IPC channels.
 */
import { BrowserWindow, ipcMain, net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import PAGE_JS from './embedder-page.js?raw'
import { MODEL_FILES } from './model-manifest'
import type { EmbedHost, HostEvents, HostFactory, Reply } from './webgpu-embedder'

export const EMBED_SCHEME = 'swembed'
const ORIGIN = `${EMBED_SCHEME}://ort/`
const PAGE = '<!doctype html><meta charset="utf-8"><title>picture search</title><script src="ort.webgpu.min.js"></script><script src="embedder-page.js"></script>'
const CSP = "default-src 'none'; script-src swembed: 'wasm-unsafe-eval'; connect-src swembed:"
const MIME: Record<string, string> = { js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', html: 'text/html' }
const MODEL_PATHS = new Set(MODEL_FILES.filter((f) => f.path.startsWith('onnx/')).map((f) => f.path))

/** Folder of onnxruntime-web's browser build (resolved through the package's exported wasm file). */
function ortDistDir(): string {
  return dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm'))
}

/** Serve the hidden page, ONNX Runtime Web and the model's ONNX files. Call once, after app ready. */
export function registerEmbedProtocol(modelDir: () => string): void {
  const dist = ortDistDir()
  protocol.handle(EMBED_SCHEME, async (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const headers = (type: string): Record<string, string> => ({ 'content-type': type, 'content-security-policy': CSP })
    if (url.host !== 'ort') return new Response('not found', { status: 404 })
    if (name === 'embedder.html') return new Response(PAGE, { headers: headers(MIME.html) })
    if (name === 'embedder-page.js') return new Response(PAGE_JS, { headers: headers(MIME.js) })
    let file: string | null = null
    if (name.startsWith('model/') && MODEL_PATHS.has(name.slice(6))) file = join(modelDir(), name.slice(6))
    else if (/^ort[\w.-]*\.(m?js|wasm)$/.test(name)) file = join(dist, name)
    if (!file || !existsSync(file)) return new Response('not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const ext = name.split('.').pop() ?? ''
    return new Response(res.body, { headers: headers(MIME[ext] ?? 'application/octet-stream') })
  })
}

/** Hidden-window host for WebGpuEmbedder. */
export function electronEmbedHost(preloadPath: string): HostFactory {
  return (ev: HostEvents): EmbedHost => {
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    const wc = win.webContents
    let gone = false
    const onReady = (e: Electron.IpcMainEvent, r: Reply): void => {
      if (e.sender === wc) ev.onReady(r)
    }
    const onReply = (e: Electron.IpcMainEvent, id: number, r: Reply): void => {
      if (e.sender === wc) ev.onReply(id, r)
    }
    const cleanup = (): void => {
      ipcMain.removeListener('embedder:ready', onReady)
      ipcMain.removeListener('embedder:reply', onReply)
    }
    const fail = (reason: string): void => {
      if (gone) return
      gone = true
      cleanup()
      ev.onGone(reason)
    }
    ipcMain.on('embedder:ready', onReady)
    ipcMain.on('embedder:reply', onReply)
    // never leave swembed://ort/, never open windows
    wc.on('will-navigate', (e, url) => {
      if (!url.startsWith(ORIGIN)) e.preventDefault()
    })
    wc.on('will-redirect', (e, url) => {
      if (!url.startsWith(ORIGIN)) e.preventDefault()
    })
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('render-process-gone', (_e, d) => fail(`stopped (${d.reason})`))
    win.on('closed', () => fail('closed'))
    win.loadURL(`${ORIGIN}embedder.html`).catch((e) => fail(`could not load (${(e as Error)?.message ?? e})`))
    return {
      send: (id, name, payload) => {
        if (!wc.isDestroyed()) wc.send('embedder:cmd', id, name, payload)
      },
      destroy: () => {
        gone = true
        cleanup()
        if (!win.isDestroyed()) win.destroy()
      }
    }
  }
}

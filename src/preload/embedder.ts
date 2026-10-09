/**
 * Preload for the hidden picture-search window. Sandboxed and context-isolated: it holds only
 * ipcRenderer and exposes three message functions to the page. The page
 * (src/main/picture-search/embedder-page.js) owns ONNX Runtime Web and fetches model files over
 * swembed://; it never gets Node or Electron objects.
 */
import { contextBridge, ipcRenderer } from 'electron'

type Reply = { ok: boolean; value?: unknown; error?: string }

contextBridge.exposeInMainWorld('host', {
  onCmd: (cb: (id: number, name: string, payload: unknown) => void): void => {
    ipcRenderer.on('embedder:cmd', (_e, id: number, name: string, payload: unknown) => cb(id, name, payload))
  },
  reply: (id: number, res: Reply): void => ipcRenderer.send('embedder:reply', id, res),
  ready: (res: Reply): void => ipcRenderer.send('embedder:ready', res)
})

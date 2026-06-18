import { app, BrowserWindow, ipcMain, dialog, protocol, shell, net } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { pathToFileURL } from 'url'
import { resolve as resolvePath, sep as pathSep } from 'path'
import { searchSlides, searchImages } from './archive'

// Custom schemes must be registered as privileged BEFORE app ready so the renderer treats them
// as standard secure schemes (CSP img-src matching, no mixed-content blocking). SlideWell mirrors
// TalkWeaver's tw* schemes with sw*: swasset (the well's owned assets), swthumb (generated
// thumbnails), swarchive (read-only files from the Core A extraction store). Handlers below.
protocol.registerSchemesAsPrivileged([
  { scheme: 'swasset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'swthumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'swarchive', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// Simple JSON config — avoids ESM/CJS issues with electron-store (same call TalkWeaver made).
type Config = {
  archiveRoot?: string
  windowBounds?: { width: number; height: number }
}
function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}
function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}
function writeConfig(patch: Partial<Config>): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify({ ...readConfig(), ...patch }, null, 2), 'utf8')
}

// Core A (ppt-archive) is the engine SlideWell sits on. Default to its conventional location;
// the user can repoint it in Settings. The archive is "present" when its registry/ exists.
const ARCHIVE_DEFAULT = join(homedir(), 'gitrepos', '05_ppt-tools', 'ppt-archive')
function archiveRoot(): string {
  return readConfig().archiveRoot ?? ARCHIVE_DEFAULT
}
function archiveAvailable(): boolean {
  const root = archiveRoot()
  return existsSync(join(root, 'registry'))
}

function createWindow(): BrowserWindow {
  const bounds = readConfig().windowBounds ?? { width: 1400, height: 900 }
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.on('close', () => {
    const b = win.getBounds()
    writeConfig({ windowBounds: { width: b.width, height: b.height } })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

// swarchive://f/<base64url of absolute path> → the file, guarded to the archive root so the
// renderer can never read outside it. Read-only; the archive's originals stay where they are.
// The b64url payload lives in the URL PATH, not the host: URL hosts are lowercased by spec,
// which would corrupt case-sensitive base64url. Host is a constant 'f'.
function decodeB64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}
function encodeB64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function swThumb(abs: string | null): string | null {
  return abs ? `swarchive://f/${encodeB64Url(abs)}` : null
}
function within(root: string, target: string): boolean {
  const r = resolvePath(root) + pathSep
  return resolvePath(target).startsWith(r)
}

app.whenReady().then(() => {
  protocol.handle('swarchive', (request) => {
    try {
      const b64 = new URL(request.url).pathname.replace(/^\/+/, '')
      const abs = decodeB64Url(b64)
      if (!within(archiveRoot(), abs) || !existsSync(abs)) {
        return new Response('not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })

  // --- IPC: the typed contract lives in src/preload/index.ts ---
  ipcMain.handle('archive:available', () => archiveAvailable())
  ipcMain.handle('settings:get-paths', () => ({
    archiveRoot: readConfig().archiveRoot ?? null,
    archiveDefault: ARCHIVE_DEFAULT,
    archiveAvailable: archiveAvailable()
  }))
  ipcMain.handle('settings:choose-archive', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ archiveRoot: r.filePaths[0] })
    return r.filePaths[0]
  })
  ipcMain.handle('shell:open-path', (_e, p: string) => shell.openPath(p).then((err) => err === ''))
  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url).then(() => true))

  // Read-only search over Core A. Returns [] when the archive isn't present (UI degrades gracefully).
  // renderAbsPath/fileAbsPath are converted to renderable swarchive:// URLs here; the renderer never sees raw paths.
  ipcMain.handle('archive:search-slides', async (_e, q: string) => {
    if (!archiveAvailable() || !q?.trim()) return []
    try {
      const hits = await searchSlides(archiveRoot(), q)
      return hits.map(({ renderAbsPath, ...h }) => ({ ...h, thumbUrl: swThumb(renderAbsPath) }))
    } catch {
      return []
    }
  })
  ipcMain.handle('archive:search-images', async (_e, q: string) => {
    if (!archiveAvailable() || !q?.trim()) return []
    try {
      const hits = await searchImages(archiveRoot(), q)
      return hits.map(({ fileAbsPath, ...h }) => ({ ...h, thumbUrl: swThumb(fileAbsPath) }))
    } catch {
      return []
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

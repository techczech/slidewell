import { app, BrowserWindow, ipcMain, dialog, protocol, shell, net, clipboard, nativeImage } from 'electron'
import sharp from 'sharp'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch as fsWatch } from 'fs'
import { pathToFileURL } from 'url'
import { execFile } from 'node:child_process'
import { resolve as resolvePath, sep as pathSep } from 'path'
import { archiveResults, deckSlides, slideStructure, searchImages, type SearchFilters, type EnrichedHit, type ImageHit } from './archive'
import { loadDeckMeta, categoryList, type DeckMetaIndex } from './deckmeta'
import { ensureWell, drainInbox, scanVault, searchWell, wellAbsPath, type WellRow } from './well'
import { runIngest, cancelIngest, detectPython } from './ingest'

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
  wellRoot?: string
  vaultRoot?: string
  pythonPath?: string
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

// The well is SlideWell-owned; default to a dedicated user folder (NOT inside Core A's git repo),
// repointable in config. The swarchive:// guard serves it wherever it lives.
const WELL_DEFAULT = join(homedir(), 'SlideWell', 'well')
function wellRootResolved(): string {
  return readConfig().wellRoot ?? WELL_DEFAULT
}

// TalkWeaver's vault — its images are indexed in place (the vault owns them). Auto-detect from
// TalkWeaver's own config (userData/config.json) when not explicitly set.
function detectVaultRoot(): string | null {
  const cfg = readConfig().vaultRoot
  if (cfg) return cfg
  const support = join(homedir(), 'Library', 'Application Support')
  for (const appdir of ['talk-weaver', 'TalkWeaver']) {
    try {
      const tw = JSON.parse(readFileSync(join(support, appdir, 'config.json'), 'utf8')) as { vaultRoot?: string }
      if (tw.vaultRoot && existsSync(tw.vaultRoot)) return tw.vaultRoot
    } catch {
      /* not found */
    }
  }
  return null
}

// A render/image request is allowed only if it resolves inside one of the roots SlideWell knows.
function allowedRoots(): string[] {
  return [archiveRoot(), wellRootResolved(), detectVaultRoot()].filter((r): r is string => Boolean(r))
}

let mainWindow: BrowserWindow | null = null

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
  mainWindow = win
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
function withinAny(roots: string[], target: string): boolean {
  return roots.some((r) => within(r, target))
}
/** Decode a swarchive://f/<b64> URL back to a guarded absolute path, or null. */
function resolveSwUrl(url: string): string | null {
  try {
    const b64 = new URL(url).pathname.replace(/^\/+/, '')
    const abs = decodeB64Url(b64)
    return withinAny(allowedRoots(), abs) && existsSync(abs) ? abs : null
  } catch {
    return null
  }
}

app.whenReady().then(() => {
  protocol.handle('swarchive', (request) => {
    const abs = resolveSwUrl(request.url)
    if (!abs) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })

  // --- IPC: the typed contract lives in src/preload/index.ts ---
  ipcMain.handle('archive:available', () => archiveAvailable())
  ipcMain.handle('settings:get-paths', () => ({
    archiveRoot: readConfig().archiveRoot ?? null,
    archiveDefault: ARCHIVE_DEFAULT,
    archiveAvailable: archiveAvailable(),
    wellRoot: wellRootResolved(),
    vaultRoot: detectVaultRoot(),
    vaultAvailable: Boolean(detectVaultRoot())
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
  // renderAbsPath is converted to a renderable swarchive:// URL here; the renderer never sees raw paths.
  const cacheDir = (): string => app.getPath('userData')
  const toWire = (h: EnrichedHit): Record<string, unknown> => {
    const { renderAbsPath, ...rest } = h
    return { ...rest, thumbUrl: swThumb(renderAbsPath) }
  }

  // A well image → the same wire shape as an archive hit, so the grid renders it uniformly.
  const wellToWire = (r: WellRow): Record<string, unknown> => {
    const abs = wellAbsPath(wellRootResolved(), detectVaultRoot(), r)
    const sourceLabel = r.source === 'talkweaver' ? 'TalkWeaver' : 'Screenshot'
    return {
      kind: 'well-image',
      title: r.slug ? r.slug.replace(/-/g, ' ') : sourceLabel,
      snippet: (r.ocr_text || r.notes || '').slice(0, 160),
      text: r.ocr_text || '',
      rank: 0,
      deck: r.source,
      deckTitle: sourceLabel,
      filename: `${r.slug}--${r.id}.${r.ext}`,
      category: r.tags || '',
      date: r.added_at || null,
      slideOrder: null,
      usedInDecks: 1,
      reference: `![](img-${r.id})`,
      thumbUrl: swThumb(abs)
    }
  }

  // An extracted-from-a-deck image → the wire shape, as a standalone image card.
  const archiveImageToWire = (im: ImageHit, idx: DeckMetaIndex): Record<string, unknown> => {
    const m = idx[im.deck]
    return {
      kind: 'archive-image',
      title: m?.title || im.deck || '(image)',
      snippet: (im.snippet || '').slice(0, 160),
      text: im.snippet || '',
      rank: 0,
      deck: im.deck,
      deckTitle: m?.title || im.deck,
      filename: `${im.sha256}.${im.format}`,
      category: m?.category || '',
      date: m?.date ?? null,
      slideOrder: null,
      usedInDecks: im.usedInDecks,
      reference: im.reference,
      thumbUrl: swThumb(im.fileAbsPath)
    }
  }

  ipcMain.handle('archive:search', async (_e, query: string, filters: SearchFilters) => {
    const scope = filters?.scope ?? 'all'
    const type = filters?.type ?? 'slides'
    const out: Array<Record<string, unknown>> = []
    if (type === 'slides') {
      // whole slides (the well has no slides, so Well-scope is empty here)
      if (scope !== 'well' && archiveAvailable()) {
        try {
          const clusters = await archiveResults(archiveRoot(), cacheDir(), query ?? '', filters)
          for (const c of clusters) out.push({ representative: toWire(c.representative), members: c.members.map(toWire), size: c.size, deckCount: c.deckCount })
        } catch {
          /* archive search failed */
        }
      }
    } else {
      // images: the pictures embedded in decks (separate from the slides) + the well's images
      if (scope !== 'well' && archiveAvailable()) {
        try {
          const idx = loadDeckMeta(archiveRoot(), cacheDir())
          const deckNeedle = (filters.deck || '').toLowerCase()
          for (const im of await searchImages(archiveRoot(), query ?? '', 120)) {
            if (deckNeedle) {
              const m = idx[im.deck]
              if (!`${im.deck} ${m?.title || ''} ${m?.filename || ''}`.toLowerCase().includes(deckNeedle)) continue
            }
            const w = archiveImageToWire(im, idx)
            out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
          }
        } catch {
          /* archive images failed → still show well */
        }
      }
      if (scope !== 'archive') {
        try {
          for (const r of await searchWell(wellRootResolved(), query ?? '', 60)) {
            const w = wellToWire(r)
            out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
          }
        } catch {
          /* no well yet */
        }
      }
    }
    return out
  })

  // Distinct deck categories (with counts) for the Category filter dropdown.
  ipcMain.handle('archive:categories', () => {
    if (!archiveAvailable()) return []
    try {
      return categoryList(loadDeckMeta(archiveRoot(), cacheDir()))
    } catch {
      return []
    }
  })

  // All decks (id, title, date) newest-first, for the Deck filter picker.
  ipcMain.handle('archive:decks', () => {
    if (!archiveAvailable()) return []
    try {
      const idx = loadDeckMeta(archiveRoot(), cacheDir())
      return Object.entries(idx)
        .map(([id, m]) => ({ id, title: m.title || id, date: m.date }))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    } catch {
      return []
    }
  })

  // The structured content (presentation.json node) of one slide — for "Copy structure".
  ipcMain.handle('archive:slide-structure', (_e, deck: string, slideOrder: number | null) => {
    if (!archiveAvailable()) return null
    try {
      return slideStructure(archiveRoot(), deck, slideOrder)
    } catch {
      return null
    }
  })

  // All slides of one presentation, in order — for "See in context".
  ipcMain.handle('archive:deck-slides', async (_e, deck: string) => {
    if (!archiveAvailable()) return []
    try {
      return (await deckSlides(archiveRoot(), cacheDir(), deck)).map(toWire)
    } catch {
      return []
    }
  })

  // Copy an image FILE (WebP) to the clipboard — TalkWeaver's paste reads an image/webp file item
  // and keeps it as-is (no PNG round-trip). Resolves the file from its thumbnail URL, so the same
  // path works for archive renders, well images, and vault images. macOS file pasteboard via osascript.
  const copyFileToClipboard = (abs: string): Promise<boolean> =>
    new Promise((resolve) =>
      execFile('osascript', ['-e', `set the clipboard to POSIX file ${JSON.stringify(abs)}`], (err) => resolve(!err))
    )
  ipcMain.handle('clipboard:copy-image', async (_e, thumbUrl: string) => {
    const abs = resolveSwUrl(thumbUrl)
    return abs ? copyFileToClipboard(abs) : false
  })
  // Copy as a PNG raster bitmap (for Keynote / Slack / web that want a pasted image, not a file).
  ipcMain.handle('clipboard:copy-image-png', async (_e, thumbUrl: string) => {
    const abs = resolveSwUrl(thumbUrl)
    if (!abs) return false
    try {
      const img = abs.toLowerCase().endsWith('.webp')
        ? nativeImage.createFromBuffer(await sharp(abs).png().toBuffer())
        : nativeImage.createFromPath(abs)
      if (img.isEmpty()) return false
      clipboard.writeImage(img)
      return true
    } catch {
      return false
    }
  })

  // Reveal an image in Finder ("open containing deck/folder").
  ipcMain.handle('shell:reveal', (_e, thumbUrl: string) => {
    const abs = resolveSwUrl(thumbUrl)
    if (!abs) return false
    shell.showItemInFolder(abs)
    return true
  })

  // --- well / import paths ---
  ipcMain.handle('settings:choose-vault', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ vaultRoot: r.filePaths[0] })
    return r.filePaths[0]
  })
  // Re-scan the TalkWeaver vault for new images and index them; returns count added.
  ipcMain.handle('well:scan-vault', async () => {
    const vr = detectVaultRoot()
    if (!vr) return 0
    try {
      return await scanVault(archiveRoot(), wellRootResolved(), vr)
    } catch {
      return 0
    }
  })

  // --- archive ingest (Core A pipeline as streamed subprocesses) ---
  const sendLine = (s: string): void => mainWindow?.webContents.send('ingest:line', s)
  const python = (): string => detectPython(readConfig().pythonPath)
  ipcMain.handle('ingest:pending', async () => {
    if (!archiveAvailable()) return { ok: false }
    return runIngest({ archiveRoot: archiveRoot(), python: python(), mode: 'pending' }, sendLine)
  })
  ipcMain.handle('ingest:import-path', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true }
    return runIngest({ archiveRoot: archiveRoot(), python: python(), mode: 'path', targetPath: r.filePaths[0] }, sendLine)
  })
  ipcMain.handle('ingest:cancel', () => {
    cancelIngest()
    return true
  })

  void startWell()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// On launch: ensure the well exists, drain anything Raycast dropped while we were closed, index
// new TalkWeaver vault images, and watch the inbox so future drops ingest live.
async function startWell(): Promise<void> {
  try {
    const root = wellRootResolved()
    await ensureWell(root)
    await drainInbox(archiveRoot(), root)
    const vr = detectVaultRoot()
    if (vr) void scanVault(archiveRoot(), root, vr)
    const inbox = join(root, '_inbox')
    let busy = false
    fsWatch(inbox, async () => {
      if (busy) return
      busy = true
      setTimeout(async () => {
        try {
          await drainInbox(archiveRoot(), root)
        } finally {
          busy = false
        }
      }, 400)
    })
  } catch {
    /* well unavailable (e.g. archive root missing) — search just shows no well results */
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

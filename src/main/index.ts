import { app, BrowserWindow, ipcMain, dialog, protocol, shell, net, clipboard, nativeImage } from 'electron'
import sharp from 'sharp'
import { join, basename } from 'path'
import { homedir, tmpdir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, watch as fsWatch } from 'fs'
import { pathToFileURL } from 'url'
import { execFile } from 'node:child_process'
import { resolve as resolvePath, sep as pathSep } from 'path'
import { archiveResults, deckSlides, slideStructure, slideImages, searchImages, listDecks, deckDetail, archiveStats, type SearchFilters, type EnrichedHit, type ImageHit } from './archive'
import { loadDeckMeta, categoryList, type DeckMetaIndex } from './deckmeta'
import { ensureWell, drainInbox, scanVault, searchWell, wellAbsPath, ingestScreenshot, findFfmpeg, type WellRow } from './well'
import { scanTriageSource, listTriage, triageCounts, setTriageDecision, VIDEO_GATE_BYTES, type TriageRow } from './triage'
import { runIngest, cancelIngest, detectPython, findRenderTools } from './ingest'
import { convertPptxToOutline } from './convert'
import { slugify } from './outline'

const REQUIREMENTS_URL = 'https://github.com/techczech/slidewell/blob/main/REQUIREMENTS.md'

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
  screenshotRoot?: string
  conversionsRoot?: string // default destination for throwaway PPTX→Outline conversions
  convertOcrByDefault?: boolean // initial state of the convert OCR toggle
  othersArchiveRoot?: string // the Others' Library store (Scenario A) — other people's decks, kept separate
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

// The Others' Library (Scenario A, ADR-0031): a SEPARATE Core A archive store for other people's
// decks — built by the same engine (ppt-archive's tools/), never merged into the personal archive.
// Default to a dedicated user folder; configurable in Settings; created on first import.
const OTHERS_DEFAULT = join(homedir(), 'SlideWell', 'others-library')
function othersArchiveRootResolved(): string {
  return readConfig().othersArchiveRoot ?? OTHERS_DEFAULT
}
function othersArchiveAvailable(): boolean {
  return existsSync(join(othersArchiveRootResolved(), 'registry'))
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

// The Triage source — a folder SlideWell reads but never owns (e.g. a OneDrive screenshots folder,
// ADR-0029). Null until the user picks one in the Triage screen / Settings.
function screenshotRootResolved(): string | null {
  const r = readConfig().screenshotRoot
  return r && existsSync(r) ? r : null
}

// The default destination for throwaway conversions (Settings-chosen). Pre-fills the save dialog;
// any single conversion can still redirect elsewhere. Returned even if missing — the convert
// handler falls back to home when it no longer exists.
function conversionsRootResolved(): string | null {
  return readConfig().conversionsRoot ?? null
}

// A render/image request is allowed only if it resolves inside one of the roots SlideWell knows.
// The Triage source is included so source screenshots/video posters render via swarchive://.
function allowedRoots(): string[] {
  return [archiveRoot(), othersArchiveRootResolved(), wellRootResolved(), detectVaultRoot(), screenshotRootResolved()].filter((r): r is string => Boolean(r))
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
    vaultAvailable: Boolean(detectVaultRoot()),
    screenshotRoot: screenshotRootResolved(),
    screenshotAvailable: Boolean(screenshotRootResolved()),
    conversionsRoot: conversionsRootResolved(),
    convertOcrDefault: Boolean(readConfig().convertOcrByDefault),
    othersArchiveRoot: othersArchiveRootResolved(),
    othersArchiveAvailable: othersArchiveAvailable()
  }))
  ipcMain.handle('settings:choose-archive', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const picked = r.filePaths[0]
    // Guard: a folder with no registry/ isn't a built Core A archive. Picking one silently breaks
    // search + import, so warn and keep the current setting unless the user insists.
    if (!existsSync(join(picked, 'registry'))) {
      const res = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Cancel', 'Use anyway'],
        defaultId: 0,
        cancelId: 0,
        message: `“${basename(picked)}” doesn’t look like a built archive — no “registry” folder inside.`,
        detail: 'Point this at your ppt-archive engine (the folder that contains registry/, extracted/, media-store/). Search and import need it.'
      })
      if (res.response !== 1) return readConfig().archiveRoot ?? null
    }
    writeConfig({ archiveRoot: picked })
    return picked
  })
  ipcMain.handle('shell:open-path', (_e, p: string) => shell.openPath(p).then((err) => err === ''))
  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url).then(() => true))

  // Detected status of the external tools SlideWell leans on — surfaced in Settings so users know
  // what to install. `required` deps gate core features; the rest degrade gracefully when absent.
  ipcMain.handle('settings:dependencies', () => {
    const py = detectPython(readConfig().pythonPath)
    const ocrBin = join(archiveRoot(), 'tools', 'ocr', 'vision_ocr')
    const ocrSwift = join(archiveRoot(), 'tools', 'ocr', 'vision_ocr.swift')
    const ff = findFfmpeg()
    const render = findRenderTools()
    return {
      requirementsUrl: REQUIREMENTS_URL,
      deps: [
        { key: 'archive', label: 'PowerPoint archive engine (Core A · ppt-archive)', found: archiveAvailable(), detail: archiveRoot(), requiredFor: 'Slide/Deck search & PPTX import', install: 'Clone techczech/ppt-archive and point Settings at it', required: true },
        { key: 'python', label: 'Python 3 (+ python-pptx, Pillow, lxml)', found: py === 'python3' || existsSync(py), detail: py, requiredFor: 'PPTX import (extraction)', install: 'pip install python-pptx Pillow lxml pdf2image', required: false },
        { key: 'ocr', label: 'macOS Vision OCR helper (vision_ocr)', found: existsSync(ocrBin) || existsSync(ocrSwift), detail: existsSync(ocrBin) ? ocrBin : ocrSwift, requiredFor: 'Text search inside images & screenshots', install: 'Ships with ppt-archive (tools/ocr)', required: false },
        { key: 'ffmpeg', label: 'ffmpeg', found: ff !== 'ffmpeg', detail: ff !== 'ffmpeg' ? ff : 'not found on PATH', requiredFor: 'Video poster frames & triage playback', install: 'brew install ffmpeg', required: false },
        { key: 'libreoffice', label: 'LibreOffice (soffice)', found: Boolean(render.soffice), detail: render.soffice || 'not found', requiredFor: 'Slide render thumbnails', install: 'brew install --cask libreoffice', required: false },
        { key: 'poppler', label: 'Poppler (pdftoppm)', found: Boolean(render.pdftoppm), detail: render.pdftoppm || 'not found', requiredFor: 'Slide render thumbnails', install: 'brew install poppler', required: false }
      ]
    }
  })

  // Read-only search over Core A. Returns [] when the archive isn't present (UI degrades gracefully).
  // renderAbsPath is converted to a renderable swarchive:// URL here; the renderer never sees raw paths.
  const cacheDir = (): string => app.getPath('userData')
  // Which archive store holds this deck's extraction — mine first, else the Others' Library. Lets
  // inspect/context actions resolve a result to the right store without threading library everywhere.
  const rootForDeck = (deck: string): string => {
    if (deck && existsSync(join(archiveRoot(), 'extracted', deck))) return archiveRoot()
    if (deck && existsSync(join(othersArchiveRootResolved(), 'extracted', deck))) return othersArchiveRootResolved()
    return archiveRoot()
  }
  const toWire = (h: EnrichedHit, library: 'mine' | 'others' = 'mine'): Record<string, unknown> => {
    const { renderAbsPath, ...rest } = h
    return { ...rest, thumbUrl: swThumb(renderAbsPath), library }
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
      thumbUrl: swThumb(abs),
      library: 'mine',
      ownership: 'mine', // the well is the user's own content → author renders as "me"
      author: ''
    }
  }

  // An extracted-from-a-deck image → the wire shape, as a standalone image card.
  const archiveImageToWire = (im: ImageHit, idx: DeckMetaIndex, library: 'mine' | 'others' = 'mine'): Record<string, unknown> => {
    const m = idx[im.deck]
    return {
      library,
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
      thumbUrl: swThumb(im.fileAbsPath),
      ownership: m?.ownership || 'unknown',
      author: m?.author || ''
    }
  }

  ipcMain.handle('archive:search', async (_e, query: string, filters: SearchFilters) => {
    const scope = filters?.scope ?? 'all'
    const type = filters?.type ?? 'slides'
    // Which store(s) to search (ADR-0031): the user's archive, the separate Others' Library, or both.
    const lib = filters?.library ?? 'mine'
    const includeMine = lib !== 'others'
    const includeOthers = lib !== 'mine'
    const out: Array<Record<string, unknown>> = []

    const pushSlides = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const clusters = await archiveResults(root, cacheDir(), query ?? '', filters)
      for (const c of clusters) out.push({ representative: toWire(c.representative, library), members: c.members.map((m) => toWire(m, library)), size: c.size, deckCount: c.deckCount })
    }
    const pushImages = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const idx = loadDeckMeta(root, cacheDir())
      const deckNeedle = (filters.deck || '').toLowerCase()
      for (const im of await searchImages(root, query ?? '', 120)) {
        if (deckNeedle) {
          const m = idx[im.deck]
          if (!`${im.deck} ${m?.title || ''} ${m?.filename || ''}`.toLowerCase().includes(deckNeedle)) continue
        }
        const w = archiveImageToWire(im, idx, library)
        out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
      }
    }

    if (type === 'slides') {
      // whole slides (the well has no slides, so Well-scope is empty here)
      if (scope !== 'well' && includeMine && archiveAvailable()) {
        try { await pushSlides(archiveRoot(), 'mine') } catch { /* mine search failed */ }
      }
      if (scope !== 'well' && includeOthers && othersArchiveAvailable()) {
        try { await pushSlides(othersArchiveRootResolved(), 'others') } catch { /* others search failed */ }
      }
    } else {
      // images: the pictures embedded in decks (separate from the slides) + the well's images
      if (scope !== 'well' && includeMine && archiveAvailable()) {
        try { await pushImages(archiveRoot(), 'mine') } catch { /* mine images failed */ }
      }
      if (scope !== 'well' && includeOthers && othersArchiveAvailable()) {
        try { await pushImages(othersArchiveRootResolved(), 'others') } catch { /* others images failed */ }
      }
      // the well is the user's own — shown for Mine/All, not when searching Others only
      if (scope !== 'archive' && includeMine) {
        try {
          for (const r of await searchWell(wellRootResolved(), query ?? '', 60)) {
            const w = wellToWire(r)
            out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
          }
        } catch { /* no well yet */ }
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

  // Deck MODE: one card per presentation (title-slide cover), filtered like the slide search.
  ipcMain.handle('archive:list-decks', async (_e, filters: SearchFilters) => {
    const lib = filters?.library ?? 'mine'
    const out: Array<Record<string, unknown>> = []
    const add = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const decks = await listDecks(root, cacheDir(), filters)
      for (const { coverAbsPath, ...d } of decks) out.push({ ...d, coverThumbUrl: swThumb(coverAbsPath), library })
    }
    if (lib !== 'others' && archiveAvailable()) {
      try { await add(archiveRoot(), 'mine') } catch { /* mine decks failed */ }
    }
    if (lib !== 'mine' && othersArchiveAvailable()) {
      try { await add(othersArchiveRootResolved(), 'others') } catch { /* others decks failed */ }
    }
    return out
  })
  // Full metadata for one deck (for the sidebar). Resolves to whichever store holds the deck.
  ipcMain.handle('archive:deck-detail', (_e, pid: string) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return null
    try {
      const root = rootForDeck(pid)
      const d = deckDetail(root, cacheDir(), pid)
      if (!d) return null
      const library = root === othersArchiveRootResolved() && root !== archiveRoot() ? 'others' : 'mine'
      return { ...d, library }
    } catch {
      return null
    }
  })

  // Stats bundle (timeline of "my" PowerPoint history) for the Stats view.
  ipcMain.handle('archive:stats', async () => {
    if (!archiveAvailable()) return null
    try {
      return await archiveStats(archiveRoot(), cacheDir())
    } catch {
      return null
    }
  })

  // The structured content (presentation.json node) of one slide — for "Copy structure".
  ipcMain.handle('archive:slide-structure', (_e, deck: string, slideOrder: number | null) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return null
    try {
      return slideStructure(rootForDeck(deck), deck, slideOrder)
    } catch {
      return null
    }
  })

  // The embedded image assets on one slide → renderable swarchive:// thumbnails (for the inspector).
  ipcMain.handle('archive:slide-images', (_e, deck: string, slideOrder: number | null) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return []
    try {
      return slideImages(rootForDeck(deck), deck, slideOrder).map((im) => ({ thumbUrl: swThumb(im.absPath) }))
    } catch {
      return []
    }
  })

  // All slides of one presentation, in order — for "See in context". Tagged with the store it came from.
  ipcMain.handle('archive:deck-slides', async (_e, deck: string) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return []
    try {
      const root = rootForDeck(deck)
      const library = root === othersArchiveRootResolved() && root !== archiveRoot() ? 'others' : 'mine'
      return (await deckSlides(root, cacheDir(), deck)).map((h) => toWire(h, library))
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

  // --- triage (ADR-0029): scan a source folder, browse/decide, promote keepers into the well ---
  ipcMain.handle('settings:choose-screenshot-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ screenshotRoot: r.filePaths[0] })
    return r.filePaths[0]
  })
  // One row → renderable wire shape. Images render from the source file; videos from a cached poster,
  // with mediaUrl pointing at the source file so the renderer can play it inline.
  const triageToWire = (r: TriageRow, sourceRoot: string, wellR: string): Record<string, unknown> => {
    const isVideo = r.kind === 'video'
    const offline = r.offline === '1'
    const fileAbs = join(sourceRoot, r.rel_path)
    const posterAbs = r.poster_rel ? join(wellR, r.poster_rel) : null
    const sizeBytes = Number(r.size) || 0
    const mtime = Number(r.mtime) || 0
    let date = ''
    try {
      date = new Date(mtime).toISOString().slice(0, 10)
    } catch {
      /* bad mtime → no date */
    }
    // Never point a thumbnail/media URL at an online-only placeholder — loading it would force a download.
    return {
      hash: r.hash,
      relPath: r.rel_path, // unique per file (the hash is the CONTENT hash and repeats for duplicates)
      kind: r.kind,
      filename: r.filename,
      ext: r.ext,
      state: r.state,
      offline,
      mtime,
      date,
      sizeMB: Math.round((sizeBytes / 1048576) * 10) / 10,
      large: isVideo && sizeBytes > VIDEO_GATE_BYTES,
      snippet: (r.ocr_text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      thumbUrl: offline ? null : swThumb(isVideo ? posterAbs : fileAbs),
      mediaUrl: offline || !isVideo ? null : swThumb(fileAbs)
    }
  }
  ipcMain.handle('triage:scan', async () => {
    const src = screenshotRootResolved()
    if (!src) return { ok: false, indexed: 0, total: 0 }
    const onP = (m: string): void => void mainWindow?.webContents.send('triage:progress', m)
    try {
      const res = await scanTriageSource(archiveRoot(), wellRootResolved(), src, onP)
      return { ok: true, ...res }
    } catch {
      return { ok: false, indexed: 0, total: 0 }
    }
  })
  ipcMain.handle('triage:list', async (_e, q: string, state: string, sort?: string, limit?: number, offset?: number) => {
    const src = screenshotRootResolved()
    const wellR = wellRootResolved()
    const empty = { items: [], counts: { undecided: 0, included: 0, excluded: 0, total: 0 }, hasMore: false }
    if (!src) return empty
    try {
      const s = sort === 'date-desc' || sort === 'date-asc' ? sort : 'scanned'
      const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 500) : 150
      const off = typeof offset === 'number' && offset > 0 ? offset : 0
      const rows = await listTriage(wellR, q ?? '', state ?? 'undecided', s, lim, off)
      const counts = await triageCounts(wellR)
      return { items: rows.map((r) => triageToWire(r, src, wellR)), counts, hasMore: rows.length === lim }
    } catch {
      return empty
    }
  })
  ipcMain.handle('triage:decide', async (_e, hash: string, action: 'include' | 'exclude' | 'reset', force?: boolean) => {
    const src = screenshotRootResolved()
    if (!src) return { state: 'undecided' }
    try {
      return await setTriageDecision(archiveRoot(), wellRootResolved(), src, hash, action, Boolean(force))
    } catch {
      return { state: 'undecided' }
    }
  })
  // Paste-to-include: read an image off the clipboard and ingest it straight into the well (the paste
  // IS the keep decision, ADR-0029). Returns the new well id or null when the clipboard has no image.
  ipcMain.handle('well:add-from-clipboard', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const tmp = join(tmpdir(), `sw-paste-${Date.now()}.png`)
    try {
      writeFileSync(tmp, img.toPNG())
      const res = await ingestScreenshot(archiveRoot(), wellRootResolved(), tmp, 'screenshot')
      return res ? { id: res.id } : null
    } catch {
      return null
    }
  })

  // --- Others' Library (Scenario A, ADR-0031): a separate store for other people's decks ---
  ipcMain.handle('settings:choose-others-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const picked = r.filePaths[0]
    // Never let the Others' Library overlap the personal archive — that would defeat the separation.
    if (within(picked, archiveRoot()) || within(archiveRoot(), picked) || resolvePath(picked) === resolvePath(archiveRoot())) {
      await dialog.showMessageBox({ type: 'warning', buttons: ['OK'], message: "That folder overlaps your own archive.", detail: 'Pick a separate location for the Others’ Library so other people’s slides never mix into your archive.' })
      return readConfig().othersArchiveRoot ?? null
    }
    writeConfig({ othersArchiveRoot: picked })
    return picked
  })
  // Purge the whole Others' Library (its built store only) — never touches the personal archive.
  ipcMain.handle('settings:clear-others-library', async () => {
    const root = othersArchiveRootResolved()
    if (resolvePath(root) === resolvePath(archiveRoot()) || within(archiveRoot(), root)) return { ok: false }
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Clear it'],
      defaultId: 0,
      cancelId: 0,
      message: 'Clear the Others’ Library?',
      detail: `Deletes everything imported into ${root}. Your own archive is untouched.`
    })
    if (res.response !== 1) return { ok: false, cancelled: true }
    for (const sub of ['extracted', 'registry', 'media-store']) {
      try { rmSync(join(root, sub), { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    return { ok: true }
  })

  // --- archive ingest (Core A pipeline as streamed subprocesses) ---
  const sendLine = (s: string): void => mainWindow?.webContents.send('ingest:line', s)
  const python = (): string => detectPython(readConfig().pythonPath)
  // Streamed feedback when import can't even start — otherwise the button "does nothing".
  const archiveMissingLine = (): void =>
    sendLine(`✕ No archive found at ${archiveRoot()} — it must contain a "registry" folder. Set a valid archive in Settings (⚙ → Archive).`)
  ipcMain.handle('ingest:pending', async () => {
    if (!archiveAvailable()) {
      archiveMissingLine()
      return { ok: false }
    }
    return runIngest({ engineRoot: archiveRoot(), dataRoot: archiveRoot(), python: python(), mode: 'pending' }, sendLine)
  })
  // Pick the file/folder to import (returns the path so the panel can SHOW it before committing).
  ipcMain.handle('ingest:choose-path', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }]
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  // Run the import against an already-chosen path (no dialog — the panel confirmed what + where).
  // library 'others' routes the data into the separate Others' Library store (Scenario A); the
  // ENGINE is always the user's ppt-archive (that's where Core A's tools/ live).
  ipcMain.handle('ingest:run-path', async (_e, targetPath: string, library?: 'mine' | 'others') => {
    if (!archiveAvailable()) {
      archiveMissingLine()
      return { ok: false }
    }
    if (!targetPath) {
      sendLine('✕ Pick a file or folder to import first.')
      return { ok: false }
    }
    const dataRoot = library === 'others' ? othersArchiveRootResolved() : archiveRoot()
    if (library === 'others') sendLine(`→ Importing into your Others' Library (kept separate from your archive): ${dataRoot}`)
    return runIngest({ engineRoot: archiveRoot(), dataRoot, python: python(), mode: 'path', targetPath }, sendLine)
  })
  ipcMain.handle('ingest:cancel', () => {
    cancelIngest()
    return true
  })

  // --- convert (sideband, throwaway): someone else's .pptx → a mechanical Outline folder,
  //     saved wherever the user picks. Never touches the archive registry or the vault. ---
  const sendConvertLine = (s: string): void => mainWindow?.webContents.send('convert:line', s)
  ipcMain.handle('settings:choose-conversions-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ conversionsRoot: r.filePaths[0] })
    return r.filePaths[0]
  })
  ipcMain.handle('settings:set-convert-ocr', (_e, on: boolean) => {
    writeConfig({ convertOcrByDefault: Boolean(on) })
    return Boolean(on)
  })
  // Step 1: pick the source .pptx — returns its path so the panel SHOWS it before converting.
  ipcMain.handle('convert:choose-source', async () => {
    const pick = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }] })
    return pick.canceled || !pick.filePaths[0] ? null : pick.filePaths[0]
  })
  // Step 2: pick the destination folder, pre-filled from the source name + the conversionsRoot default.
  ipcMain.handle('convert:choose-dest', async (_e, sourcePath: string) => {
    const suggested = slugify(basename(sourcePath || '').replace(/\.(pptx|ppt)$/i, '')) || 'converted'
    const defDir = conversionsRootResolved()
    const defaultPath = join(defDir && existsSync(defDir) ? defDir : homedir(), suggested)
    const save = await dialog.showSaveDialog({ title: 'Save the converted Outline folder as…', buttonLabel: 'Choose', defaultPath })
    return save.canceled || !save.filePath ? null : save.filePath
  })
  // Step 3: run the conversion against the already-chosen source + destination (no dialogs here).
  ipcMain.handle('convert:run', async (_e, opts: { pptxPath: string; outDir: string; ocr: boolean }) => {
    if (!archiveAvailable()) {
      sendConvertLine('✕ Archive engine not found — set it in Settings (extraction needs Core A).')
      return { ok: false, error: 'archive unavailable' }
    }
    if (!opts?.pptxPath || !opts?.outDir) return { ok: false, error: 'pick a PowerPoint and a destination first' }
    try {
      if (existsSync(opts.outDir) && readdirSync(opts.outDir).length > 0) {
        const res = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Write here anyway'],
          defaultId: 0,
          cancelId: 0,
          message: `“${basename(opts.outDir)}” already exists and isn't empty. Write the converted Outline into it anyway?`
        })
        if (res.response !== 1) return { ok: false, cancelled: true }
      }
    } catch {
      /* stat race → proceed */
    }
    const r = await convertPptxToOutline({ archiveRoot: archiveRoot(), python: python(), pptxPath: opts.pptxPath, outDir: opts.outDir, ocr: Boolean(opts?.ocr) }, sendConvertLine)
    if (r.ok && r.outDir) {
      const outlineFile = join(r.outDir, `${slugify(basename(r.outDir)) || 'converted'}-outline.md`)
      shell.showItemInFolder(existsSync(outlineFile) ? outlineFile : r.outDir)
    }
    return r
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

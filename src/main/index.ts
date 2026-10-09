import { app, BrowserWindow, ipcMain, dialog, protocol, shell, net, clipboard, nativeImage, safeStorage } from 'electron'
import sharp from 'sharp'
import { join, basename } from 'path'
import { homedir, tmpdir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, watch as fsWatch } from 'fs'
import { pathToFileURL } from 'url'
import { execFile } from 'node:child_process'
import { resolve as resolvePath, sep as pathSep } from 'path'
import { planSources, matchesFromKind, countFrom, type FilterableResult, type FromCounts, type SourcePlan } from './searchfilters'
import { matchedSearch, rowIds, type MatchCluster, type MatchRow } from './matched-search'
import { mergeLookAlikeClusters } from './look-alike/merge-clusters'
import { cachedDHash } from './look-alike/fingerprint'
import { runMoreLikeThis } from './more-like-this'
import type { MatchMode } from './match-bands'
import { applyFilters, combinedDateFilter, parseQuery, resolveOwnershipFilter } from './searchlib'
import { archiveResults, deckSlides, slideStructure, slideImages, searchImages, listDecks, deckDetail, archiveStats, type SearchFilters, type EnrichedHit, type ImageHit } from './archive'
import { loadDeckMeta, categoryList, invalidateDeckMeta, setOwnerNames, type DeckMetaIndex } from './deckmeta'
import { resolveOwnerNames, cleanOwnerNames } from './owners'
import { ensureWell, drainInbox, scanVault, searchWell, wellByIds, wellAbsPath, ingestScreenshot, findFfmpeg, type WellRow } from './well'
import { scanTriageSource, listTriage, triageCounts, setTriageDecision, importSelectedTriage, VIDEO_GATE_BYTES, type TriageRow } from './triage'
import { cleanShotFolder } from './cleanshot-folder'
import { createSourceWatcher } from './source-watcher'
import { registerBacklogIpc } from './backlog-ipc'
import { talkAbsPath, isVaultChangeRelevant } from './talk-usage'
import { createTalkUsageService } from './talk-usage-service'
import { runIngest, cancelIngest, detectPython, findRenderTools } from './ingest'
import { convertPptxToOutline } from './convert'
import { slugify } from './outline'
import { testR2, type R2Settings, type R2Creds } from './r2'
import { pickStore, keyForPath, fetchFromR2, syncDirToR2, type StoreName } from './storage'
import { PictureSearchService, registerPictureSearchIpc, type PictureSearchSettings } from './picture-search/service'
import { WebGpuEmbedder } from './picture-search/webgpu-embedder'
import { electronEmbedHost, registerEmbedProtocol, EMBED_SCHEME } from './picture-search/electron-embed-host'
import { modelDir as pictureModelDir } from './picture-search/model-store'
import { SorterService, registerSorterIpc } from './sorter/service'
import createTrainWorker from './sorter/train-worker?nodeWorker'
import type { Job, JobResult } from './sorter/jobs'
import type { FetchLike } from './picture-search/model-store'
import { ReviewService } from './review/service'
import { registerReviewIpc } from './review/ipc'
import { CloudSorter, normaliseCloudSettings, registerCloudIpc, type CloudRunSummary, type CloudSettings } from './sorter/cloud/service'
import { ApiKeyStore } from './sorter/cloud/key-store'
import { shrinkForLuna } from './sorter/cloud/images'
import type { HttpPost } from './sorter/cloud/client'
import { guardedHandle } from './ipc-guard'
import { pileOf, type ProposalLabel } from './review/piles'

const REQUIREMENTS_URL = 'https://github.com/techczech/slidewell/blob/main/REQUIREMENTS.md'

// Test-only: SLIDEWELL_E2E_HIDDEN=1 keeps automated runs in the background (no window shown, no
// Dock icon, nothing takes focus). Honoured only when set to exactly '1'; unset changes nothing.
const E2E_HIDDEN = process.env['SLIDEWELL_E2E_HIDDEN'] === '1'
if (E2E_HIDDEN && process.platform === 'darwin') app.dock?.hide()

// Custom schemes must be registered as privileged BEFORE app ready so the renderer treats them
// as standard secure schemes (CSP img-src matching, no mixed-content blocking). SlideWell mirrors
// TalkWeaver's tw* schemes with sw*: swasset (the well's owned assets), swthumb (generated
// thumbnails), swarchive (read-only files from the Core A extraction store). Handlers below.
protocol.registerSchemesAsPrivileged([
  { scheme: 'swasset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'swthumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'swarchive', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // the hidden picture-search window's page + ONNX Runtime Web files (picture-search/webgpu-embedder.ts)
  { scheme: EMBED_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

// An extra folder watched for screenshots. namedOnly = only files named like screenshots, top level only (the Desktop).
type CaptureSource = { path: string; namedOnly: boolean }

// Simple JSON config — avoids ESM/CJS issues with electron-store (same call TalkWeaver made).
type Config = {
  archiveRoot?: string
  wellRoot?: string
  vaultRoot?: string
  screenshotRoot?: string
  captureSources?: CaptureSource[] // extra capture sources beside screenshotRoot (capture inbox)
  conversionsRoot?: string // default destination for throwaway PPTX→Outline conversions
  convertOcrByDefault?: boolean // initial state of the convert OCR toggle
  othersArchiveRoot?: string // the Others' Library store (Scenario A) — other people's decks, kept separate
  r2?: { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyIdEnc?: string; secretEnc?: string } // R2 backend (creds safeStorage-encrypted)
  storage?: Partial<Record<'archive' | 'others' | 'well', { backend?: 'local' | 'r2' }>> // per-store backend (spec 2026-06-24)
  ownerNames?: string[] // "My decks": authors that count as the user (unset → the OS account's names; owners.ts)
  pictureSearch?: PictureSearchSettings // picture search: well images on/off, indexing paused (survives restart)
  // sorter cloud step (ticket 07): the OpenAI key only as safeStorage ciphertext (keyEnc), never in plain text
  sorterCloud?: Partial<CloudSettings> & { keyEnc?: string; lastRunAt?: string | null; since?: string | null; lastRun?: CloudRunSummary | null }
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

// R2 backend config (ADR-0032 / spec 2026-06-24). Non-secret settings live in config.json; the
// access key + secret are safeStorage-encrypted (OS keychain), never returned to the renderer.
function r2Settings(): R2Settings {
  const r = readConfig().r2 ?? {}
  return { accountId: r.accountId ?? '', endpoint: r.endpoint, bucket: r.bucket || 'ppt-archive-media', prefix: r.prefix || 'slidewell' }
}
function r2Creds(): R2Creds | null {
  const r = readConfig().r2 ?? {}
  if (!r.accessKeyIdEnc || !r.secretEnc || !safeStorage.isEncryptionAvailable()) return null
  try {
    return {
      accessKeyId: safeStorage.decryptString(Buffer.from(r.accessKeyIdEnc, 'base64')),
      secretAccessKey: safeStorage.decryptString(Buffer.from(r.secretEnc, 'base64'))
    }
  } catch {
    return null
  }
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

// Defaults offered in Settings. The Desktop is namedOnly so other Desktop files are never read.
// CleanShot's folder is read from its own preferences; null (not offered) when unset or missing.
async function captureDefaults(): Promise<{ desktop: CaptureSource; cleanshot: CaptureSource | null }> {
  const cs = await cleanShotFolder()
  return {
    desktop: { path: join(homedir(), 'Desktop'), namedOnly: true },
    cleanshot: cs ? { path: cs, namedOnly: false } : null
  }
}

// Every folder the capture inbox reads: the primary screenshotRoot plus configured extras that exist.
function triageSources(): CaptureSource[] {
  const out: CaptureSource[] = []
  const primary = screenshotRootResolved()
  if (primary) out.push({ path: primary, namedOnly: false })
  for (const s of readConfig().captureSources ?? []) {
    if (s && typeof s.path === 'string' && existsSync(s.path) && !out.some((o) => o.path === s.path)) out.push({ path: s.path, namedOnly: Boolean(s.namedOnly) })
  }
  return out
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
  return [archiveRoot(), othersArchiveRootResolved(), wellRootResolved(), detectVaultRoot(), screenshotRootResolved(), ...triageSources().map((s) => s.path)].filter((r): r is string => Boolean(r))
}

let mainWindow: BrowserWindow | null = null
let pictureSearch: PictureSearchService | null = null
let launchScanHook: () => void = () => undefined
let refreshWatchers: () => void = () => undefined

function createWindow(): BrowserWindow {
  const bounds = readConfig().windowBounds ?? { width: 1400, height: 900 }
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    // hidden test runs: never shown, but still painted and not throttled, so screenshots render
    ...(E2E_HIDDEN ? { show: false, paintWhenInitiallyHidden: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      ...(E2E_HIDDEN ? { backgroundThrottling: false } : {})
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
/** Decode a swarchive://f/<b64> URL to a guarded absolute path (may not exist locally), or null. */
function decodeSwUrlPath(url: string): string | null {
  try {
    const b64 = new URL(url).pathname.replace(/^\/+/, '')
    const abs = decodeB64Url(b64)
    return withinAny(allowedRoots(), abs) ? abs : null
  } catch {
    return null
  }
}
/** Guarded absolute path that exists locally now, or null (used by copy/reveal which need a real file). */
function resolveSwUrl(url: string): string | null {
  const abs = decodeSwUrlPath(url)
  return abs && existsSync(abs) ? abs : null
}

// Per-store backend (spec 2026-06-24): which store a path is in, and its backend.
function storageRoots(): Partial<Record<StoreName, string>> {
  return { archive: archiveRoot(), others: othersArchiveRootResolved(), well: wellRootResolved() }
}
function storeBackend(store: StoreName): 'local' | 'r2' {
  return readConfig().storage?.[store]?.backend === 'r2' ? 'r2' : 'local'
}
// Serve a swarchive path: local file if present; else, for an R2-backed store, fetch it from R2 into
// the local store dir (which doubles as the cache) and serve that. Never deletes anything.
async function serveLocalOrR2(abs: string): Promise<string | null> {
  if (existsSync(abs)) return abs
  const s = pickStore(storageRoots(), abs)
  if (!s || storeBackend(s.store) !== 'r2') return null
  const creds = r2Creds()
  if (!creds) return null
  const ok = await fetchFromR2(r2Settings(), creds, keyForPath(r2Settings().prefix, s.store, s.root, abs), abs)
  return ok ? abs : null
}

app.whenReady().then(() => {
  protocol.handle('swarchive', async (request) => {
    const abs = decodeSwUrlPath(request.url)
    const served = abs ? await serveLocalOrR2(abs) : null
    if (!served) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(served).toString())
  })

  // --- picture search: model download, background indexing, query (picture-search/service.ts) ---
  // The model lives under the app's data folder; vectors go to picture-search.db beside well.db.
  // No network call happens until the user presses Download in Settings.
  const picModelsRoot = join(app.getPath('userData'), 'models')
  registerEmbedProtocol(() => pictureModelDir(picModelsRoot))
  const picFetch: FetchLike = (url, init) => net.fetch(url, { headers: init.headers, signal: init.signal }) as ReturnType<FetchLike>
  pictureSearch = new PictureSearchService({
    modelsRoot: picModelsRoot,
    wellRoot: wellRootResolved,
    archiveRoot: () => (archiveAvailable() ? archiveRoot() : null),
    vaultRoot: detectVaultRoot,
    settings: () => readConfig().pictureSearch ?? {},
    saveSettings: (patch) => writeConfig({ pictureSearch: { ...(readConfig().pictureSearch ?? {}), ...patch } }),
    fetch: picFetch,
    makeEmbedder: (dir) => new WebGpuEmbedder(dir, electronEmbedHost(join(__dirname, '../preload/embedder.js'))),
    broadcast: (st) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('picture:status', st)
    }
  })
  // picture IPC answers the main window only (never the hidden picture-search window)
  registerPictureSearchIpc(pictureSearch, (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents))
  app.on('will-quit', () => pictureSearch?.dispose())

  // --- screenshot sorter, local part (sorter/service.ts): proposals only, never decisions or moves ---
  const pics = pictureSearch
  const sorter = new SorterService({
    wellRoot: wellRootResolved,
    pictures: { modelReady: () => pics.modelReady(), ensureVectors: (items, opts) => pics.ensureVectors(items, opts) },
    // grouping and fitting run in a worker thread (sorter/train-worker.ts); the main process stays responsive
    runJob: <J extends Job>(job: J, signal: AbortSignal) =>
      new Promise<JobResult<J>>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('cancelled'))
        const w = createTrainWorker({ workerData: job })
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          fn()
          void w.terminate()
        }
        // Stop terminates the worker at once; nothing it computed is used
        const onAbort = (): void => finish(() => reject(new Error('cancelled')))
        signal.addEventListener('abort', onAbort)
        w.once('message', (m: { result?: JobResult<J>; error?: string }) => finish(() => (m.result ? resolve(m.result) : reject(new Error(m.error ?? 'training failed')))))
        w.once('error', (e) => finish(() => reject(e)))
        w.once('exit', (code) => finish(() => reject(new Error(`training worker stopped (${code})`))))
      }),
    broadcast: (st) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sorter:status', st)
    }
  })
  registerSorterIpc(sorter, (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents))
  app.on('will-quit', () => sorter.cancel())

  // --- screenshot sorter, cloud step (sorter/cloud/service.ts): Luna for the doubtful ones, nightly + Sort now ---
  // The OpenAI key is stored like the R2 credentials: safeStorage ciphertext in config.json, never returned or logged.
  const cloudCfg = (): NonNullable<Config['sorterCloud']> => readConfig().sorterCloud ?? {}
  const saveCloudCfg = (patch: Partial<NonNullable<Config['sorterCloud']>>): void => writeConfig({ sorterCloud: { ...cloudCfg(), ...patch } })
  const lunaKey = new ApiKeyStore(
    () => cloudCfg().keyEnc,
    (enc) => saveCloudCfg({ keyEnc: enc }),
    { available: () => safeStorage.isEncryptionAvailable(), encrypt: (k) => safeStorage.encryptString(k), decrypt: (b) => safeStorage.decryptString(b) }
  )
  const lunaHttp: HttpPost = (url, init) => net.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal })
  const cloudSettings = (): CloudSettings => normaliseCloudSettings(cloudCfg())
  const cloud = new CloudSorter({
    wellRoot: wellRootResolved,
    sortLocal: () => sorter.sortUndecided(),
    canSortLocal: () => {
      const st = sorter.status()
      return st.canRunUnattended && st.modelReady
    },
    key: lunaKey,
    online: () => net.isOnline(),
    http: lunaHttp,
    shrink: (p) => shrinkForLuna(p),
    settings: cloudSettings,
    state: () => {
      const c = cloudCfg()
      return { lastRunAt: c.lastRunAt ?? null, since: c.since ?? null, lastRun: c.lastRun ?? null }
    },
    saveState: (patch) => saveCloudCfg(patch),
    broadcast: (st) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cloud:status', st)
    },
    log: (line) => console.warn(line)
  })
  registerCloudIpc(cloud, lunaKey, (s) => saveCloudCfg(s), cloudSettings, (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents))
  // the nightly batch runs only while the app is open: checked shortly after launch (a missed night runs then) and every minute
  const cloudTick = (): void => void cloud.tick().catch((e) => console.warn(`[sorter-cloud] nightly check failed: ${(e as Error)?.name ?? 'error'}`))
  const cloudFirst = setTimeout(cloudTick, 30_000)
  const cloudTimer = setInterval(cloudTick, 60_000)
  app.on('will-quit', () => {
    clearTimeout(cloudFirst)
    clearInterval(cloudTimer)
    cloud.cancel()
  })

  // --- review screen (review/service.ts): his keep/throwaway, piles, 30-day Bin; never touches an original ---
  const review = new ReviewService({
    wellRoot: wellRootResolved,
    archiveRoot: () => archiveRoot(),
    sourceRoot: () => triageSources()[0]?.path ?? null,
    thumbUrl: swThumb,
    changed: () => {
      pictureSearch?.poke()
      mainWindow?.webContents.send('triage:changed')
    }
  })
  registerReviewIpc(review, (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents))

  // --- IPC: the typed contract lives in src/preload/index.ts ---
  ipcMain.handle('archive:available', () => archiveAvailable())
  ipcMain.handle('settings:get-paths', async () => ({
    archiveRoot: readConfig().archiveRoot ?? null,
    archiveDefault: ARCHIVE_DEFAULT,
    archiveAvailable: archiveAvailable(),
    wellRoot: wellRootResolved(),
    vaultRoot: detectVaultRoot(),
    vaultAvailable: Boolean(detectVaultRoot()),
    screenshotRoot: screenshotRootResolved(),
    screenshotAvailable: Boolean(screenshotRootResolved()),
    captureSources: (readConfig().captureSources ?? []).map((s) => ({ path: s.path, namedOnly: Boolean(s.namedOnly), exists: existsSync(s.path) })),
    captureDefaults: await captureDefaults(),
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
    pictureSearch?.pokeArchive() // index the newly chosen archive's renders
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
        { key: 'archive', label: 'PowerPoint archive engine (Core A · ppt-archive)', found: archiveAvailable(), detail: archiveRoot(), requiredFor: 'Slide/presentation search & PPTX import', install: 'Clone techczech/ppt-archive and point Settings at it', required: true },
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
  setOwnerNames(resolveOwnerNames(readConfig().ownerNames).names)
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
      usedInTalks: (talkUsage.usage().get(r.id) ?? []).length,
      talkUses: talkUsage.usage().get(r.id) ?? [],
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

  // Collect the wire rows for each store the plan asks for (ADR-0031 library choice applies to all).
  const collectResults = async (query: string, filters: SearchFilters, plan: SourcePlan): Promise<Array<Record<string, unknown>>> => {
    // Which store(s) to search: the user's archive, the separate Others' Library, or both.
    const lib = filters?.library ?? 'mine'
    const includeMine = lib !== 'others'
    const includeOthers = lib !== 'mine'
    const out: Array<Record<string, unknown>> = []

    // The others store has no "mine" decks, so the owner filter (default 'mine') would exclude
    // everything — neutralize it to 'all' there. Author is the lens for the Others' Library.
    const forStore = (library: 'mine' | 'others'): SearchFilters => (library === 'others' ? { ...filters, owner: 'all' } : filters)
    const pushSlides = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const clusters = await archiveResults(root, cacheDir(), query, forStore(library))
      for (const c of clusters) out.push({ representative: toWire(c.representative, library), members: c.members.map((m) => toWire(m, library)), size: c.size, deckCount: c.deckCount })
    }
    const pushImages = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const idx = loadDeckMeta(root, cacheDir())
      const deckNeedle = (filters.deck || '').toLowerCase()
      for (const im of await searchImages(root, query, 120)) {
        if (deckNeedle) {
          const m = idx[im.deck]
          if (!`${im.deck} ${m?.title || ''} ${m?.filename || ''}`.toLowerCase().includes(deckNeedle)) continue
        }
        const w = archiveImageToWire(im, idx, library)
        out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
      }
    }

    if (plan.slides) {
      if (includeMine && archiveAvailable()) {
        try { await pushSlides(archiveRoot(), 'mine') } catch { /* mine search failed */ }
      }
      if (includeOthers && othersArchiveAvailable()) {
        try { await pushSlides(othersArchiveRootResolved(), 'others') } catch { /* others search failed */ }
      }
    }
    if (plan.archiveImages) {
      if (includeMine && archiveAvailable()) {
        try { await pushImages(archiveRoot(), 'mine') } catch { /* mine images failed */ }
      }
      if (includeOthers && othersArchiveAvailable()) {
        try { await pushImages(othersArchiveRootResolved(), 'others') } catch { /* others images failed */ }
      }
    }
    // the well is the user's own — shown for Mine/All, not when searching Others only
    if (plan.well && includeMine) {
      try {
        const wellRows = await searchWell(wellRootResolved(), query, 60)
        // pictures talks use always get their chance, even past the first 60 words-matches
        const seen = new Set(wellRows.map((r) => r.id))
        const used = [...talkUsage.usage().keys()].slice(0, 900)
        for (const r of await searchWell(wellRootResolved(), query, 60, used).catch(() => [] as WellRow[])) if (!seen.has(r.id)) wellRows.push(r)
        for (const r of wellRows) {
          const w = wellToWire(r)
          out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
        }
      } catch { /* no well yet */ }
    }
    return out
  }
  const rep = (c: Record<string, unknown>): FilterableResult => c.representative as FilterableResult

  /** Picture-search ids to wire rows (a size-1 cluster each), through the same Library/Owner/Date/Category/From/Kind filters as word hits. */
  async function resolvePictureIds(ids: string[], filters: SearchFilters, query: string): Promise<Map<string, MatchCluster>> {
    const from = filters?.from ?? 'all'
    const kind = filters?.kind ?? 'all'
    const lib = filters?.library ?? 'mine'
    const parsed = parseQuery(query ?? '')
    const out = new Map<string, MatchCluster>()
    const single = (w: Record<string, unknown>): MatchCluster => ({ representative: w as never, members: [w as never], size: 1, deckCount: 1 })
    const slidesByPid = new Map<string, Record<string, unknown>[]>()
    const wellIds: string[] = []
    for (const id of ids) {
      const m = id.match(/^slide:(.+)#(\d+)$/)
      if (m) {
        const pid = m[1]
        const root = rootForDeck(pid)
        const library: 'mine' | 'others' = root === othersArchiveRootResolved() && root !== archiveRoot() ? 'others' : 'mine'
        if ((library === 'mine' && lib === 'others') || (library === 'others' && lib === 'mine')) continue
        if (!slidesByPid.has(pid)) {
          try {
            slidesByPid.set(pid, (await deckSlides(root, cacheDir(), pid)).map((h) => toWire(h, library)))
          } catch {
            slidesByPid.set(pid, [])
          }
        }
        const w = slidesByPid.get(pid)!.find((r) => r.slideOrder === Number(m[2]))
        if (!w) continue
        const forLib = library === 'others' ? { ...filters, owner: 'all' as const } : filters
        const idx = loadDeckMeta(root, cacheDir())
        const subs = (f: string): string[] => (f ? [f.toLowerCase()] : [])
        const kept = applyFilters(
          [w as { deck: string }],
          idx,
          combinedDateFilter(parsed, filters.era),
          [...parsed.deckSubstrings, ...subs(filters.deck)],
          resolveOwnershipFilter(parsed.owner, forLib.owner),
          [...subs(filters.category), ...parsed.categorySubstrings]
        )
        if (kept.length && matchesFromKind(w as unknown as FilterableResult, from, kind)) out.set(id, single(w))
      } else if (id.startsWith('well:') && lib !== 'others') {
        wellIds.push(id.slice(5))
      }
    }
    if (wellIds.length) {
      for (const r of await wellByIds(wellRootResolved(), wellIds).catch(() => [] as WellRow[])) {
        const w = wellToWire(r)
        if (matchesFromKind(w as unknown as FilterableResult, from, kind)) out.set(`well:${r.id}`, single(w))
      }
    }
    return out
  }

  /** Group result clusters by appearance ("N versions") when grouping is on; items with no embedding keep their text clusters. */
  async function groupByLook<C>(clusters: C[], filters: SearchFilters): Promise<C[]> {
    if (!filters?.cluster || clusters.length < 2) return clusters
    try {
      return (await mergeLookAlikeClusters(clusters as never, {
        idOf: (row: MatchRow) => rowIds(row)[0] ?? null,
        vectorsOf: (ids: string[]) => pictureSearch?.lookAlikeInputs(ids).vectors ?? new Map(),
        fingerprints: async (ids: string[]) => {
          const paths = pictureSearch?.lookAlikeInputs(ids).paths() ?? new Map<string, string>()
          const out = new Map<string, bigint>()
          for (const id of ids.slice(0, 80)) {
            const p = paths.get(id)
            const h = p ? await cachedDHash(p) : null
            if (h !== null) out.set(id, h)
          }
          return out
        }
      } as never)) as unknown as C[]
    } catch {
      return clusters // grouping is a nicety: never lose results to it
    }
  }

  ipcMain.handle('archive:search', async (_e, query: string, filters: SearchFilters) => {
    const from = filters?.from ?? 'all'
    const kind = filters?.kind ?? 'all'
    const plan = planSources(filters?.type ?? 'slides', from, kind)
    const rows = await collectResults(query ?? '', filters, plan)
    return groupByLook(rows.filter((c) => matchesFromKind(rep(c), from, kind)), filters)
  })

  // Search with the Match switch (Words / Meaning / Both): word hits, picture hits, two bands.
  // Picture hits are resolved to the same wire rows and pass the same Library/Owner/Date/Category/
  // Presentation/From/Kind filters as word hits. Words mode never runs a picture query.
  ipcMain.handle('archive:search-matched', async (_e, query: string, filters: SearchFilters, mode: MatchMode) => {
    const from = filters?.from ?? 'all'
    const kind = filters?.kind ?? 'all'
    const resolve = (ids: string[]): Promise<Map<string, MatchCluster>> => resolvePictureIds(ids, filters, query)
    const result = await matchedSearch(
      {
        words: async (q) => {
          const plan = planSources(filters?.type ?? 'slides', from, kind)
          const rows = await collectResults(q ?? '', filters, plan)
          return (await groupByLook(rows.filter((c) => matchesFromKind(rep(c), from, kind)), filters)) as unknown as MatchCluster[]
        },
        modelReady: () => pictureSearch?.status().model === 'ready',
        pictureQuery: (text, opts) => pictureSearch!.pictureQuery({ text }, opts),
        resolve
      },
      query ?? '',
      filters ?? {},
      mode === 'words' || mode === 'meaning' ? mode : 'both'
    )
    return { ...result, related: await groupByLook(result.related, filters) }
  })

  // More like this (inspector): the six most similar items from other presentations and the well, by
  // stored vectors (no model run, but the model must be downloaded). Any Library, Owner and date.
  ipcMain.handle('archive:more-like-this', async (_e, row: { kind: string; deck: string; slideOrder: number | null; reference: string }) => {
    const open = { library: 'all', owner: 'all', era: 'all', category: '', deck: '', role: 'all', from: 'all', kind: 'all' } as unknown as SearchFilters
    return runMoreLikeThis<MatchCluster['representative']>(
      {
        modelReady: () => pictureSearch?.status().model === 'ready',
        query: (imageId, opts) => pictureSearch!.pictureQuery({ imageId }, opts),
        resolve: async (ids) => {
          const clusters = await resolvePictureIds(ids, open, '')
          return new Map([...clusters].map(([id, c]) => [id, c.representative]))
        }
      },
      row as never
    )
  })

  // Counts for the From chips: the current query over every store, Kind applied, From ignored.
  ipcMain.handle('archive:from-counts', async (_e, query: string, filters: SearchFilters): Promise<FromCounts> => {
    const kind = filters?.kind ?? 'all'
    const rows = await collectResults(query ?? '', filters, { slides: true, archiveImages: true, well: true })
    return countFrom(rows.map(rep), kind)
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
      const f = library === 'others' ? { ...filters, owner: 'all' as const } : filters
      const decks = await listDecks(root, cacheDir(), f)
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

  // TalkWeaver registers no URL scheme and no document type, so the nearest thing to "open the talk"
  // is showing its outline file in Finder. The path is vault-relative and must stay inside the vault.
  ipcMain.handle('talks:reveal', (_e, relPath: string) => {
    const vr = detectVaultRoot()
    if (!vr || typeof relPath !== 'string') return false
    const abs = talkAbsPath(vr, relPath)
    if (!abs) return false
    shell.showItemInFolder(abs)
    return true
  })

  // --- well / import paths ---
  ipcMain.handle('settings:choose-vault', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ vaultRoot: r.filePaths[0] })
    void talkUsage.sync()
    return r.filePaths[0]
  })
  // Re-scan the TalkWeaver vault for new images and index them; returns count added.
  ipcMain.handle('well:scan-vault', async () => {
    const vr = detectVaultRoot()
    if (!vr) return 0
    try {
      // queued, not awaited: a switch waits for an in-flight talk scan, and image indexing need not
      void talkUsage.sync()
      void talkUsage.refresh()
      return await scanVault(archiveRoot(), wellRootResolved(), vr)
    } catch {
      return 0
    } finally {
      pictureSearch?.poke()
    }
  })

  // --- triage (ADR-0029): scan a source folder, browse/decide, promote keepers into the well ---
  ipcMain.handle('settings:choose-screenshot-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ screenshotRoot: r.filePaths[0] })
    refreshWatchers()
    return r.filePaths[0]
  })
  // Capture inbox extras: 'desktop' | 'cleanshot' add the offered defaults; 'folder' asks for a folder.
  ipcMain.handle('settings:add-capture-source', async (_e, which: 'desktop' | 'cleanshot' | 'folder') => {
    let src: CaptureSource | null = null
    if (which === 'desktop' || which === 'cleanshot') src = (await captureDefaults())[which]
    else {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (!r.canceled && r.filePaths[0]) src = { path: r.filePaths[0], namedOnly: false }
    }
    if (!src) return false
    const cur = readConfig().captureSources ?? []
    if (!cur.some((c) => c.path === src!.path)) writeConfig({ captureSources: [...cur, src] })
    refreshWatchers()
    return true
  })
  ipcMain.handle('settings:remove-capture-source', (_e, path: string) => {
    writeConfig({ captureSources: (readConfig().captureSources ?? []).filter((c) => c.path !== path) })
    refreshWatchers()
    return true
  })
  // Review pile of a triage row the sorter proposed something for: a throwaway shows 'bin in N days'.
  const reviewLabel = (r: TriageRow): { pile: string | null; binInDays: number | null } => {
    if (!r.proposal) return { pile: null, binInDays: null }
    const v = pileOf(
      {
        proposal: r.proposal as ProposalLabel,
        proposedAt: r.proposed_at ?? null,
        throwawaySince: r.throwaway_since ?? null,
        decision: r.state && r.state !== 'undecided' ? { state: r.state, decidedAt: r.decided_at ?? null } : null
      },
      Date.now()
    )
    return { pile: v.pile === 'gone' ? null : v.pile, binInDays: v.binInDays }
  }
  // One row → renderable wire shape. Images render from the source file; videos from a cached poster,
  // with mediaUrl pointing at the source file so the renderer can play it inline.
  const triageToWire = (r: TriageRow, sourceRoot: string, wellR: string): Record<string, unknown> => {
    const isVideo = r.kind === 'video'
    const offline = r.offline === '1'
    const fileAbs = join(r.source || sourceRoot, r.rel_path)
    const posterAbs = r.poster_rel ? join(wellR, r.poster_rel) : null
    const sizeBytes = Number(r.size) || 0
    const mtime = Number(r.mtime) || 0
    let date = r.taken_at ? r.taken_at.slice(0, 10) : ''
    if (!date) try {
      date = new Date(mtime).toISOString().slice(0, 10)
    } catch {
      /* bad mtime → no date */
    }
    // Never point a thumbnail/media URL at an online-only placeholder — loading it would force a download.
    return {
      hash: r.hash,
      relPath: join(r.source || sourceRoot, r.rel_path), // unique per file across sources (the hash is the CONTENT hash and repeats for duplicates)
      source: r.source || sourceRoot,
      takenAt: r.taken_at || null,
      app: r.app || null,
      windowTitle: r.window_title || null,
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
      mediaUrl: offline || !isVideo ? null : swThumb(fileAbs),
      ...reviewLabel(r)
    }
  }
  // Triage IPC answers the main window only
  const fromMainWindow = (sender: Electron.WebContents): boolean => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents)
  const onTriageProgress = (m: string): void => void mainWindow?.webContents.send('triage:progress', m)
  guardedHandle(ipcMain, fromMainWindow, 'triage:scan', async () => {
    return scanAllSources()
  })
  // One scan of every capture source, through the one-at-a-time scan queue.
  async function scanAllSources(): Promise<{ ok: boolean; indexed: number; total: number; offline?: number }> {
    const sources = triageSources()
    if (sources.length === 0) return { ok: false, indexed: 0, total: 0 }
    const sum = { indexed: 0, total: 0, offline: 0 }
    try {
      for (const s of sources) {
        const res = await scanTriageSource(archiveRoot(), wellRootResolved(), s.path, onTriageProgress, { namedOnly: s.namedOnly })
        sum.indexed += res.indexed
        sum.total += res.total
        sum.offline += res.offline
      }
      return { ok: true, ...sum }
    } catch {
      return { ok: false, indexed: 0, total: 0 }
    }
  }
  // Capture-and-forget: files added while SlideWell was closed are picked up shortly after launch.
  const launchScan = (): void => {
    setTimeout(() => void scanAllSources().then(() => mainWindow?.webContents.send('triage:changed')), 2500)
  }
  launchScanHook = launchScan
  // Capture inbox: a debounced watcher per source runs the same scan for just that source, then tells
  // the Triage panel to re-list. Originals are only read.
  const watcher = createSourceWatcher((path) => {
    const s = triageSources().find((x) => x.path === path)
    if (!s) return
    void scanTriageSource(archiveRoot(), wellRootResolved(), s.path, onTriageProgress, { namedOnly: s.namedOnly })
      .then(() => mainWindow?.webContents.send('triage:changed'))
      .catch(() => undefined)
  })
  refreshWatchers = (): void => watcher.setSources(triageSources().map((s) => ({ path: s.path, recursive: !s.namedOnly })))
  refreshWatchers()
  app.on('will-quit', () => watcher.close())
  // One-off backlog import (Desktop + CleanShot history → the Triage source folder). After a run,
  // one explicit scan; the import itself never waits on watcher events from the (OneDrive) folder.
  registerBacklogIpc({
    watchedFolder: screenshotRootResolved,
    stateDir: () => join(app.getPath('userData'), 'backlog-import'),
    isMainWindow: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents),
    afterRun: () => void scanAllSources().then(() => mainWindow?.webContents.send('triage:changed'))
  })
  guardedHandle(ipcMain, fromMainWindow, 'triage:list', async (_e, q: string, state: string, sort?: string, limit?: number, offset?: number) => {
    const src = triageSources()[0]?.path ?? null
    const wellR = wellRootResolved()
    const empty = { items: [], counts: { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }, hasMore: false }
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
  guardedHandle(ipcMain, fromMainWindow, 'triage:decide', async (_e, hash: string, action: 'select' | 'exclude' | 'reset', force?: boolean) => {
    const src = triageSources()[0]?.path ?? null
    if (!src) return { state: 'undecided' }
    try {
      return await setTriageDecision(archiveRoot(), wellRootResolved(), src, hash, action, Boolean(force))
    } catch {
      return { state: 'undecided' }
    }
  })
  guardedHandle(ipcMain, fromMainWindow, 'triage:import-selected', async (_e, forceHashes?: string[]) => {
    const src = triageSources()[0]?.path ?? null
    if (!src) return { imported: 0, skipped: 0, gated: 0 }
    try {
      return await importSelectedTriage(archiveRoot(), wellRootResolved(), src, Array.isArray(forceHashes) ? forceHashes : [])
    } catch {
      return { imported: 0, skipped: 0, gated: 0 }
    } finally {
      pictureSearch?.poke()
    }
  })
  // Paste-to-include: read an image off the clipboard and ingest it straight into the well (the paste
  // IS the keep decision, ADR-0029). Returns the new well id or null when the clipboard has no image.
  guardedHandle(ipcMain, fromMainWindow, 'well:add-from-clipboard', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const tmp = join(tmpdir(), `sw-paste-${Date.now()}.png`)
    try {
      writeFileSync(tmp, img.toPNG())
      const res = await ingestScreenshot(archiveRoot(), wellRootResolved(), tmp, 'screenshot')
      if (res) pictureSearch?.poke()
      return res ? { id: res.id } : null
    } catch {
      return null
    }
  })

  // --- R2 backend (spec 2026-06-24): config + credentials (safeStorage) + connection test ---
  ipcMain.handle('settings:get-r2', () => {
    const s = r2Settings()
    return { accountId: s.accountId, endpoint: s.endpoint ?? '', bucket: s.bucket, prefix: s.prefix, hasCreds: Boolean(r2Creds()) }
  })
  ipcMain.handle('settings:set-r2', (_e, patch: { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string }) => {
    const r = { ...(readConfig().r2 ?? {}) }
    if (patch.accountId !== undefined) r.accountId = patch.accountId.trim()
    if (patch.endpoint !== undefined) r.endpoint = patch.endpoint.trim()
    if (patch.bucket !== undefined) r.bucket = patch.bucket.trim()
    if (patch.prefix !== undefined) r.prefix = patch.prefix.trim()
    // Secret is write-only: only update creds when both are supplied; encrypt at rest. Report the
    // truth so the UI can't show a false "saved" (the earlier bug) — and so we can diagnose.
    const gotKeys = Boolean(patch.accessKeyId && patch.secretAccessKey)
    const encAvailable = safeStorage.isEncryptionAvailable()
    let savedCreds = false
    let error: string | undefined
    if (gotKeys) {
      if (!encAvailable) {
        error = 'OS keychain (safeStorage) unavailable'
      } else {
        try {
          r.accessKeyIdEnc = safeStorage.encryptString(patch.accessKeyId as string).toString('base64')
          r.secretEnc = safeStorage.encryptString(patch.secretAccessKey as string).toString('base64')
          savedCreds = true
        } catch (e) {
          error = (e as Error).message
        }
      }
    }
    writeConfig({ r2: r })
    return { ok: true, gotKeys, encAvailable, savedCreds, error }
  })
  ipcMain.handle('settings:test-r2', async () => {
    const creds = r2Creds()
    if (!creds) return { ok: false, error: 'No credentials saved' }
    return testR2(r2Settings(), creds)
  })
  // Per-store backend (Local | R2) + a media sync (upload) to R2.
  ipcMain.handle('settings:get-storage', () => ({
    archive: storeBackend('archive'),
    others: storeBackend('others'),
    well: storeBackend('well')
  }))
  ipcMain.handle('settings:set-store-backend', (_e, store: StoreName, backend: 'local' | 'r2') => {
    const s = { ...(readConfig().storage ?? {}) }
    s[store] = { ...(s[store] ?? {}), backend: backend === 'r2' ? 'r2' : 'local' }
    writeConfig({ storage: s })
    return { ok: true }
  })
  ipcMain.handle('settings:sync-store', async (_e, store: StoreName) => {
    const creds = r2Creds()
    if (!creds) return { ok: false, error: 'No R2 credentials saved' }
    const root = storageRoots()[store]
    if (!root) return { ok: false, error: 'store root not set' }
    const res = await syncDirToR2(r2Settings(), creds, r2Settings().prefix, store, root)
    return { ok: res.failed === 0, ...res }
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
    const r = await runIngest({ engineRoot: archiveRoot(), dataRoot: archiveRoot(), python: python(), mode: 'pending' }, sendLine)
    invalidateDeckMeta(cacheDir())
    pictureSearch?.pokeArchive()
    return r
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
    const r = await runIngest({ engineRoot: archiveRoot(), dataRoot, python: python(), mode: 'path', targetPath }, sendLine)
    invalidateDeckMeta(cacheDir()) // new decks added → drop the cached index so they show without restart
    if (library !== 'others') pictureSearch?.pokeArchive()
    return r
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
  // "My decks" owner names. Unset → computed from the OS account (never written until the user saves).
  ipcMain.handle('settings:get-owner-names', () => resolveOwnerNames(readConfig().ownerNames))
  ipcMain.handle('settings:set-owner-names', (_e, names: unknown) => {
    const cleaned = cleanOwnerNames(names)
    writeConfig({ ownerNames: cleaned.length > 0 ? cleaned : undefined }) // empty → back to the account default
    const resolved = resolveOwnerNames(readConfig().ownerNames)
    setOwnerNames(resolved.names) // ownership is part of the deck index → next load rescans
    return resolved
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

  // Delete-by-filter (ADR-0031): remove every Others' Library deck matching the current query +
  // filters, then rebuild the index from what remains. No filter → deletes the whole library.
  // Scoped to the Others' Library only — never the personal archive.
  ipcMain.handle('others:delete-matching', async (_e, query: string, filters: SearchFilters) => {
    const root = othersArchiveRootResolved()
    if (!othersArchiveAvailable()) return { ok: false, deleted: 0 }
    const f: SearchFilters = { ...filters, owner: 'all', library: 'others' }
    // Decks matching the deck-level filters; narrowed to those with matching content when there's free text.
    const ids = new Set<string>()
    try {
      for (const d of await listDecks(root, cacheDir(), f)) ids.add(d.id)
    } catch {
      /* none */
    }
    const q = (query ?? '').trim()
    if (q.length >= 2 && ids.size) {
      const hit = new Set<string>()
      try {
        for (const c of await archiveResults(root, cacheDir(), q, f)) {
          if (c.representative.deck) hit.add(c.representative.deck)
          for (const m of c.members) if (m.deck) hit.add(m.deck)
        }
      } catch {
        /* none */
      }
      try {
        for (const im of await searchImages(root, q, 1000)) if (im.deck) hit.add(im.deck)
      } catch {
        /* none */
      }
      for (const id of [...ids]) if (!hit.has(id)) ids.delete(id)
    }
    const idList = [...ids].filter(Boolean)
    if (idList.length === 0) return { ok: false, deleted: 0 }
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', `Delete ${idList.length}`],
      defaultId: 0,
      cancelId: 0,
      message: `Delete ${idList.length} presentation${idList.length === 1 ? '' : 's'} from your Others' Library?`,
      detail: 'Removed from this separate store only — your own archive and the source files are untouched.'
    })
    if (res.response !== 1) return { ok: false, cancelled: true }
    for (const id of idList) {
      try {
        rmSync(join(root, 'extracted', id), { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
    // Rebuild the index from what's left (registry/media-store are derived, so wipe + reindex).
    try {
      rmSync(join(root, 'registry'), { recursive: true, force: true })
    } catch {
      /* */
    }
    try {
      rmSync(join(root, 'media-store'), { recursive: true, force: true })
    } catch {
      /* */
    }
    let remaining = 0
    try {
      remaining = readdirSync(join(root, 'extracted')).length
    } catch {
      remaining = 0
    }
    if (remaining > 0 && archiveAvailable()) {
      await runIngest({ engineRoot: archiveRoot(), dataRoot: root, python: python(), mode: 'reindex' }, sendConvertLine)
    }
    invalidateDeckMeta(cacheDir()) // the deck set changed; drop the cached index so search reflects it
    return { ok: true, deleted: idList.length }
  })

  void startWell().finally(() => pictureSearch?.start())
  createWindow().webContents.once('did-finish-load', () => launchScanHook())

  app.on('activate', () => {
    // not getAllWindows(): the hidden picture-search window would keep that non-empty
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

// On launch: ensure the well exists, drain anything Raycast dropped while we were closed, index
// new TalkWeaver vault images, and watch the inbox so future drops ingest live.
// Which talks use which picture; filled from well.db at launch and refreshed by each talk scan.
// Vault switches and scans run through one serial queue (talk-usage-service.ts); a failed scan keeps
// the previous snapshot, and a well.db the containment check refuses keeps the feature off.
const talkUsage = createTalkUsageService({
  wellRoot: wellRootResolved,
  vaultRoot: detectVaultRoot,
  // only talk outlines, folders and pool images appearing or going; wait at most 30 s however busy the vault is
  watch: (vault, onChange) => {
    const w = createSourceWatcher(() => onChange(), 4000, 30000)
    w.setSources([{ path: vault, recursive: true, accept: isVaultChangeRelevant }])
    return w
  },
  notify: (r) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('talks:usage-changed', r)
  },
  log: (m) => console.warn(m)
})

async function startWell(): Promise<void> {
  try {
    const root = wellRootResolved()
    await ensureWell(root)
    await drainInbox(archiveRoot(), root)
    const vr = detectVaultRoot()
    if (vr) {
      void scanVault(archiveRoot(), root, vr).then((n) => n > 0 && pictureSearch?.poke(), () => undefined)
    }
    // read-only scan of the vault's talks on launch and whenever the vault changes
    await talkUsage.sync()
    const inbox = join(root, '_inbox')
    let busy = false
    fsWatch(inbox, async () => {
      if (busy) return
      busy = true
      setTimeout(async () => {
        try {
          if ((await drainInbox(archiveRoot(), root)) > 0) pictureSearch?.poke()
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

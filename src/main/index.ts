import { app, BrowserWindow, ipcMain, dialog, protocol, shell, net, safeStorage, powerMonitor } from 'electron'
import { join, basename } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch as fsWatch } from 'fs'
import { pathToFileURL } from 'url'
import { resolve as resolvePath, sep as pathSep } from 'path'
import { startSettings, type SaveResult, type SettingsApp } from './settings-host'
import { CONFIG_UNREADABLE, ConfigReadError, patchConfigFile, readConfigFile, saveConfigParts } from './config-file'
import { ARCHIVE_DEFAULT, OTHERS_DEFAULT } from './settings-rules'
import { keySlots } from './key-slots'
import { legacyFromPrefs, splitLegacyPatch } from '../shared/settings-schema'
import { saveR2 } from './r2-save'
import { MAIN_COMMANDS, registry, type CommandContext } from '../shared/commands'
import { setOwnerNames } from './deckmeta'
import { resolveOwnerNames } from './owners'
import { ensureWell, drainInbox, INBOX_SETTLE_MS, scanVault, findFfmpeg } from './well'
import { createSourceWatcher } from './source-watcher'
import { isVaultChangeRelevant } from './talk-usage'
import { createTalkUsageService } from './talk-usage-service'
import { detectPython, findRenderTools } from './ingest'
import { testR2, type R2Settings, type R2Creds } from './r2'
import { pickStore, keyForPath, fetchFromR2, syncDirToR2, type StoreName } from './storage'
import { PictureSearchService, registerPictureSearchIpc, type PictureSearchSettings } from './picture-search/service'
import { startPictureQueryServer, PICTURE_QUERY_SOCKET, type QueryServer } from './picture-search/query-socket'
import { WebGpuEmbedder } from './picture-search/webgpu-embedder'
import { electronEmbedHost, registerEmbedProtocol, EMBED_SCHEME } from './picture-search/electron-embed-host'
import { modelDir as pictureModelDir } from './picture-search/model-store'
import { SorterService, changePeriod, cloudGates, registerSorterIpc, type LocalRunSummary, type TrainResult } from './sorter/service'
import createTrainWorker from './sorter/train-worker?nodeWorker'
import type { Job, JobResult } from './sorter/jobs'
import type { FetchLike } from './picture-search/model-store'
import { registerGoesByAndRunsIpc } from './sorter/goes-by-and-runs-ipc'
import { SortRuns } from './sorter/runs'
import { Retrainer } from './sorter/retrain'
import { LearningCurve } from './sorter/learning'
import { registerTeachIpc } from './sorter/teach-ipc'
import { whyReader } from './sorter/why'
import type { SorterLearning, SorterRetrain } from '../preload'
import type { AppRule } from './sorter/app-rules'
import { ReviewService } from './review/service'
import { registerReviewIpc } from './review/ipc'
import { decodeSwUrlPath as decodeSwPath, resolveSwUrlReal as resolveSwReal, serveSwFile, swUrlOf } from './swarchive-guard'
import { CloudSorter, KEY_FIELD, normaliseCloudSettings, registerCloudIpc, saveCloudKey, removeCloudKey, type CloudRunSummary, type CloudSettings, type StoredCloudSettings } from './sorter/cloud/service'
import { ApiKeyStore } from './sorter/cloud/key-store'
import { shrinkForLuna } from './sorter/cloud/images'
import type { HttpPost } from './sorter/cloud/client'
import { PROVIDERS } from './sorter/cloud/provider'

import { install as installArchiveSearch } from './archive-search-ipc'
import { install as installArchiveStreams } from './archive-streams-ipc'
import { createCaptureSources, type CaptureSource } from './capture-sources-ipc'
import { install as installOthersLibrary } from './others-library-ipc'

const REQUIREMENTS_URL = 'https://github.com/techczech/slidewell/blob/main/REQUIREMENTS.md'

// Test-only: SLIDEWELL_E2E_HIDDEN=1 keeps automated runs in the background (no window shown, no
// Dock icon, nothing takes focus). Honoured only when set to exactly '1'; unset changes nothing.
const E2E_HIDDEN = process.env['SLIDEWELL_E2E_HIDDEN'] === '1'
// Tests and the settings CLI can point the app at a throwaway data folder (the CLI reads the same variable).
if (process.env['SLIDEWELL_DATA_DIR']) app.setPath('userData', process.env['SLIDEWELL_DATA_DIR'])
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
  // sorter cloud step (tickets 07, 16): each provider's key only as safeStorage ciphertext (keyEnc = OpenAI,
  // anthropicKeyEnc = Anthropic), never in plain text; provider = which one is asked (absent = OpenAI);
  // optedInAt / anthropicOptedInAt = when he agreed to that provider (absent = not agreed, so off);
  // enabled = the service on or off (absent = on whenever the selected provider is agreed to, as before it was
  // stored; off keeps provider, keys and agreements); nightly / secondOpinions = the two switches (absent = on,
  // anything but true = off; sorter/cloud/settings.ts); the per-night limit is fixed in code
  sorterCloud?: StoredCloudSettings & { keyEnc?: string; anthropicKeyEnc?: string; lastRunAt?: string | null; since?: string | null; lastRun?: CloudRunSummary | null }
  // the period both sort buttons in Settings are limited to: '7d' | '30d' | '90d' | 'all' (sorter/period.ts);
  // absent = everything; present with anything else (null included) = unreadable, and no manual sort runs
  // (period.ts storedPeriod). Only main reads it and works out the cut-off; the nightly sort ignores it
  sorterPeriod?: string
  // the last sort on this Mac as numbers (sorter/service.ts storedLocalRun reads it; anything else = none)
  sorterLastRun?: LocalRunSummary
  // his per-app rules for the sorter: usually keep / usually throw away, by app name (sorter/app-rules.ts
  // storedAppRules reads them; anything else = no rule). Kept here, never in the rebuildable triage index
  sorterAppRules?: AppRule[]
  // teaching the sorter (ticket 22; sorter/retrain.ts): retrain by itself after every ten answers (absent = on;
  // only false = off), and also while on battery (absent = no; only true = yes)
  sorterAutoRetrain?: boolean
  sorterAutoRetrainOnBattery?: boolean
  // the last retrain and what it moved (retrain.ts storedRetrain reads it; anything else = none)
  sorterLastRetrain?: SorterRetrain
  // the "how much is enough" reading for one training (learning.ts storedLearning reads it; anything else = none)
  sorterLearning?: { key: string; learning: SorterLearning }
  // "Leave screenshots that are not on this Mac out of Review and sorting until they are downloaded" (Review's Not on this
  // Mac view): only true = on; absent or anything else = off. Read by the review service and by a sort on this Mac
  reviewLeaveOutNotOnMac?: boolean
  pythonPath?: string
  windowBounds?: { width: number; height: number }
}
// The preferences moved to the shared settings file (settings-host.ts, shared/settings-schema.ts). Readers
// here still see config.json's old shape: readConfig() lays the current settings over config.json, and
// writeConfig() sends preference fields to the settings store (who: you) and the rest to config.json.
// Until the settings start, and when the move could not be made safely, config.json is read as before.
let settings: SettingsApp | null = null
let prefsInStore = false
function rawConfig(): Config | null {
  try {
    return readConfigFile<Config>(app.getPath('userData')) ?? {}
  } catch (error) {
    if (error instanceof ConfigReadError) return null
    throw error
  }
}
function readConfig(): Config {
  // Shared preferences remain available. Writes to config.json refuse an unreadable file.
  const raw = rawConfig() ?? {}
  if (!settings || !prefsInStore) return raw
  const p = legacyFromPrefs(settings.values())
  return {
    ...raw,
    ...p,
    r2: { ...(raw.r2 ?? {}), ...p.r2 },
    pictureSearch: { ...(raw.pictureSearch ?? {}), ...p.pictureSearch }
  }
}
/**
 * Resolves once every preference in `patch` reached the settings file (or config.json); a failure is returned,
 * never thrown. Callers that only fire and forget may ignore it: a failure is logged by the settings host.
 */
function writeConfig(patch: Partial<Config>): Promise<SaveResult> {
  const s = prefsInStore ? settings : null
  const split = s ? splitLegacyPatch(patch as Record<string, unknown>) : null
  return saveConfigParts<SaveResult>(() => {
    try {
      if (!split) writeRawConfig(patch)
      else if (Object.keys(split.rest).length > 0) {
        writeRawConfig((raw) => {
          const rest: Partial<Config> = { ...split.rest }
          // Preserve the older version's own preferences alongside nested app state.
          if (rest.r2 && raw.r2) rest.r2 = { ...pickLegacy(raw.r2, ['accountId', 'endpoint', 'bucket', 'prefix']), ...rest.r2 }
          if (rest.pictureSearch && raw.pictureSearch) rest.pictureSearch = { ...pickLegacy(raw.pictureSearch, ['includeWell']), ...rest.pictureSearch }
          return rest
        })
      }
      return { ok: true }
    } catch (error) {
      if (error instanceof ConfigReadError) return { ok: false, error: CONFIG_UNREADABLE }
      console.warn('[config] Saved state could not be written.')
      return { ok: false, error: 'SlideWell could not save your settings.' }
    }
  }, async () => {
    if (!s || !split) return { ok: true }
    const results = await Promise.all(Object.entries(split.prefs).map(([key, value]) => s.set(key, value)))
    return results.find((result) => !result.ok) ?? { ok: true }
  })
}
/** Writes state fields (and key ciphertext) without replacing other fields or using a fallback read. */
function writeRawConfig(patch: Partial<Config> | ((current: Config) => Partial<Config>)): void {
  patchConfigFile<Config>(app.getPath('userData'), (current = {}) => ({
    ...current,
    ...(typeof patch === 'function' ? patch(current) : patch)
  }))
}
function pickLegacy<T extends object>(o: T, keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k))) as Partial<T>
}

/**
 * The main window or the Settings window (whose custom pages use the app's own IPC); nothing else. The Settings
 * window is judged by the whole event (its own page in its top frame), as the shared package judges its own IPC.
 */
function fromAppWindow(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  if (mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents) return true
  return Boolean(settings?.isSettingsSender(e))
}
/**
 * ipcMain.handle answered only for the main window or the Settings window (fromAppWindow): the Settings window
 * carries the app's whole bridge, so every handler it can reach checks the event, never only the channel.
 */
function appHandle(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromAppWindow(e)) throw new Error(`${channel}: not allowed from this window`)
    return fn(e, ...args)
  })
}
/** Sends a status push to the main window and an open Settings window. */
function toAppWindows(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  settings?.settingsWebContents()?.send(channel, payload)
}

// Core A (ppt-archive) is the engine SlideWell sits on. Default to its conventional location;
// the user can repoint it in Settings. The archive is "present" when its registry/ exists.
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

const { captureDefaults, triageSources, install: installCaptureSources } = createCaptureSources({ readConfig, screenshotRootResolved })

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
let refreshWatchers: () => void = () => undefined
// The Triage folder the watcher was last pointed at, so a settings change elsewhere re-points it (settings `changed`).
let lastWatchedRoot = ''

function openMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
}

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
// (swarchive-guard.ts: the encoding and both checks)
function swThumb(abs: string | null): string | null {
  return swUrlOf(abs)
}
function within(root: string, target: string): boolean {
  const r = resolvePath(root) + pathSep
  return resolvePath(target).startsWith(r)
}
/** Decode a swarchive://f/<b64> URL to a path written under an allowed root (may not exist locally), or null. */
function decodeSwUrlPath(url: string): string | null {
  return decodeSwPath(url, allowedRoots())
}
/** The file a swarchive URL names, existing here, with its real path (symlinks followed) under an allowed root's real path; else null (copy, reveal). */
function resolveSwUrlReal(url: string): string | null {
  return resolveSwReal(url, allowedRoots())
}

// Per-store backend (spec 2026-06-24): which store a path is in, and its backend.
function storageRoots(): Partial<Record<StoreName, string>> {
  return { archive: archiveRoot(), others: othersArchiveRootResolved(), well: wellRootResolved() }
}
function storeBackend(store: StoreName): 'local' | 'r2' {
  return readConfig().storage?.[store]?.backend === 'r2' ? 'r2' : 'local'
}
// How to fetch a swarchive path that is not here: for an R2-backed store with credentials, from R2 into the
// local store dir (which doubles as the cache); else null. swarchive-guard.ts serveSwFile decides whether it may
// write there at all (real path of the nearest existing folder under an allowed root); fetchFromR2 re-checks the
// folder after the download and renames the bytes into place, so a link planted meanwhile is replaced, not
// written through. Never deletes anything.
function r2FetcherFor(abs: string): ((dest: string) => Promise<boolean>) | null {
  const s = pickStore(storageRoots(), abs)
  if (!s || storeBackend(s.store) !== 'r2') return null
  const creds = r2Creds()
  if (!creds) return null
  return (dest) => fetchFromR2(r2Settings(), creds, keyForPath(r2Settings().prefix, s.store, s.root, dest), dest, allowedRoots())
}

// One SlideWell per profile: a second launch focuses the open window and quits, so two processes never
// run the nightly cloud batch (or any other writer) side by side. The cloud batch also claims its
// screenshots in one database transaction (sorter/store.ts claimForCloud) as a second guard.
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
else
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

app.whenReady().then(async () => {
  if (!singleInstance) return
  // --- shared settings (settings-host.ts): store + migration from config.json, Settings window, menu bar, key slots ---
  // The cloud step's two keys are wired once the cloud service exists (below); until then they read as missing.
  let cloudKeyOps: { has(p: 'openai' | 'anthropic'): boolean; set(p: 'openai' | 'anthropic', k: string): { ok: boolean; error?: string; shape?: boolean }; remove(p: 'openai' | 'anthropic'): void } | null = null
  const r2Key = (field: 'accessKeyIdEnc' | 'secretEnc', label: string) => ({
    label,
    has: () => Boolean(rawConfig()?.r2?.[field]),
    set(value: string) {
      if (!value || value.length > 512 || !safeStorage.isEncryptionAvailable()) return { ok: false }
      writeRawConfig((current) => ({ r2: { ...current.r2, [field]: safeStorage.encryptString(value).toString('base64') } }))
      return { ok: true }
    },
    remove() {
      writeRawConfig((current) => {
        const { [field]: _gone, ...rest } = current.r2 ?? {}
        return { r2: rest }
      })
    }
  })
  const cloudKey = (p: 'openai' | 'anthropic', label: string) => ({
    label,
    has: () => cloudKeyOps?.has(p) ?? false,
    set: (value: string) => cloudKeyOps?.set(p, value) ?? { ok: false },
    remove: () => cloudKeyOps?.remove(p)
  })
  const started = await startSettings({
    openMain,
    sendCommand: (id) => mainWindow?.webContents.send('app:command', id),
    changed: () => {
      setOwnerNames(resolveOwnerNames(readConfig().ownerNames).names)
      // the Triage folder changed from the window, the CLI or an import: the watcher follows it at once
      const watched = readConfig().screenshotRoot ?? ''
      if (watched !== lastWatchedRoot) {
        lastWatchedRoot = watched
        refreshWatchers()
      }
      mainWindow?.webContents.send('app:settings-changed', settings?.bindings() ?? {})
    },
    slots: keySlots(
      {
        'storage.r2AccessKeyId': r2Key('accessKeyIdEnc', 'R2 access key ID'),
        'storage.r2SecretAccessKey': r2Key('secretEnc', 'R2 secret access key'),
        'sorting.openaiKey': cloudKey('openai', 'OpenAI key'),
        'sorting.anthropicKey': cloudKey('anthropic', 'Anthropic key')
      },
      () => safeStorage.isEncryptionAvailable()
    ),
    log: (line) => console.warn(line)
  })
  settings = started.settings
  prefsInStore = !started.legacy
  lastWatchedRoot = readConfig().screenshotRoot ?? ''
  app.on('will-quit', () => settings?.dispose())
  ipcMain.handle('app:bindings', (e) => (fromAppWindow(e) ? (settings?.bindings() ?? {}) : {}))
  ipcMain.handle('app:run-command', (e, id: unknown) => {
    if (fromAppWindow(e) && typeof id === 'string' && MAIN_COMMANDS.has(id)) settings?.runMainCommand(id)
  })
  ipcMain.handle('app:show-in-main', (e, id: unknown) => {
    if (!fromAppWindow(e) || typeof id !== 'string' || !registry.byId(id) || MAIN_COMMANDS.has(id)) return
    openMain()
    mainWindow?.webContents.send('app:command', id)
  })
  ipcMain.handle('app:open-settings-at', (e, section: unknown) => {
    if (fromAppWindow(e)) settings?.openSettings(typeof section === 'string' ? section : undefined)
  })
  ipcMain.handle('app:set-context', (e, c: Partial<CommandContext> | null) => {
    if (!fromAppWindow(e)) return
    const view = c?.view === 'review' || c?.view === 'triage' ? c.view : 'search'
    settings?.setContext({ view, hasItems: c?.hasItems === true, hasActive: c?.hasActive === true })
  })

  protocol.handle('swarchive', async (request) => {
    const abs = decodeSwUrlPath(request.url)
    // a fetch from R2 writes only under an allowed root's real path, and the file served passes the real-path check:
    // a link inside a root that leads outside every root is neither written through nor served
    const served = abs ? await serveSwFile(abs, allowedRoots(), existsSync(abs) ? null : r2FetcherFor(abs)) : null
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
      toAppWindows('picture:status', st)
    }
  })
  // picture IPC answers the main window only (never the hidden picture-search window)
  registerPictureSearchIpc(pictureSearch, fromAppWindow)
  app.on('will-quit', () => pictureSearch?.dispose())

  // --- local picture query for TalkWeaver (picture-search/query-socket.ts, contract v1) ---
  // A Unix socket in the user-data folder, 0600 in a 0700 folder: this user only, no network.
  // Ids and scores only; no query text is logged. Closed and unlinked on quit.
  let pictureQueryServer: QueryServer | null = null
  let quitting = false
  // open the index here, so outside queries only read; a broken index leaves the endpoint unavailable
  const prepared = pictureSearch.prepareForQueries()
  if (!prepared.ok) console.warn(`picture query endpoint unavailable: ${prepared.reason}`)
  void startPictureQueryServer({
    socketPath: join(app.getPath('userData'), PICTURE_QUERY_SOCKET),
    engine: pictureSearch.queryEndpoint(),
    log: (msg) => console.warn(msg)
  }).then((res) => {
    if (!res.ok) return console.warn(`picture query endpoint not started: ${res.reason}`)
    if (quitting) void res.server.close()
    else pictureQueryServer = res.server
  })
  app.on('will-quit', () => {
    quitting = true
    void pictureQueryServer?.close()
  })

  // --- screenshot sorter, local part (sorter/service.ts): proposals only, never decisions or moves ---
  const pics = pictureSearch
  // grouping and fitting run in a worker thread (sorter/train-worker.ts); the main process stays responsive
  const runTrainJob = <J extends Job>(job: J, signal: AbortSignal): Promise<JobResult<J>> =>
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
      })
  const sorter: SorterService = new SorterService({
    wellRoot: wellRootResolved,
    pictures: { modelReady: () => pics.modelReady(), ensureVectors: (items, opts) => pics.ensureVectors(items, opts) },
    runJob: runTrainJob,
    broadcast: (st) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sorter:status', st)
      retrainer.sorterStatus(st.phase) // a retrain that waited for a sort to end
    },
    period: () => readConfig().sorterPeriod,
    lastRun: () => readConfig().sorterLastRun,
    saveLastRun: (r) => writeConfig({ sorterLastRun: r }),
    appRules: () => readConfig().sorterAppRules,
    teach: (c) => retrainer.status(c),
    skipNotOnMac: () => readConfig().reviewLeaveOutNotOnMac === true
  })
  // --- teaching the sorter (ticket 22; sorter/retrain.ts): one retrain routine for Train, the end of a round and
  // the retrain by itself after ten answers. It trains, tests and re-scores existing proposals of undecided
  // screenshots; it makes no sort run, writes no decision and asks no cloud model ---
  const retrainer: Retrainer<TrainResult> = new Retrainer<TrainResult>({
    train: () => sorter.trainAndTest({ rescore: true }),
    choices: () => sorter.choices(),
    changed: () => sorter.push(),
    power: { onBattery: () => powerMonitor.isOnBatteryPower(), onAc: (cb) => void powerMonitor.on('on-ac', cb) },
    settings: () => ({ enabled: readConfig().sorterAutoRetrain, onBattery: readConfig().sorterAutoRetrainOnBattery }),
    saveSettings: (s) => writeConfig({ sorterAutoRetrain: s.enabled, sorterAutoRetrainOnBattery: s.onBattery }),
    lastRetrain: () => readConfig().sorterLastRetrain,
    saveLastRetrain: (r) => writeConfig({ sorterLastRetrain: r })
  })
  // "how much is enough": several trainings in the same worker, only when asked for, kept per training
  const learning = new LearningCurve({
    wellRoot: wellRootResolved,
    pictures: { modelReady: () => pics.modelReady(), ensureVectors: (items, opts) => pics.ensureVectors(items, opts) },
    runJob: runTrainJob,
    appRules: () => readConfig().sorterAppRules,
    training: () => {
      const r = sorter.status().report
      return r ? { id: r.trainedAt, trainedAt: r.trainedAt } : null
    },
    stored: () => readConfig().sorterLearning,
    save: (r) => writeConfig({ sorterLearning: r })
  })
  // answers that were already waiting when the app was last quit (say, on battery) are counted once, shortly after launch
  const retrainFirst = setTimeout(() => retrainer.noteAnswer(), 45_000)
  app.on('will-quit', () => {
    clearTimeout(retrainFirst)
    learning.cancel()
  })
  // the period is one setting for both sort buttons: a change drops the cloud step's prepared batch and both sections are told
  registerSorterIpc(sorter, (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents), (period) =>
    changePeriod(period, () => readConfig().sorterPeriod, (p) => writeConfig({ sorterPeriod: p }), () => {
      cloud.periodChanged()
      sorter.notify()
    }),
    () => retrainer.retrain('manual')
  )
  app.on('will-quit', () => sorter.cancel())

  // --- screenshot sorter, cloud step (sorter/cloud/service.ts): Luna or Haiku for the doubtful ones, nightly + Sort now ---
  // Each provider's key is stored like the R2 credentials: safeStorage ciphertext in config.json, never returned or
  // logged. One store per provider, each with its own field, and no other source: no environment variable is read.
  const cloudCfg = (): NonNullable<Config['sorterCloud']> => readConfig().sorterCloud ?? {}
  const saveCloudCfg = (patch: Partial<NonNullable<Config['sorterCloud']>>): void =>
    writeRawConfig((current) => ({ sorterCloud: { ...current.sorterCloud, ...patch } }))
  const keychain = { available: () => safeStorage.isEncryptionAvailable(), encrypt: (k: string) => safeStorage.encryptString(k), decrypt: (b: Buffer) => safeStorage.decryptString(b) }
  const cloudKeys = {
    openai: new ApiKeyStore(() => cloudCfg()[KEY_FIELD.openai], (enc) => saveCloudCfg({ [KEY_FIELD.openai]: enc }), keychain, PROVIDERS.openai.keyRule),
    anthropic: new ApiKeyStore(() => cloudCfg()[KEY_FIELD.anthropic], (enc) => saveCloudCfg({ [KEY_FIELD.anthropic]: enc }), keychain, PROVIDERS.anthropic.keyRule)
  }
  // redirect 'error': a request carries a key and pictures, and is never followed to another address
  const cloudHttp: HttpPost = (url, init) => net.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: init.redirect })
  const cloudSettings = (): CloudSettings => normaliseCloudSettings(cloudCfg())
  const cloud = new CloudSorter({
    wellRoot: wellRootResolved,
    sortLocal: (window, trigger) => sorter.sortUndecided({ window, trigger }),
    period: () => readConfig().sorterPeriod,
    ...cloudGates(sorter),
    keys: cloudKeys,
    online: () => net.isOnline(),
    http: cloudHttp,
    shrink: (bytes) => shrinkForLuna(bytes),
    settings: cloudSettings,
    state: () => {
      const c = cloudCfg()
      return { lastRunAt: c.lastRunAt ?? null, since: c.since ?? null, lastRun: c.lastRun ?? null }
    },
    saveState: (patch) => saveCloudCfg(patch),
    broadcast: (st) => {
      toAppWindows('cloud:status', st)
    },
    // consent is main's own native dialog, raised on the main window; no window, no consent
    confirm: async (p) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const r = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['Cancel', p.confirmLabel], defaultId: 1, cancelId: 0, noLink: true, message: p.message, detail: p.detail })
      return r.response === 1
    },
    log: (line) => console.warn(line)
  })
  registerCloudIpc(cloud, cloudKeys, (s) => saveCloudCfg(s), () => cloudCfg(), fromAppWindow)
  // Settings › Accounts and keys: the same save and remove as the cloud IPC (removing withdraws the agreement)
  cloudKeyOps = {
    has: (p) => Boolean(cloudCfg()[KEY_FIELD[p]]),
    set: (p, k) => saveCloudKey(cloud, cloudKeys, p, k),
    remove: (p) => removeCloudKey(cloud, (s) => saveCloudCfg(s), () => cloudCfg(), p)
  }
  settings?.slotsChanged()
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
    allowedRoots,
    changed: () => {
      pictureSearch?.poke()
      mainWindow?.webContents.send('triage:changed')
      retrainer.noteAnswer() // a Review or teaching answer is one more choice to learn from
    },
    // stored embeddings only (the look-alike seam reads the index and embeds nothing)
    why: whyReader({ wellRoot: wellRootResolved, storedVectors: (ids) => pics.lookAlikeInputs(ids).vectors }),
    // blind answers put back (review/rescue.ts): a retrain like Retrain now, so the strip reports what changed;
    // one already running may hold the old answers, so a fresh one follows it rather than joining it
    retrain: () => retrainer.retrainAfterChange('manual'),
    // Not on this Mac (review/download.ts): the switch, the progress of Download them, and files that came down
    leaveOutNotOnMac: () => readConfig().reviewLeaveOutNotOnMac === true,
    saveLeaveOutNotOnMac: (on) => writeConfig({ reviewLeaveOutNotOnMac: on }),
    downloadProgress: (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('review:download-progress', p)
    },
    downloaded: () => {
      pictureSearch?.poke()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('triage:changed')
    }
  })
  registerReviewIpc(review, (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents))
  registerTeachIpc({
    allowed: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents),
    teachQueue: (after, limit) => review.teachQueue(after, limit),
    learning: () => learning.read(),
    retrain: (trigger) => retrainer.retrain(trigger),
    setAuto: (patch) => retrainer.setAuto(patch)
  })

  // --- what the sorter goes by (his per-app rules, in config) and the piles of each sort (sorter/runs.ts): reads, plus the one config write ---
  registerGoesByAndRunsIpc({
    allowed: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents),
    wellRoot: wellRootResolved,
    appRules: () => readConfig().sorterAppRules,
    saveAppRules: (rules) => writeConfig({ sorterAppRules: rules }),
    runs: new SortRuns({ wellRoot: wellRootResolved, sourceRoot: () => triageSources()[0]?.path ?? null, thumbUrl: swThumb, allowedRoots })
  })

  // --- IPC: the typed contract lives in src/preload/index.ts ---
  appHandle('archive:available', () => archiveAvailable())
  appHandle('settings:config-problem', () => rawConfig() === null ? CONFIG_UNREADABLE : null)
  appHandle('settings:get-paths', async () => ({
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
  appHandle('settings:choose-archive', async () => {
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
  appHandle('shell:open-path', (_e, p: string) => shell.openPath(p).then((err) => err === ''))
  appHandle('shell:open-external', (_e, url: string) => shell.openExternal(url).then(() => true))

  // Detected status of the external tools SlideWell leans on — surfaced in Settings so users know
  // what to install. `required` deps gate core features; the rest degrade gracefully when absent.
  appHandle('settings:dependencies', () => {
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

  const cacheDir = (): string => app.getPath('userData')
  setOwnerNames(resolveOwnerNames(readConfig().ownerNames).names)
  installArchiveSearch({
    appHandle, archiveRoot, archiveAvailable, othersArchiveRootResolved, othersArchiveAvailable,
    wellRootResolved, detectVaultRoot, cacheDir, swThumb, resolveSwUrlReal, pictureSearch, talkUsage
  })

  // --- well / import paths ---
  appHandle('settings:choose-vault', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ vaultRoot: r.filePaths[0] })
    void talkUsage.sync()
    return r.filePaths[0]
  })
  // Re-scan the TalkWeaver vault for new images and index them; returns count added.
  appHandle('well:scan-vault', async () => {
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

  const capture = installCaptureSources({
    appHandle, getMainWindow: () => mainWindow,
    fromMainWindow: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents),
    fromAppWindow, archiveRoot, wellRootResolved, writeConfig, swThumb, pictureSearch, review, retrainer
  })
  refreshWatchers = capture.refreshWatchers

  // --- R2 backend (spec 2026-06-24): config + credentials (safeStorage) + connection test ---
  appHandle('settings:get-r2', () => {
    const s = r2Settings()
    return { accountId: s.accountId, endpoint: s.endpoint ?? '', bucket: s.bucket, prefix: s.prefix, hasCreds: Boolean(r2Creds()) }
  })
  // The endpoint, bucket and account (settings.json) and the key ciphertext (config.json) describe one connection, so
  // they change together or not at all (r2-save.ts). Report the truth so the UI can't show a false "saved".
  appHandle('settings:set-r2', (_e, patch: unknown) =>
    saveR2(patch, {
      encAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      snapshot: (fields) => {
        const r = readConfig().r2 ?? {}
        return Object.fromEntries(fields.map((f) => [f, r[f]]))
      },
      async writePrefs(prefs) {
        if (settings && prefsInStore) return writeConfig({ r2: prefs })
        try {
          writeRawConfig((current) => ({ r2: { ...current.r2, ...prefs } })) // preferences still in config.json
          return { ok: true }
        } catch (e) {
          return { ok: false, error: `The R2 settings were not saved (${(e as NodeJS.ErrnoException)?.code ?? 'error'}).` }
        }
      },
      writeCiphertext: (enc) => writeRawConfig((current) => ({ r2: { ...current.r2, ...enc } }))
    })
  )
  appHandle('settings:test-r2', async () => {
    const creds = r2Creds()
    if (!creds) return { ok: false, error: 'No credentials saved' }
    return testR2(r2Settings(), creds)
  })
  // Per-store backend (Local | R2) + a media sync (upload) to R2.
  appHandle('settings:get-storage', () => ({
    archive: storeBackend('archive'),
    others: storeBackend('others'),
    well: storeBackend('well')
  }))
  appHandle('settings:set-store-backend', (_e, store: StoreName, backend: 'local' | 'r2') => {
    const s = { ...(readConfig().storage ?? {}) }
    s[store] = { ...(s[store] ?? {}), backend: backend === 'r2' ? 'r2' : 'local' }
    writeConfig({ storage: s })
    return { ok: true }
  })
  appHandle('settings:sync-store', async (_e, store: StoreName) => {
    const creds = r2Creds()
    if (!creds) return { ok: false, error: 'No R2 credentials saved' }
    const root = storageRoots()[store]
    if (!root) return { ok: false, error: 'store root not set' }
    const res = await syncDirToR2(r2Settings(), creds, r2Settings().prefix, store, root)
    return { ok: res.failed === 0, ...res }
  })

  const python = (): string => detectPython(readConfig().pythonPath)
  const sendConvertLine = (line: string): void => mainWindow?.webContents.send('convert:line', line)
  installOthersLibrary({
    appHandle, dialog, archiveRoot, archiveAvailable, othersArchiveRootResolved, othersArchiveAvailable,
    readConfig, writeConfig, cacheDir, python, sendConvertLine
  })
  installArchiveStreams({
    appHandle, archiveRoot, archiveAvailable, othersArchiveRootResolved, conversionsRootResolved,
    readConfig, writeConfig, cacheDir, python, pictureSearch, sendConvertLine,
    sendLine: (line) => mainWindow?.webContents.send('ingest:line', line)
  })

  void startWell().finally(() => pictureSearch?.start())
  createWindow().webContents.once('did-finish-load', () => capture.launchScan())

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
    const inbox = join(root, '_inbox')
    let timer: ReturnType<typeof setTimeout> | undefined
    let busy = false
    let retry = false
    let closed = false
    const schedule = (): void => {
      if (closed) return
      if (busy) {
        retry = true
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => void drain(), INBOX_SETTLE_MS)
    }
    const drain = async (): Promise<void> => {
      busy = true
      try {
        if ((await drainInbox(archiveRoot(), root, schedule)) > 0) pictureSearch?.poke()
      } catch {
        /* leave the inbox for the next pass */
      } finally {
        busy = false
        if (retry) {
          retry = false
          schedule()
        }
      }
    }
    const watcher = fsWatch(inbox, schedule)
    app.once('will-quit', () => {
      closed = true
      watcher.close()
      clearTimeout(timer)
    })
    await drain()
    const vr = detectVaultRoot()
    if (vr) {
      void scanVault(archiveRoot(), root, vr).then((n) => n > 0 && pictureSearch?.poke(), () => undefined)
    }
    // read-only scan of the vault's talks on launch and whenever the vault changes
    await talkUsage.sync()
  } catch {
    /* well unavailable (e.g. archive root missing) — search just shows no well results */
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

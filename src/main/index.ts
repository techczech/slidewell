import { app, BrowserWindow, ipcMain, dialog, protocol, shell, net, clipboard, nativeImage, safeStorage, powerMonitor } from 'electron'
import sharp from 'sharp'
import { join, basename } from 'path'
import { homedir, tmpdir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, watch as fsWatch } from 'fs'
import { pathToFileURL } from 'url'
import { execFile } from 'node:child_process'
import { resolve as resolvePath, sep as pathSep } from 'path'
import { planSources, matchesFromKind, countFrom, type FilterableResult, type FromCounts, type SourcePlan } from './searchfilters'
import { matchedSearch, rowIds, type MatchCluster, type MatchRow } from './matched-search'
import { startSettings, type SaveResult, type SettingsApp } from './settings-host'
import { ARCHIVE_DEFAULT, foldersOverlap, OTHERS_DEFAULT, OVERLAP_REASON } from './settings-rules'
import { keySlots } from './key-slots'
import { legacyFromPrefs, splitLegacyPatch } from '../shared/settings-schema'
import { saveR2 } from './r2-save'
import { MAIN_COMMANDS, registry, type CommandContext } from '../shared/commands'
import { mergeLookAlikeClusters } from './look-alike/merge-clusters'
import { cachedDHash } from './look-alike/fingerprint'
import { runMoreLikeThis } from './more-like-this'
import type { MatchMode } from './match-bands'
import { applyFilters, combinedDateFilter, parseQuery, resolveOwnershipFilter } from './searchlib'
import { archiveResults, deckSlides, slideStructure, slideImages, searchImages, listDecks, deckDetail, archiveStats, type SearchFilters, type EnrichedHit, type ImageHit } from './archive'
import { loadDeckMeta, categoryList, invalidateDeckMeta, setOwnerNames, type DeckMetaIndex } from './deckmeta'
import { resolveOwnerNames, cleanOwnerNames } from './owners'
import { ensureWell, drainInbox, scanVault, searchWell, wellByIds, wellAbsPath, ingestScreenshot, findFfmpeg, type WellRow } from './well'
import { scanTriageSource, listTriage, triageCounts, setTriageDecision, importSelectedTriage, VIDEO_GATE_BYTES, type TriageRow, type ScanOptions } from './triage'
import { cleanShotFolder, cleanShotNameTemplate } from './cleanshot-folder'
import { captureDownloadRoot } from './online-only'
import { createCaptureDownloads } from './capture-downloads'
import { realpath } from 'node:fs/promises'
import { createSourceWatcher } from './source-watcher'
import { registerBacklogIpc } from './backlog-ipc'
import { talkAbsPath, isVaultChangeRelevant } from './talk-usage'
import { createTalkUsageService } from './talk-usage-service'
import { createImportRunner } from './triage-import-run'
import { runIngest, cancelIngest, detectPython, findRenderTools } from './ingest'
import { convertPptxToOutline } from './convert'
import { slugify } from './outline'
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
import { appCounts, cleanAppList, decideAllFromApps } from './triage-apps'
import { ReviewService } from './review/service'
import { registerReviewIpc } from './review/ipc'
import { decodeSwUrlPath as decodeSwPath, resolveSwUrlReal as resolveSwReal, serveSwFile, swUrlOf } from './swarchive-guard'
import { CloudSorter, KEY_FIELD, normaliseCloudSettings, registerCloudIpc, saveCloudKey, removeCloudKey, type CloudRunSummary, type CloudSettings, type StoredCloudSettings } from './sorter/cloud/service'
import { ApiKeyStore } from './sorter/cloud/key-store'
import { shrinkForLuna } from './sorter/cloud/images'
import type { HttpPost } from './sorter/cloud/client'
import { PROVIDERS } from './sorter/cloud/provider'
import { guardedHandle } from './ipc-guard'
import { pileOf, type ProposalLabel } from './review/piles'

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
function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}
// The preferences moved to the shared settings file (settings-host.ts, shared/settings-schema.ts). Readers
// here still see config.json's old shape: readConfig() lays the current settings over config.json, and
// writeConfig() sends preference fields to the settings store (who: you) and the rest to config.json.
// Until the settings start, and when the move could not be made safely, config.json is read as before.
let settings: SettingsApp | null = null
let prefsInStore = false
function rawConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}
function readConfig(): Config {
  const raw = rawConfig()
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
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  let rest: Partial<Config> = patch
  let prefs: Promise<SaveResult> = Promise.resolve({ ok: true })
  if (settings && prefsInStore) {
    const split = splitLegacyPatch(patch as Record<string, unknown>)
    const s = settings
    const writes = Object.entries(split.prefs).map(([key, value]) => s.set(key, value))
    prefs = Promise.all(writes).then((rs) => rs.find((r) => !r.ok) ?? { ok: true })
    rest = split.rest as Partial<Config>
    if (Object.keys(rest).length === 0) return prefs
    // config.json stays the older version's file: its own preference fields inside r2 and pictureSearch are kept
    const raw = rawConfig()
    if (rest.r2 && raw.r2) rest = { ...rest, r2: { ...pickLegacy(raw.r2, ['accountId', 'endpoint', 'bucket', 'prefix']), ...rest.r2 } }
    if (rest.pictureSearch && raw.pictureSearch) rest = { ...rest, pictureSearch: { ...pickLegacy(raw.pictureSearch, ['includeWell']), ...rest.pictureSearch } }
  }
  writeRawConfig(rest)
  return prefs
}
/** Writes state fields (and the key ciphertext) to config.json as they are, without touching its preferences. */
function writeRawConfig(patch: Partial<Config>): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify({ ...rawConfig(), ...patch }, null, 2), 'utf8')
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

// Capture-watcher downloads are owned here: quitting SlideWell or pressing Stop on the backlog import
// aborts them (the active download child is killed) and they stay off until the next explicit user
// action (Scan, a new backlog run) or app start (capture-downloads.ts).
const captureDownloads = createCaptureDownloads()

// How one capture source is scanned (ticket 15). Names are read with CleanShot's own template.
// Download authority is decided on canonical paths (captureDownloadRoot), never from namedOnly: only a
// source that IS the Desktop (scanned screenshot names only) or CleanShot's export folder may download
// online-only files; the primary Triage folder never does, under any alias (it can hold thousands).
// Every other source skips the primary folder's subtree (walk and download) when it is nested inside.
async function scanOptionsFor(s: CaptureSource, o: { downloads?: boolean } = {}): Promise<ScanOptions> {
  const [nameTemplate, cleanshotExport] = await Promise.all([cleanShotNameTemplate(), cleanShotFolder()])
  const desktop = join(homedir(), 'Desktop')
  const primary = screenshotRootResolved()
  let downloadRoot = await captureDownloadRoot(s.path, { desktop, cleanshotExport, primary })
  // the whole Desktop is never downloaded: only when the source is scanned for screenshot names alone
  if (downloadRoot && !s.namedOnly && downloadRoot === (await captureDownloadRoot(desktop, { desktop, cleanshotExport: null, primary: null }))) downloadRoot = null
  const [src, primaryReal] = await Promise.all([s.path, primary].map((p) => (p ? realpath(p).catch(() => null) : Promise.resolve(null))))
  const excludeDir = primaryReal && src !== primaryReal ? primaryReal : null
  const dl = captureDownloads.options(o.downloads === false ? null : downloadRoot)
  return { namedOnly: s.namedOnly, nameTemplate, excludeDir, ...dl }
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
    has: () => Boolean(rawConfig().r2?.[field]),
    set(value: string) {
      if (!value || value.length > 512 || !safeStorage.isEncryptionAvailable()) return { ok: false }
      writeRawConfig({ r2: { ...(rawConfig().r2 ?? {}), [field]: safeStorage.encryptString(value).toString('base64') } })
      return { ok: true }
    },
    remove() {
      const { [field]: _gone, ...rest } = rawConfig().r2 ?? {}
      writeRawConfig({ r2: rest })
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
  const saveCloudCfg = (patch: Partial<NonNullable<Config['sorterCloud']>>): void => void writeConfig({ sorterCloud: { ...cloudCfg(), ...patch } })
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

  appHandle('archive:search', async (_e, query: string, filters: SearchFilters) => {
    const from = filters?.from ?? 'all'
    const kind = filters?.kind ?? 'all'
    const plan = planSources(filters?.type ?? 'slides', from, kind)
    const rows = await collectResults(query ?? '', filters, plan)
    return groupByLook(rows.filter((c) => matchesFromKind(rep(c), from, kind)), filters)
  })

  // Search with the Match switch (Words / Meaning / Both): word hits, picture hits, two bands.
  // Picture hits are resolved to the same wire rows and pass the same Library/Owner/Date/Category/
  // Presentation/From/Kind filters as word hits. Words mode never runs a picture query.
  appHandle('archive:search-matched', async (_e, query: string, filters: SearchFilters, mode: MatchMode) => {
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
  appHandle('archive:more-like-this', async (_e, row: { kind: string; deck: string; slideOrder: number | null; reference: string }) => {
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
  appHandle('archive:from-counts', async (_e, query: string, filters: SearchFilters): Promise<FromCounts> => {
    const kind = filters?.kind ?? 'all'
    const rows = await collectResults(query ?? '', filters, { slides: true, archiveImages: true, well: true })
    return countFrom(rows.map(rep), kind)
  })

  // Distinct deck categories (with counts) for the Category filter dropdown.
  appHandle('archive:categories', () => {
    if (!archiveAvailable()) return []
    try {
      return categoryList(loadDeckMeta(archiveRoot(), cacheDir()))
    } catch {
      return []
    }
  })

  // All decks (id, title, date) newest-first, for the Deck filter picker.
  appHandle('archive:decks', () => {
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
  appHandle('archive:list-decks', async (_e, filters: SearchFilters) => {
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
  appHandle('archive:deck-detail', (_e, pid: string) => {
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
  appHandle('archive:stats', async () => {
    if (!archiveAvailable()) return null
    try {
      return await archiveStats(archiveRoot(), cacheDir())
    } catch {
      return null
    }
  })

  // The structured content (presentation.json node) of one slide — for "Copy structure".
  appHandle('archive:slide-structure', (_e, deck: string, slideOrder: number | null) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return null
    try {
      return slideStructure(rootForDeck(deck), deck, slideOrder)
    } catch {
      return null
    }
  })

  // The embedded image assets on one slide → renderable swarchive:// thumbnails (for the inspector).
  appHandle('archive:slide-images', (_e, deck: string, slideOrder: number | null) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return []
    try {
      return slideImages(rootForDeck(deck), deck, slideOrder).map((im) => ({ thumbUrl: swThumb(im.absPath) }))
    } catch {
      return []
    }
  })

  // All slides of one presentation, in order — for "See in context". Tagged with the store it came from.
  appHandle('archive:deck-slides', async (_e, deck: string) => {
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
  appHandle('clipboard:copy-image', async (_e, thumbUrl: string) => {
    const abs = resolveSwUrlReal(thumbUrl)
    return abs ? copyFileToClipboard(abs) : false
  })
  // Copy as a PNG raster bitmap (for Keynote / Slack / web that want a pasted image, not a file).
  appHandle('clipboard:copy-image-png', async (_e, thumbUrl: string) => {
    const abs = resolveSwUrlReal(thumbUrl)
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
  appHandle('shell:reveal', (_e, thumbUrl: string) => {
    const abs = resolveSwUrlReal(thumbUrl) // a link inside a root that leads outside every root is not revealed
    if (!abs) return false
    shell.showItemInFolder(abs)
    return true
  })

  // TalkWeaver registers no URL scheme and no document type, so the nearest thing to "open the talk"
  // is showing its outline file in Finder. The path is vault-relative and must stay inside the vault.
  appHandle('talks:reveal', (_e, relPath: string) => {
    const vr = detectVaultRoot()
    if (!vr || typeof relPath !== 'string') return false
    const abs = talkAbsPath(vr, relPath)
    if (!abs) return false
    shell.showItemInFolder(abs)
    return true
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

  // --- triage (ADR-0029): scan a source folder, browse/decide, promote keepers into the well ---
  appHandle('settings:choose-screenshot-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ screenshotRoot: r.filePaths[0] })
    refreshWatchers()
    return r.filePaths[0]
  })
  // Capture inbox extras: 'desktop' | 'cleanshot' add the offered defaults; 'folder' asks for a folder.
  appHandle('settings:add-capture-source', async (_e, which: 'desktop' | 'cleanshot' | 'folder') => {
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
  appHandle('settings:remove-capture-source', (_e, path: string) => {
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
    captureDownloads.resume() // an explicit Scan turns downloading back on after a Stop
    return scanAllSources()
  })
  // One scan of every capture source, through the one-at-a-time scan queue. `downloads: false` = this
  // scan never downloads (the follow-up of a stopped backlog run), whatever the gate says.
  async function scanAllSources(o: { downloads?: boolean } = {}): Promise<{ ok: boolean; indexed: number; total: number; offline?: number }> {
    const sources = triageSources()
    if (sources.length === 0) return { ok: false, indexed: 0, total: 0 }
    const sum = { indexed: 0, total: 0, offline: 0 }
    try {
      for (const s of sources) {
        const res = await scanTriageSource(archiveRoot(), wellRootResolved(), s.path, onTriageProgress, await scanOptionsFor(s, o))
        review.filesChanged() // Review's Not on this Mac answers are worked out again (review/not-on-mac-cache.ts)
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
    void scanOptionsFor(s)
      .then((o) => scanTriageSource(archiveRoot(), wellRootResolved(), s.path, onTriageProgress, o))
      .then(() => {
        review.filesChanged()
        mainWindow?.webContents.send('triage:changed')
      })
      .catch(() => undefined)
  })
  refreshWatchers = (): void => watcher.setSources(triageSources().map((s) => ({ path: s.path, recursive: !s.namedOnly })))
  refreshWatchers()
  app.on('will-quit', () => {
    watcher.close()
    captureDownloads.stop() // kill any active download child
  })
  // One-off backlog import (Desktop + CleanShot history → the Triage source folder). After a run,
  // one explicit scan; the import itself never waits on watcher events from the (OneDrive) folder.
  registerBacklogIpc({
    watchedFolder: screenshotRootResolved,
    stateDir: () => join(app.getPath('userData'), 'backlog-import'),
    isMainWindow: fromAppWindow,
    afterRun: ({ stopped }) => void scanAllSources({ downloads: !stopped }).then(() => mainWindow?.webContents.send('triage:changed')),
    captureDownloads
  })
  guardedHandle(ipcMain, fromMainWindow, 'triage:list', async (_e, q: string, state: string, sort?: string, limit?: number, offset?: number, apps?: unknown) => {
    const src = triageSources()[0]?.path ?? null
    const wellR = wellRootResolved()
    const empty = { items: [], counts: { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }, hasMore: false }
    if (!src) return empty
    try {
      const s = sort === 'date-desc' || sort === 'date-asc' ? sort : 'scanned'
      const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 500) : 150
      const off = typeof offset === 'number' && offset > 0 ? offset : 0
      // the app filter (ticket 20): absent = every app; a list that is not a list of names lists nothing
      const only = apps === undefined || apps === null ? null : cleanAppList(apps)
      if (apps !== undefined && apps !== null && !only) return { ...empty, counts: await triageCounts(wellR) }
      const rows = await listTriage(wellR, q ?? '', state ?? 'undecided', s, lim, off, Date.now(), only)
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
      const r = await setTriageDecision(archiveRoot(), wellRootResolved(), src, hash, action, Boolean(force))
      retrainer.noteAnswer() // a throw-away in Triage is a choice the sorter learns from (a keep counts once imported)
      return r
    } catch {
      return { state: 'undecided' }
    }
  })
  // The App menu (ticket 20): each app with its count in this state tab and his kept share for it.
  const LIST_STATES = new Set(['undecided', 'selected', 'included', 'excluded', 'all'])
  guardedHandle(ipcMain, fromMainWindow, 'triage:apps', async (_e, state: unknown) => {
    try {
      return appCounts(wellRootResolved(), typeof state === 'string' && LIST_STATES.has(state) ? state : 'undecided')
    } catch {
      return []
    }
  })
  // Exclude all / select all undecided from the ticked apps: his decision for many at once (triage-apps.ts
  // decideAllFromApps: one transaction, counted again inside it, refused when the count is not the one he saw).
  guardedHandle(ipcMain, fromMainWindow, 'triage:decide-all', async (_e, apps: unknown, action: unknown, expected: unknown) => {
    const list = cleanAppList(apps)
    if (!list || !list.length || (action !== 'select' && action !== 'exclude') || typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) return { ok: false, changed: 0, count: 0, refused: 'bad-arguments' }
    if (!triageSources()[0]) return { ok: false, changed: 0, count: 0, refused: 'count-changed' }
    const r = await decideAllFromApps(wellRootResolved(), list, action, expected)
    retrainer.noteAnswer()
    return r
  })
  // One Triage import run at a time; a second click (or a reopened panel) joins the run that is going.
  const triageImport = createImportRunner({
    emit: (snap) => void mainWindow?.webContents.send('triage:import-progress', snap),
    work: async (onStep, forceHashes) => {
      const src = triageSources()[0]?.path ?? null
      if (!src) return { imported: 0, skipped: 0, gated: 0 }
      try {
        return await importSelectedTriage(archiveRoot(), wellRootResolved(), src, forceHashes, onStep)
      } finally {
        pictureSearch?.poke()
      }
    }
  })
  guardedHandle(ipcMain, fromMainWindow, 'triage:import-selected', async (_e, forceHashes?: string[]) => {
    const r = await triageImport.start(Array.isArray(forceHashes) ? forceHashes : [])
    if (!r.error) mainWindow?.webContents.send('triage:changed')
    retrainer.noteAnswer() // imported keeps are now choices the sorter learns from
    return r
  })
  guardedHandle(ipcMain, fromMainWindow, 'triage:import-status', async () => triageImport.status())
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
          writeRawConfig({ r2: { ...(rawConfig().r2 ?? {}), ...prefs } }) // preferences still in config.json
          return { ok: true }
        } catch (e) {
          return { ok: false, error: `The R2 settings were not saved (${(e as NodeJS.ErrnoException)?.code ?? 'error'}).` }
        }
      },
      writeCiphertext: (enc) => writeRawConfig({ r2: { ...(rawConfig().r2 ?? {}), ...enc } })
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

  // --- Others' Library (Scenario A, ADR-0031): a separate store for other people's decks ---
  appHandle('settings:choose-others-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const picked = r.filePaths[0]
    // Never let the Others' Library overlap the personal archive — that would defeat the separation.
    if (foldersOverlap(picked, archiveRoot())) {
      await dialog.showMessageBox({ type: 'warning', buttons: ['OK'], message: "That folder overlaps your own archive.", detail: 'Pick a separate location for the Others’ Library so other people’s slides never mix into your archive.' })
      return readConfig().othersArchiveRoot ?? null
    }
    writeConfig({ othersArchiveRoot: picked })
    return picked
  })
  // Purge the whole Others' Library (its built store only) — never touches the personal archive.
  appHandle('settings:clear-others-library', async () => {
    const root = othersArchiveRootResolved()
    if (foldersOverlap(root, archiveRoot())) return { ok: false }
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
  appHandle('ingest:pending', async () => {
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
  appHandle('ingest:choose-path', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }]
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  // Run the import against an already-chosen path (no dialog — the panel confirmed what + where).
  // library 'others' routes the data into the separate Others' Library store (Scenario A); the
  // ENGINE is always the user's ppt-archive (that's where Core A's tools/ live).
  appHandle('ingest:run-path', async (_e, targetPath: string, library?: 'mine' | 'others') => {
    if (!archiveAvailable()) {
      archiveMissingLine()
      return { ok: false }
    }
    if (!targetPath) {
      sendLine('✕ Pick a file or folder to import first.')
      return { ok: false }
    }
    const dataRoot = library === 'others' ? othersArchiveRootResolved() : archiveRoot()
    // checked again on use: the Others' Library never shares a folder with your own archive, however it was set
    if (library === 'others' && foldersOverlap(dataRoot, archiveRoot())) {
      sendLine(`✕ ${OVERLAP_REASON}`)
      return { ok: false }
    }
    if (library === 'others') sendLine(`→ Importing into your Others' Library (kept separate from your archive): ${dataRoot}`)
    const r = await runIngest({ engineRoot: archiveRoot(), dataRoot, python: python(), mode: 'path', targetPath }, sendLine)
    invalidateDeckMeta(cacheDir()) // new decks added → drop the cached index so they show without restart
    if (library !== 'others') pictureSearch?.pokeArchive()
    return r
  })
  appHandle('ingest:cancel', () => {
    cancelIngest()
    return true
  })

  // --- convert (sideband, throwaway): someone else's .pptx → a mechanical Outline folder,
  //     saved wherever the user picks. Never touches the archive registry or the vault. ---
  const sendConvertLine = (s: string): void => mainWindow?.webContents.send('convert:line', s)
  appHandle('settings:choose-conversions-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    writeConfig({ conversionsRoot: r.filePaths[0] })
    return r.filePaths[0]
  })
  appHandle('settings:set-convert-ocr', (_e, on: boolean) => {
    writeConfig({ convertOcrByDefault: Boolean(on) })
    return Boolean(on)
  })
  // "My decks" owner names. Unset → computed from the OS account (never written until the user saves).
  appHandle('settings:get-owner-names', () => resolveOwnerNames(readConfig().ownerNames))
  appHandle('settings:set-owner-names', (_e, names: unknown) => {
    const cleaned = cleanOwnerNames(names)
    writeConfig({ ownerNames: cleaned.length > 0 ? cleaned : undefined }) // empty → back to the account default
    const resolved = resolveOwnerNames(readConfig().ownerNames)
    setOwnerNames(resolved.names) // ownership is part of the deck index → next load rescans
    return resolved
  })
  // Step 1: pick the source .pptx — returns its path so the panel SHOWS it before converting.
  appHandle('convert:choose-source', async () => {
    const pick = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }] })
    return pick.canceled || !pick.filePaths[0] ? null : pick.filePaths[0]
  })
  // Step 2: pick the destination folder, pre-filled from the source name + the conversionsRoot default.
  appHandle('convert:choose-dest', async (_e, sourcePath: string) => {
    const suggested = slugify(basename(sourcePath || '').replace(/\.(pptx|ppt)$/i, '')) || 'converted'
    const defDir = conversionsRootResolved()
    const defaultPath = join(defDir && existsSync(defDir) ? defDir : homedir(), suggested)
    const save = await dialog.showSaveDialog({ title: 'Save the converted Outline folder as…', buttonLabel: 'Choose', defaultPath })
    return save.canceled || !save.filePath ? null : save.filePath
  })
  // Step 3: run the conversion against the already-chosen source + destination (no dialogs here).
  appHandle('convert:run', async (_e, opts: { pptxPath: string; outDir: string; ocr: boolean }) => {
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
  appHandle('others:delete-matching', async (_e, query: string, filters: SearchFilters) => {
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

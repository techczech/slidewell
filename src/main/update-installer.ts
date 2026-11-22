// Updating in place (ADR-0044): Electron's side of the one click. The engine and its design (one function may call
// the native install, after re-reading the blockers; attempts with identities; electron-updater's own install path
// closed) are in update-engine.ts; read its header first. This file supplies what the engine asks for:
// electron-updater's MacUpdater configured as a download engine with our own provider (it makes no request: it
// hands over the one version our checker already chose from the validated feed), the deferred hand-over to
// Squirrel.Mac (Electron's autoUpdater) at restart time only, the file checks, the clean-up of downloads, and the
// checked withdrawal of a preparation that must not install.
// Windows constructs nothing: no in-place install there in this release (ADR-0044 §5).
import { app, session } from 'electron'
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { MacUpdater, type AppUpdater, type UpdateInfo } from 'electron-updater'
import { getAppCacheDir } from 'electron-updater/out/AppAdapter'
import type { ChannelEntry, UpdateFile } from '../shared/update-channels.ts'
import { inPlaceRefusal, type InPlaceFacts, type InPlaceRefusal, type InstallPhase, type RestartBlocker } from '../shared/update-install.ts'
import {
  OfferProvider, closeDependencyInstallPath, createUpdateEngine, dependencyDownload, launchdJobPresence, pathPresence, verifyMacDownload,
  type NativeUpdater, type Offer, type Presence, type Withdrawal,
} from './update-engine.ts'
import { installUpdateDownloadFilter } from './update-download-filter'
import { UPDATE_INSTALL_IDENTITY } from '../shared/update-identity'

/** electron-updater's own network partition (electronHttpExecutor.ts NET_SESSION_NAME). */
const UPDATER_PARTITION = 'electron-updater'

export interface InstallerDeps {
  /** The download cache folder's name under the computer's cache folder. */
  cacheDirName: string
  /** Test harness only: put the cache here instead of the computer's cache folder. */
  cacheBase?: string
  /** Where electron-updater's small configuration file is written (the user-data folder). */
  configDir: string
  /** Production: refuse local addresses on the updater's session (a redirect to this computer or the network). */
  fixtureOrigin: string | null
  /** website, store, preview or development (copySource): a Store copy or a development run never updates itself. */
  source: string
  /** A protected task (presenter or audience window, live session, recording): no update starts. */
  offerEligible(offer: Offer): boolean
  blockers(): RestartBlocker[]
  /** The restart's commit: every window closed through its own close route. True only when every window has closed
   *  (update-engine.ts, commit). */
  closeWindows(): Promise<boolean>
  /** How many windows are open now (every BrowserWindow, hidden ones too). */
  openWindows(): number
  /** Every main-process write queue finished (write-queues.ts drainWriteQueues). */
  drainWriteQueues(): Promise<boolean>
  writeQueuesBusy(): readonly string[]
  /** The restart's commit began and the restart will not happen: give the person a window back. */
  commitAbandoned(): void
  changed(): void
  log(message: string): void
}

/** CFBundleIdentifier of the running Mac app, or null. */
function readBundleId(bundle: string): string | null {
  try {
    const out = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim()
    return out || null
  } catch { return null }
}

const runningBundle = (): string => resolve(process.execPath, '..', '..', '..')

/** The facts inPlaceRefusal decides on, read from this computer now. */
export function readInPlaceFacts(file: UpdateFile | null, source: string): InPlaceFacts {
  const platform = process.platform
  const appPath = platform === 'darwin' ? runningBundle() : dirname(process.execPath)
  let writable = false
  let writeError: string | null = null
  try {
    accessSync(appPath, constants.W_OK)
    accessSync(dirname(appPath), constants.W_OK)
    writable = true
  } catch (error) { writeError = (error as NodeJS.ErrnoException)?.code ?? 'EACCES' }
  return { platform, arch: process.arch, source, file, appPath, writable, writeError, bundleId: platform === 'darwin' ? readBundleId(appPath) : null }
}

export function createUpdateInstaller(deps: InstallerDeps) {
  const cacheDir = join(deps.cacheBase ?? getAppCacheDir(), deps.cacheDirName)
  let updater: AppUpdater | null = null
  let chosen: UpdateInfo | null = null
  let downloader: ReturnType<typeof dependencyDownload> | null = null
  let handOver: ((file: string) => Promise<void>) | null = null

  // A download a crash or an earlier version left behind is never used: the cache starts empty each run.
  function create(): AppUpdater {
    if (process.platform !== 'darwin') throw new Error('no in-place update on this platform')
    const configPath = join(deps.configDir, 'app-update.yml')
    mkdirSync(deps.configDir, { recursive: true })
    // electron-updater reads only the cache folder's name from here: the feed is the provider below.
    writeFileSync(configPath, `updaterCacheDirName: ${deps.cacheDirName}\n`)
    installUpdateDownloadFilter(session.fromPartition(UPDATER_PARTITION, { cache: false }), deps.fixtureOrigin)
    const u: AppUpdater = new MacUpdater()
    u.logger = {
      info: (m: unknown) => deps.log(String(m)),
      warn: (m: unknown) => deps.log(`warning: ${String(m)}`),
      error: (m: unknown) => deps.log(`error: ${String(m)}`),
      debug: () => {},
    }
    handOver = closeDependencyInstallPath(u, deps.log).handOver
    u.requestHeaders = { 'User-Agent': 'SlideWell' }
    u.updateConfigPath = configPath
    if (deps.cacheBase) {
      const cacheBase = deps.cacheBase
      const adapter = (u as unknown as { app: object }).app
      Object.defineProperty(u, 'app', { value: Object.create(adapter, { baseCachePath: { get: () => cacheBase } }) })
    }
    u.setFeedURL({ provider: 'custom', updateProvider: OfferProvider, offer: () => chosen } as unknown as Parameters<AppUpdater['setFeedURL']>[0])
    return u
  }
  const theUpdater = (): AppUpdater => (updater ??= create())

  /**
   * Squirrel.Mac keeps a prepared update as an install request (ShipItState.plist in its cache folder) and a launchd
   * job (ShipIt) that installs it when the app's process ends. Remove both, then CHECK that both are gone.
   */
  async function withdrawNative(): Promise<Withdrawal> {
    if (process.platform !== 'darwin') return { found: false, gone: true, after: 'absent' }
    const bundleId = readBundleId(runningBundle())
    if (bundleId !== (deps.fixtureOrigin ? UPDATE_INSTALL_IDENTITY.fixtureBundleId : UPDATE_INSTALL_IDENTITY.bundleId)) { deps.log('the withdrawal could not name ShipIt (no bundle identifier): not confirmed'); return { found: true, gone: false, after: 'unknown' } }
    const label = `${bundleId}.ShipIt`
    const folder = join(homedir(), 'Library', 'Caches', label)
    const request = join(folder, 'ShipItState.plist')
    // Each check gives a definite answer or 'unknown' (a timeout, an error, an unexpected exit code, a path that
    // cannot be read). Only two definite 'absent' answers count as withdrawn; 'unknown' is never read as gone.
    const job = (): Presence => launchdJobPresence(spawnSync('/bin/launchctl', ['list', label], { stdio: 'ignore', timeout: 5000 }))
    const requestThere = (): Presence => pathPresence(() => lstatSync(request))
    const before = { job: job(), request: requestThere() }
    const found = before.job !== 'absent' || before.request !== 'absent'
    deps.log(`withdrawing: before, ShipIt job ${before.job}, install request ${before.request}`)
    let last = before
    for (let round = 0; round < 8; round++) {
      if (last.job !== 'absent') {
        const r = spawnSync('/bin/launchctl', ['remove', label], { stdio: 'ignore', timeout: 5000 })
        if (r.status !== 0) deps.log(`launchctl remove ${label} exited ${r.status ?? r.error?.message}`)
      }
      try { rmSync(folder, { recursive: true, force: true }) } catch (error) { deps.log(`could not remove ${folder}: ${(error as Error)?.message ?? error}`) }
      await new Promise((r) => setTimeout(r, 250))
      last = { job: job(), request: requestThere() }
      if (last.job === 'absent' && last.request === 'absent') {
        deps.log(found ? 'a prepared update was withdrawn and checked: no ShipIt job, no install request' : 'checked: nothing was prepared')
        return { found, gone: true, after: 'absent' }
      }
    }
    // 'present' only when both are definitely there: then the update WILL install at the next quit.
    const after: Presence = last.job === 'present' && last.request === 'present' ? 'present' : 'unknown'
    deps.log(`the withdrawal is NOT confirmed: ShipIt job ${last.job}, install request ${last.request} (afterwards: ${after})`)
    return { found: true, gone: false, after }
  }

  let nativeQuit = false
  const engine = createUpdateEngine({
    platform: process.platform,
    gate: (offer) => {
      if (!deps.offerEligible(offer)) return 'the displayed update is no longer selected'
      const refusal = inPlaceRefusal(readInPlaceFacts({ url: offer.url, sha512: offer.sha512, size: offer.size, bundleId: offer.bundleId }, deps.source))
      return refusal
    },
    blockers: deps.blockers,
    closeWindows: deps.closeWindows,
    openWindows: deps.openWindows,
    drainWriteQueues: deps.drainWriteQueues,
    writeQueuesBusy: deps.writeQueuesBusy,
    commitAbandoned: () => { nativeQuit = false; deps.commitAbandoned() },
    downloader: () => {
      rmSync(cacheDir, { recursive: true, force: true })
      return downloader ??= dependencyDownload(theUpdater(), (info) => { chosen = info })
    },
    verify: (file, offer) => verifyMacDownload(file, offer, app.getVersion()),
    handOver: (file) => handOver ? handOver(file) : Promise.reject(new Error('the updater was not created')),
    native: () => {
      const native = (theUpdater() as unknown as { nativeUpdater: NativeUpdater }).nativeUpdater
      return {
        on: (event, listener) => native.on(event, listener),
        checkForUpdates: () => native.checkForUpdates(),
        quitAndInstall: () => {
          nativeQuit = true
          native.quitAndInstall()
        }
      }
    },
    withdrawNative,
    releaseFiles: () => {
      try { (updater as unknown as { closeServerIfExists?: () => void } | null)?.closeServerIfExists?.() } catch { /* already closed */ }
      try { rmSync(cacheDir, { recursive: true, force: true }) } catch { /* nothing there */ }
    },
    changed: deps.changed,
    log: deps.log,
  })

  return {
    state: (): InstallPhase => engine.state(),
    blocksQuit(): boolean {
      const state = engine.state()
      return (state.phase === 'restarting' && !nativeQuit) || (state.phase === 'reopen' && state.pending)
    },
    /** The click: download the entry's file for this computer, check it, then restart or wait. */
    start(entry: ChannelEntry, file: UpdateFile): Promise<InstallPhase> {
      const offer: Offer = { version: entry.version, released: entry.released, url: file.url, sha512: file.sha512, size: file.size, bundleId: file.bundleId }
      return engine.start(offer)
    },
    cancel: (): InstallPhase => engine.cancel(),
    /** Restart to finish updating: only when nothing holds it back. */
    restart: (): InstallPhase => engine.restart(),
    /** The offer changed: a failed attempt starts again from Update. */
    reset: (): void => engine.reset(),
    refusal(file: UpdateFile | null, source: string): InPlaceRefusal | null {
      return inPlaceRefusal(readInPlaceFacts(file, source))
    },
  }
}
export type UpdateInstaller = ReturnType<typeof createUpdateInstaller>

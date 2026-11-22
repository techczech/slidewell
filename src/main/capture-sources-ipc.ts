import { restartWork } from './restart-work'
import { app, clipboard, dialog, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { existsSync, writeFileSync } from 'fs'
import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { registerBacklogIpc } from './backlog-ipc'
import { createCaptureDownloads } from './capture-downloads'
import { cleanShotFolder, cleanShotNameTemplate } from './cleanshot-folder'
import { guardedHandle } from './ipc-guard'
import { captureDownloadRoot } from './online-only'
import type { PictureSearchService } from './picture-search/service'
import { pileOf, type ProposalLabel } from './review/piles'
import type { ReviewService } from './review/service'
import type { Retrainer } from './sorter/retrain'
import { createSourceWatcher } from './source-watcher'
import { scanTriageSource, listTriage, triageCounts, setTriageDecision, importSelectedTriage, VIDEO_GATE_BYTES, type TriageRow, type ScanListing, type ScanOptions } from './triage'
import { appCounts, cleanAppList, decideAllFromApps } from './triage-apps'
import { createImportRunner } from './triage-import-run'
import { ingestScreenshot } from './well'
import type { AppHandle } from './app-handle'

// An extra folder watched for screenshots. namedOnly limits Desktop scans to screenshot names at the top level.
export type CaptureSource = { path: string; namedOnly: boolean }

const CAPTURE_RESCAN_MS = 60_000
const CAPTURE_RESCAN_STAGGER_MS = 1000
const CAPTURE_RESCAN_GAP_MS = 20_000
const CAPTURE_RESCAN_BACKOFF_MS = 10 * 60_000

interface ScheduledSource {
  source: CaptureSource
  listing: ScanListing
  timer?: ReturnType<typeof setTimeout>
  lastScanAt?: number
  failedAt?: number
}

interface ConfigPatch {
  screenshotRoot?: string
  captureSources?: CaptureSource[]
}

interface SourceDependencies {
  readConfig: () => ConfigPatch
  screenshotRootResolved: () => string | null
}

interface InstallDependencies {
  appHandle: AppHandle
  getMainWindow: () => BrowserWindow | null
  fromMainWindow: (sender: WebContents) => boolean
  fromAppWindow: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
  archiveRoot: () => string
  wellRootResolved: () => string
  writeConfig: (patch: ConfigPatch) => unknown
  swThumb: (abs: string | null) => string | null
  pictureSearch: PictureSearchService | null
  review: ReviewService
  retrainer: Pick<Retrainer, 'noteAnswer'>
}

export function createCaptureSources({ readConfig, screenshotRootResolved }: SourceDependencies) {
  // Defaults offered in Settings. The Desktop is namedOnly so other Desktop files are never read.
  // CleanShot's folder is read from its own preferences; null (not offered) when unset or missing.
  async function captureDefaults(): Promise<{ desktop: CaptureSource; cleanshot: CaptureSource | null }> {
    const cs = await cleanShotFolder()
    return {
      desktop: { path: join(homedir(), 'Desktop'), namedOnly: true },
      cleanshot: cs ? { path: cs, namedOnly: false } : null
    }
  }

  function captureSources(includeMissing: boolean): CaptureSource[] {
    const out: CaptureSource[] = []
    const config = readConfig()
    const primary = screenshotRootResolved() ?? (includeMissing ? config.screenshotRoot : null)
    if (primary) out.push({ path: primary, namedOnly: false })
    for (const s of config.captureSources ?? []) {
      if (s && typeof s.path === 'string' && (includeMissing || existsSync(s.path)) && !out.some((o) => o.path === s.path)) out.push({ path: s.path, namedOnly: Boolean(s.namedOnly) })
    }
    return out
  }

  // Every available folder the capture inbox reads, primary first.
  const triageSources = (): CaptureSource[] => captureSources(false)

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
    const primary = screenshotRootResolved()
    const [nameTemplate, src, primaryReal] = await Promise.all([
      cleanShotNameTemplate(),
      realpath(s.path).catch(() => null),
      primary ? realpath(primary).catch(() => null) : null
    ])
    const excludeDir = primaryReal && src !== primaryReal ? primaryReal : null
    let downloadRoot = null
    if (o.downloads !== false) {
      const cleanshotExport = await cleanShotFolder()
      const desktop = join(homedir(), 'Desktop')
      downloadRoot = await captureDownloadRoot(s.path, { desktop, cleanshotExport, primary })
      // the whole Desktop is never downloaded: only when the source is scanned for screenshot names alone
      if (downloadRoot && !s.namedOnly && downloadRoot === (await captureDownloadRoot(desktop, { desktop, cleanshotExport: null, primary: null }))) downloadRoot = null
    }
    return { namedOnly: s.namedOnly, nameTemplate, excludeDir, ...captureDownloads.options(downloadRoot) }
  }

  function install(deps: InstallDependencies): { launchScan: () => void; refreshWatchers: () => void } {
    const { appHandle, getMainWindow, fromMainWindow, fromAppWindow, archiveRoot, wellRootResolved, writeConfig, swThumb, pictureSearch, review, retrainer } = deps
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
    const onTriageProgress = (m: string): void => void getMainWindow()?.webContents.send('triage:progress', m)
    const scheduled = new Map<string, ScheduledSource>()
    const pending = new Map<string, number>()
    const loggedFailures = new Set<string>()
    let launchTimer: ReturnType<typeof setTimeout> | undefined

    async function scanSource(s: CaptureSource, o: { downloads?: boolean; fallback?: () => boolean } = {}) {
      pending.set(s.path, (pending.get(s.path) ?? 0) + 1)
      const entry = scheduled.get(s.path)
      const startedAt = Date.now()
      const fallback = o.fallback
      const isCurrent = fallback && (() => scheduled.get(s.path) === entry && existsSync(s.path) && fallback())
      try {
        const opts = await scanOptionsFor(s, o)
        const res = await scanTriageSource(archiveRoot(), wellRootResolved(), s.path, onTriageProgress, {
          ...opts,
          listing: entry?.listing,
          onlyChanged: Boolean(fallback),
          isCurrent
        })
        if (entry && scheduled.get(s.path) === entry && (!res.skipped || isCurrent?.() !== false)) {
          entry.lastScanAt = Date.now()
          entry.failedAt = undefined
        }
        if (!res.skipped) review.filesChanged()
        return res
      } catch (error) {
        if (entry && scheduled.get(s.path) === entry) {
          entry.failedAt = startedAt
          if (!loggedFailures.has(s.path)) {
            loggedFailures.add(s.path)
            console.warn('Triage scan failed for capture source', s.path, error)
          }
        }
        throw error
      } finally {
        const count = pending.get(s.path)! - 1
        if (count) pending.set(s.path, count)
        else pending.delete(s.path)
      }
    }

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
          const res = await scanSource(s, o)
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
    const notifyTriage = () => getMainWindow()?.webContents.send('triage:changed')
    const launchScan = (): void => {
      clearTimeout(launchTimer)
      launchTimer = setTimeout(() => {
        if (!restartWork.locked()) void restartWork.run(() => scanAllSources()).then(notifyTriage)
      }, 2500)
    }
    // Capture inbox: the watcher retains its debounce and download policy.
    const watcher = createSourceWatcher((path) => {
      const s = triageSources().find((x) => x.path === path)
      if (!s || restartWork.locked()) return
      void restartWork.run(() => scanSource(s)).then(notifyTriage).catch(() => undefined)
    })
    function mainWindowVisible(): boolean {
      const window = getMainWindow()
      return Boolean(window?.isVisible() && !window.isMinimized())
    }
    function rescan(entry: ScheduledSource, timer = false): void {
      const s = entry.source
      const canScan = () => !timer || mainWindowVisible()
      if (!canScan() || restartWork.locked() || pending.has(s.path) || !existsSync(s.path)) return
      const now = Date.now()
      if (now - (entry.lastScanAt ?? -Infinity) < CAPTURE_RESCAN_GAP_MS) return
      if (now - (entry.failedAt ?? -Infinity) < CAPTURE_RESCAN_BACKOFF_MS) return
      void restartWork.run(() => scanSource(s, { downloads: false, fallback: canScan }))
        .then((res) => { if (!res.skipped) notifyTriage() })
        .catch(() => undefined)
    }
    const rescanOnFocus = (_event: Electron.Event, window: BrowserWindow): void => {
      if (window === getMainWindow()) for (const entry of scheduled.values()) rescan(entry)
    }
    function scheduleRescan(entry: ScheduledSource, delay: number): void {
      entry.timer = setTimeout(() => {
        scheduleRescan(entry, CAPTURE_RESCAN_MS)
        rescan(entry, true)
      }, delay)
    }
    function refreshWatchers(): void {
      watcher.setSources(triageSources().map((s) => ({ path: s.path, recursive: !s.namedOnly })))
      const wanted = new Map(captureSources(true).map((s) => [s.path, s]))
      for (const [path, entry] of scheduled) {
        if (wanted.get(path)?.namedOnly === entry.source.namedOnly) continue
        clearTimeout(entry.timer)
        scheduled.delete(path)
      }
      let delay = CAPTURE_RESCAN_MS
      for (const source of wanted.values()) {
        if (!scheduled.has(source.path)) {
          const entry: ScheduledSource = { source, listing: {} }
          scheduled.set(source.path, entry)
          scheduleRescan(entry, delay)
        }
        delay += CAPTURE_RESCAN_STAGGER_MS
      }
    }
    refreshWatchers()
    app.on('browser-window-focus', rescanOnFocus)
    app.on('will-quit', () => {
      app.removeListener('browser-window-focus', rescanOnFocus)
      clearTimeout(launchTimer)
      for (const entry of scheduled.values()) clearTimeout(entry.timer)
      scheduled.clear()
      watcher.close()
      captureDownloads.stop() // kill any active download child
    })
    // One-off backlog import (Desktop + CleanShot history → the Triage source folder). After a run,
    // one explicit scan; the import itself never waits on watcher events from the (OneDrive) folder.
    registerBacklogIpc({
      watchedFolder: screenshotRootResolved,
      stateDir: () => join(app.getPath('userData'), 'backlog-import'),
      isMainWindow: fromAppWindow,
      afterRun: ({ stopped }) => void restartWork.run(() => scanAllSources({ downloads: !stopped })).then(() => getMainWindow()?.webContents.send('triage:changed')),
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
      emit: (snap) => void getMainWindow()?.webContents.send('triage:import-progress', snap),
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
      if (!r.error) getMainWindow()?.webContents.send('triage:changed')
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
    return { launchScan, refreshWatchers }
  }

  return { install, captureDefaults, triageSources }
}

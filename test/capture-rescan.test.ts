import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppHandle } from '../src/main/app-handle'
import type { ScanOptions } from '../src/main/triage'

const { scan, closeWatcher, chooseDirectory } = vi.hoisted(() => ({ scan: vi.fn(), closeWatcher: vi.fn(), chooseDirectory: vi.fn() }))
const app = new EventEmitter()
const handlers = new Map<string, Parameters<AppHandle>[1]>()
vi.mock('electron', () => ({
  app,
  ipcMain: { handle: (channel: string, handler: Parameters<AppHandle>[1]) => handlers.set(channel, handler) },
  clipboard: {},
  dialog: { showOpenDialog: chooseDirectory }
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  realpath: async (path: string) => path
}))
vi.mock('../src/main/backlog-ipc', () => ({ registerBacklogIpc: () => undefined }))
vi.mock('../src/main/cleanshot-folder', () => ({
  cleanShotNameTemplate: async () => null,
  cleanShotFolder: async () => null
}))
vi.mock('../src/main/online-only', () => ({ captureDownloadRoot: async () => '/downloadable' }))
vi.mock('../src/main/source-watcher', () => ({
  createSourceWatcher: () => ({ setSources: () => undefined, close: closeWatcher })
}))
vi.mock('../src/main/triage', () => ({ scanTriageSource: scan }))
vi.mock('../src/main/well', () => ({ ingestScreenshot: vi.fn() }))

const { createCaptureSources } = await import('../src/main/capture-sources-ipc')
type InstallDeps = Parameters<ReturnType<typeof createCaptureSources>['install']>[0]
const extra = join(__dirname, 'fixtures')
const send = vi.fn()
const filesChanged = vi.fn()
const isVisible = vi.fn(() => true)
const isMinimized = vi.fn(() => false)
const isDestroyed = vi.fn(() => false)
const mainWindow = { webContents: { send }, isVisible, isMinimized, isDestroyed } as NonNullable<ReturnType<InstallDeps['getMainWindow']>>
const event = { sender: mainWindow.webContents } as Electron.IpcMainInvokeEvent
const scanResult = { indexed: 1, total: 1, offline: 0 }

let scratch: string

function install(initial: { screenshotRoot?: string; captureSources: { path: string; namedOnly: boolean }[] } = {
  screenshotRoot: __dirname, captureSources: [{ path: extra, namedOnly: true }]
}) {
  let config = initial
  return createCaptureSources({ readConfig: () => config, screenshotRootResolved: () => config.screenshotRoot ?? null }).install({
    appHandle: (channel, fn) => void handlers.set(channel, fn),
    getMainWindow: () => mainWindow,
    fromMainWindow: (sender) => sender === event.sender,
    fromAppWindow: () => true,
    archiveRoot: () => '/archive',
    wellRootResolved: () => '/well',
    writeConfig: async (patch) => { config = { ...config, ...patch }; return { ok: true } },
    broadcast: send,
    swThumb: () => null,
    pictureSearch: null,
    review: { filesChanged } as unknown as InstallDeps['review'],
    retrainer: { noteAnswer: vi.fn() }
  })
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'sw-capture-rescan-'))
  vi.useFakeTimers()
  isVisible.mockReset()
  isVisible.mockReturnValue(true)
  isDestroyed.mockReturnValue(false)
  isMinimized.mockReturnValue(false)
  scan.mockReset().mockResolvedValue(scanResult)
  send.mockClear()
  filesChanged.mockClear()
  closeWatcher.mockClear()
  handlers.clear()
  chooseDirectory.mockReset()
})

afterEach(() => {
  app.emit('will-quit')
  app.removeAllListeners()
  vi.useRealTimers()
  rmSync(scratch, { recursive: true, force: true })
})

describe('capture fallback through the Triage scan', () => {
  it('scans enabled sources every minute without giving them download authority', async () => {
    install()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(scan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(scan.mock.calls.map((call) => call[2])).toEqual([__dirname])
    await vi.advanceTimersByTimeAsync(999)
    expect(scan).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(scan.mock.calls.map((call) => call[2])).toEqual([__dirname, extra])
    expect(scan.mock.calls.every((call) => call[4].downloadRoot === null)).toBe(true)
    expect(filesChanged).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('triage:changed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan).toHaveBeenCalledTimes(4)
  })

  it('leaves Review and Triage alone when the timer finds unchanged listings', async () => {
    install()
    scan.mockResolvedValue({ indexed: 0, total: 0, offline: 0, skipped: true })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(scan.mock.calls.every((call) => call[4].onlyChanged)).toBe(true)
    expect(filesChanged).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('responds only to the main window gaining focus', async () => {
    install()
    app.emit('browser-window-focus', {}, {})
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).not.toHaveBeenCalled()
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('waits 20 seconds after a manual scan before either fallback trigger can start', async () => {
    install()
    await vi.advanceTimersByTimeAsync(59_999)
    await handlers.get('triage:scan')!(event)
    scan.mockClear()
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(scan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(2)

    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('pauses timed scans while hidden or minimised and scans on return', async () => {
    install()
    isVisible.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(scan).not.toHaveBeenCalled()

    isVisible.mockReturnValue(true)
    isMinimized.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan).not.toHaveBeenCalled()

    isMinimized.mockReturnValue(false)
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('skips a closed main window without calling its visibility methods', async () => {
    install()
    isDestroyed.mockReturnValue(true)
    isVisible.mockImplementation(() => { throw new Error('Object has been destroyed') })

    await vi.advanceTimersByTimeAsync(61_000)
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(0)
    expect(isVisible).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
  })

  it('backs off only the failing source for ten minutes and logs once', async () => {
    install()
    const failure = new Error('scan failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const primaryScans = () => scan.mock.calls.filter((call) => call[2] === __dirname).length
    let shouldFail = true
    scan.mockImplementation(async (_archive, _well, source: string) => {
      if (source === __dirname && shouldFail) throw failure
      return scanResult
    })
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(primaryScans()).toBe(1)
      expect(warn).toHaveBeenCalledOnce()
      app.emit('browser-window-focus', {}, mainWindow)
      await vi.advanceTimersByTimeAsync(599_999)
      expect(primaryScans()).toBe(1)
      expect(scan.mock.calls.filter((call) => call[2] === extra).length).toBeGreaterThan(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(primaryScans()).toBe(2)
      expect(warn).toHaveBeenCalledOnce()

      shouldFail = false
      await vi.advanceTimersByTimeAsync(600_000)
      expect(primaryScans()).toBe(3)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(primaryScans()).toBe(4)
    } finally {
      warn.mockRestore()
    }
  })

  it('skips a busy source on both timer and focus, then retries it later', async () => {
    install()
    let finish!: (value: typeof scanResult) => void
    scan.mockImplementationOnce(() => new Promise<typeof scanResult>((resolve) => { finish = resolve }))
    const manual = handlers.get('triage:scan')!(event)
    await vi.advanceTimersByTimeAsync(60_000)
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.mock.calls.filter((call) => call[2] === __dirname)).toHaveLength(1)
    expect(scan.mock.calls.some((call) => call[2] === extra)).toBe(true)
    finish(scanResult)
    await expect(manual).resolves.toEqual({ ok: true, indexed: 2, total: 2, offline: 0 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan.mock.calls.filter((call) => call[2] === __dirname)).toHaveLength(2)
  })

  it('clears a removed source timer and clears all timers on quit', async () => {
    const capture = install()
    expect(vi.getTimerCount()).toBe(2)
    await handlers.get('settings:remove-capture-source')!(event, extra)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan.mock.calls.map((call) => call[2])).toEqual([__dirname])
    const queuedScan = scan.mock.calls[0][4] as ScanOptions
    capture.launchScan()
    app.emit('will-quit')
    expect(vi.getTimerCount()).toBe(0)
    expect(closeWatcher).toHaveBeenCalledOnce()
    expect(queuedScan.isCurrent?.()).toBe(false)
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(scan).toHaveBeenCalledOnce()
  })
})

describe('capture folder availability', () => {
  const status = () => handlers.get('settings:capture-source-status')?.(event) as { path: string; exists: boolean }[] | undefined

  it('detects missing, non-directory and unreadable folders at installation', () => {
    const missing = join(scratch, 'missing')
    const file = join(scratch, 'file')
    const unreadable = join(scratch, 'unreadable')
    writeFileSync(file, 'not a directory')
    mkdirSync(unreadable)
    chmodSync(unreadable, 0o300)
    try {
      install({ screenshotRoot: missing, captureSources: [file, unreadable, scratch].map((path) => ({ path, namedOnly: false })) })
      expect(status()?.map(({ path, exists }) => [path, exists])).toEqual([
        [missing, false], [file, false], [unreadable, false], [scratch, true]
      ])
    } finally {
      chmodSync(unreadable, 0o700)
    }
  })

  it('publishes one transition when a folder goes away while the window is hidden', async () => {
    const path = join(scratch, 'Screenshots')
    mkdirSync(path)
    install({ captureSources: [{ path, namedOnly: false }] })
    isVisible.mockReturnValue(false)
    renameSync(path, join(scratch, 'Moved'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(status()).toEqual([expect.objectContaining({ path, exists: false })])
    expect(send.mock.calls.filter(([channel]) => channel === 'capture-sources:changed')).toHaveLength(1)
    expect(scan).not.toHaveBeenCalled()
  })

  it('clears missing status on the next timer pass when the directory comes back', async () => {
    const path = join(scratch, 'Screenshots')
    install({ screenshotRoot: path, captureSources: [] })
    expect(status()).toEqual([expect.objectContaining({ path, exists: false })])
    mkdirSync(path)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(status()).toEqual([expect.objectContaining({ path, exists: true })])
    expect(scan.mock.calls.map((call) => call[2])).toEqual([path])
  })

  it('checks on main-window focus, even during the scan cooldown', async () => {
    const path = join(scratch, 'Screenshots')
    mkdirSync(path)
    install({ screenshotRoot: path, captureSources: [] })
    await handlers.get('triage:scan')!(event)
    renameSync(path, join(scratch, 'Moved'))
    app.emit('browser-window-focus', {}, mainWindow)
    await vi.advanceTimersByTimeAsync(0)
    expect(status()).toEqual([expect.objectContaining({ path, exists: false })])
    expect(scan).toHaveBeenCalledOnce()
  })
})

describe('re-pointing cannot overlap another watched folder', () => {
  it.each(['parent', 'child', 'alias'])('refuses a %s of the other source', async (relation) => {
    const missing = join(scratch, 'missing')
    const parent = join(scratch, 'parent')
    const other = join(parent, 'watched')
    const child = join(other, 'child')
    const alias = join(scratch, 'alias')
    mkdirSync(child, { recursive: true })
    symlinkSync(other, alias)
    const destination = { parent, child, alias }[relation]
    install({ screenshotRoot: missing, captureSources: [{ path: other, namedOnly: false }] })
    chooseDirectory.mockResolvedValue({ canceled: false, filePaths: [destination] })
    const result = await handlers.get('settings:replace-capture-source')!(event, missing)
    expect(result).toEqual({ ok: false, error: 'The chosen folder overlaps another watched folder.' })
    expect(handlers.get('settings:capture-source-status')!(event)).toEqual([
      expect.objectContaining({ path: missing }), expect.objectContaining({ path: other })
    ])
  })
})

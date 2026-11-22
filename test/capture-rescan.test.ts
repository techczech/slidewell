import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppHandle } from '../src/main/app-handle'
import type { ScanOptions } from '../src/main/triage'

const { scan, closeWatcher } = vi.hoisted(() => ({ scan: vi.fn(), closeWatcher: vi.fn() }))
const app = new EventEmitter()
const handlers = new Map<string, Parameters<AppHandle>[1]>()
vi.mock('electron', () => ({
  app,
  ipcMain: { handle: (channel: string, handler: Parameters<AppHandle>[1]) => handlers.set(channel, handler) },
  clipboard: {},
  dialog: {}
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
const mainWindow = { webContents: { send }, isVisible, isMinimized } as NonNullable<ReturnType<InstallDeps['getMainWindow']>>
const event = { sender: mainWindow.webContents } as Electron.IpcMainInvokeEvent
const scanResult = { indexed: 1, total: 1, offline: 0 }

function install() {
  let config = { captureSources: [{ path: extra, namedOnly: true }] }
  return createCaptureSources({ readConfig: () => config, screenshotRootResolved: () => __dirname }).install({
    appHandle: (channel, fn) => void handlers.set(channel, fn),
    getMainWindow: () => mainWindow,
    fromMainWindow: (sender) => sender === event.sender,
    fromAppWindow: () => true,
    archiveRoot: () => '/archive',
    wellRootResolved: () => '/well',
    writeConfig: (patch) => { config = { ...config, ...patch } },
    swThumb: () => null,
    pictureSearch: null,
    review: { filesChanged } as unknown as InstallDeps['review'],
    retrainer: { noteAnswer: vi.fn() }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  isVisible.mockReturnValue(true)
  isMinimized.mockReturnValue(false)
  scan.mockReset().mockResolvedValue(scanResult)
  send.mockClear()
  filesChanged.mockClear()
  closeWatcher.mockClear()
  handlers.clear()
})

afterEach(() => {
  app.emit('will-quit')
  app.removeAllListeners()
  vi.useRealTimers()
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
    handlers.get('settings:remove-capture-source')!(event, extra)
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

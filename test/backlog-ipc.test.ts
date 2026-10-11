// Backlog import IPC (ticket 15): Stop stays stopped. A cancelled run's completion must not start a
// downloading scan, and the capture watcher's follow-up scans do not download until the next explicit
// user action. Electron and the import itself are stand-ins; the IPC module and the gate are real.
import { describe, it, expect, vi } from 'vitest'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
vi.mock('electron', () => ({
  app: { on: () => undefined },
  shell: { openPath: async () => '' },
  ipcMain: { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) }
}))
vi.mock('../src/main/cleanshot-folder', () => ({
  cleanShotNameTemplate: async () => null,
  cleanShotSetting: async () => null,
  setCleanShotExportPath: async () => null
}))
// a run that downloads until it is stopped (cancel aborts its signal), or finishes when told to
let finishRun: () => void = () => undefined
vi.mock('../src/main/backlog-import', () => ({
  real: async (p: string | null) => p,
  dryRun: async () => ({ ok: true, items: [{ from: '/scratch/Desktop/a.png' }] }),
  runImport: (_plan: unknown, _env: unknown, o: { signal: AbortSignal }) =>
    new Promise((resolve) => {
      finishRun = () => resolve({ cancelled: false })
      o.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true })
    })
}))
const { registerBacklogIpc } = await import('../src/main/backlog-ipc')
const { createCaptureDownloads } = await import('../src/main/capture-downloads')

const sender = { isDestroyed: () => false, send: () => undefined }
const call = (ch: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(ch)!({ sender }, ...args))
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('backlog IPC: Stop stays stopped', () => {
  it('cancel → the run ends → its follow-up scan and later watcher scans never download; a new run resumes', async () => {
    handlers.clear()
    const gate = createCaptureDownloads()
    const root = '/scratch/Desktop'
    // what index.ts does: afterRun scans every source with downloads only if the run was not stopped
    const followUps: Array<{ downloadRoot: string | null; aborted: boolean }> = []
    registerBacklogIpc({
      watchedFolder: () => '/scratch/Triage',
      stateDir: () => '/scratch/state',
      isMainWindow: () => true,
      captureDownloads: gate,
      afterRun: ({ stopped }) => {
        const o = gate.options(stopped ? null : root)
        followUps.push({ downloadRoot: o.downloadRoot, aborted: o.signal.aborted })
      }
    })

    // a watcher scan is downloading while the import runs
    const watcherScan = gate.options(root)
    const { id } = (await call('backlog:dry-run')) as { id: string }
    const running = call('backlog:run', id)
    await tick()
    expect(watcherScan.downloadRoot).toBe(root)

    // Stop
    expect(await call('backlog:cancel')).toBe(true)
    await running
    expect(watcherScan.signal.aborted).toBe(true) // its download child is killed
    expect(followUps).toEqual([{ downloadRoot: null, aborted: true }]) // the cancelled run's scan does not download
    // a watcher event after Stop: still no download, still the stopped signal
    expect(gate.options(root)).toMatchObject({ downloadRoot: null })
    expect(gate.options(root).signal.aborted).toBe(true)

    // the next explicit action (a new run) turns downloading back on; a finished run's scan downloads
    const again = (await call('backlog:dry-run')) as { id: string }
    const second = call('backlog:run', again.id)
    await tick()
    expect(gate.options(root)).toMatchObject({ downloadRoot: root })
    finishRun()
    await second
    expect(followUps[1]).toEqual({ downloadRoot: root, aborted: false })
  })

  it('an explicit Scan resumes; a new process starts resumed', () => {
    const gate = createCaptureDownloads()
    expect(gate.options('/r').downloadRoot).toBe('/r')
    gate.stop()
    expect(gate.stopped).toBe(true)
    expect(gate.options('/r').downloadRoot).toBeNull()
    gate.resume()
    expect(gate.options('/r')).toMatchObject({ downloadRoot: '/r' })
    expect(gate.options('/r').signal.aborted).toBe(false)
  })
})

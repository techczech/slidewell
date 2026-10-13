import { describe, it, expect, beforeEach, vi } from 'vitest'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerTeachIpc } = await import('../src/main/sorter/teach-ipc')

const sender = { id: 1 }
const call = (channel: string, ...args: unknown[]): unknown => ipc.get(channel)!({ sender }, ...args)
let calls: Array<[string, ...unknown[]]>

beforeEach(() => {
  ipc.clear()
  calls = []
  registerTeachIpc({
    allowed: (s) => s === sender,
    teachQueue: async (after, limit) => (calls.push(['queue', after, limit]), { total: 0, items: [], next: null }),
    learning: async () => (calls.push(['learning']), { verdict: 'not-enough', more: 92, minimum: 92, choices: 0, kept: 0, thrownAway: 0, heldBack: 0, points: [], trainedAt: null }),
    retrain: async (trigger) => (calls.push(['retrain', trigger]), { ok: true }),
    setAuto: (patch) => (calls.push(['auto', patch]), { ok: true, autoRetrain: true, autoRetrainOnBattery: false })
  })
})

describe('IPC: teaching the sorter', () => {
  const CHANNELS = ['sorter:teach-queue', 'sorter:learning', 'sorter:retrain-now', 'sorter:set-auto-retrain']

  it('registers the four channels and answers the main window only', () => {
    expect([...ipc.keys()].sort()).toEqual([...CHANNELS].sort())
    for (const ch of CHANNELS) expect(() => ipc.get(ch)!({ sender: { id: 2 } }, null), ch).toThrow(/not allowed/)
    expect(calls).toEqual([])
  })

  it('teach-queue takes a cursor and a page size, and refuses anything else', async () => {
    await call('sorter:teach-queue')
    await call('sorter:teach-queue', null, 10)
    await call('sorter:teach-queue', '[0.1,-5,"abc"]', 500)
    expect(calls).toEqual([['queue', null, undefined], ['queue', null, 10], ['queue', '[0.1,-5,"abc"]', 500]])
    for (const bad of [[7], [{}], ['x'.repeat(401)], [null, 0], [null, 501], [null, 2.5], [null, '10'], [null, Number.NaN]]) {
      expect(() => call('sorter:teach-queue', ...bad), JSON.stringify(bad).slice(0, 40)).toThrow('sorter:teach-queue: bad arguments')
    }
    expect(calls).toHaveLength(3)
  })

  it('retrain-now is manual unless the round ended; a retrain by itself cannot be asked for', async () => {
    await call('sorter:retrain-now')
    await call('sorter:retrain-now', 'manual')
    await call('sorter:retrain-now', 'round')
    expect(calls).toEqual([['retrain', 'manual'], ['retrain', 'manual'], ['retrain', 'round']])
    for (const bad of ['auto', 'nightly', 1, {}, true]) expect(() => call('sorter:retrain-now', bad), String(bad)).toThrow('sorter:retrain-now: bad arguments')
    expect(calls).toHaveLength(3)
  })

  it('learning and set-auto-retrain pass through (the patch is checked where it is stored)', async () => {
    expect(await call('sorter:learning')).toMatchObject({ verdict: 'not-enough', more: 92 })
    expect(call('sorter:set-auto-retrain', { onBattery: true })).toEqual({ ok: true, autoRetrain: true, autoRetrainOnBattery: false })
    expect(calls).toEqual([['learning'], ['auto', { onBattery: true }]])
  })
})

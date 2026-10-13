import { describe, it, expect, beforeEach, vi } from 'vitest'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerTeachIpc, RETRAIN_REFUSED } = await import('../src/main/sorter/teach-ipc')
const { Retrainer } = await import('../src/main/sorter/retrain')
const REFUSED = { ok: false, error: 'That is not a training the sorter knows how to start.' }

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
    for (const bad of [[7], [{}], ['x'.repeat(401)], [null, 0], [null, 501], [null, 2.5], [null, '10'], [null, Number.NaN], [null, null]]) {
      expect(() => call('sorter:teach-queue', ...bad), JSON.stringify(bad).slice(0, 40)).toThrow('sorter:teach-queue: bad arguments')
    }
    expect(calls).toHaveLength(3)
  })

  it('teach-queue refuses a cursor that does not decode, rather than starting again from the first page', () => {
    for (const bad of ['not-json', '', '[]', '[0.1,-5]', '[0.1,-5,"abc",1]', '["0.1",-5,"abc"]', '[0.1,-5,7]', '{"0":0.1,"1":-5,"2":"abc"}', '[1e999,-5,"abc"]', 'null', `[0.1,-5,"${'a'.repeat(400)}"]`]) {
      expect(() => call('sorter:teach-queue', bad, 10), bad.slice(0, 40)).toThrow('sorter:teach-queue: bad arguments')
    }
    expect(calls).toEqual([])
  })

  it('every handler refuses an argument it does not take', () => {
    const cursor = '[0.1,-5,"abc"]'
    expect(() => call('sorter:teach-queue', cursor, 10, 'more')).toThrow('sorter:teach-queue: bad arguments')
    expect(() => call('sorter:teach-queue', null, 10, undefined)).toThrow('sorter:teach-queue: bad arguments')
    expect(() => call('sorter:learning', 'now')).toThrow('sorter:learning: bad arguments')
    expect(() => call('sorter:learning', undefined)).toThrow('sorter:learning: bad arguments')
    expect(call('sorter:retrain-now', 'manual', 'auto')).toEqual(REFUSED)
    expect(call('sorter:retrain-now', 'round', undefined)).toEqual(REFUSED)
    expect(calls).toEqual([])
  })

  it('teach-queue and learning have no refusal value: every bad call, by type or by count, rejects the same way', () => {
    for (const bad of [[7], [null, 0], [null, 10, 'more'], [null, 10, undefined], ['not-json']]) expect(() => call('sorter:teach-queue', ...bad), JSON.stringify(bad)).toThrow('sorter:teach-queue: bad arguments')
    for (const bad of [['now'], [undefined], [null], [{}, {}]]) expect(() => call('sorter:learning', ...bad), JSON.stringify(bad)).toThrow('sorter:learning: bad arguments')
    expect(calls).toEqual([])
  })

  it('retrain-now answers its refusal for every bad call, by type or by count, and never throws', () => {
    for (const bad of [['auto'], [null], [1], ['manual', 'auto'], ['round', undefined], ['manual', 'round', 'manual'], [undefined, undefined]]) {
      let got: unknown
      expect(() => (got = call('sorter:retrain-now', ...bad)), JSON.stringify(bad)).not.toThrow()
      expect(got, JSON.stringify(bad)).toEqual(REFUSED)
    }
    expect(REFUSED.error).toBe(RETRAIN_REFUSED)
    expect(calls).toEqual([])
  })

  it('retrain-now is manual unless the round ended; a retrain by itself cannot be asked for', async () => {
    await call('sorter:retrain-now')
    await call('sorter:retrain-now', 'manual')
    await call('sorter:retrain-now', 'round')
    expect(calls).toEqual([['retrain', 'manual'], ['retrain', 'manual'], ['retrain', 'round']])
    for (const bad of ['auto', 'nightly', 1, {}, true, null, '', ['manual']]) expect(call('sorter:retrain-now', bad), String(bad)).toEqual(REFUSED)
    expect(calls).toHaveLength(3)
  })

  it('learning and set-auto-retrain pass through (the patch is checked where it is stored)', async () => {
    expect(await call('sorter:learning')).toMatchObject({ verdict: 'not-enough', more: 92 })
    expect(call('sorter:set-auto-retrain', { onBattery: true })).toEqual({ ok: true, autoRetrain: true, autoRetrainOnBattery: false })
    expect(calls).toEqual([['learning'], ['auto', { onBattery: true }]])
  })
})

describe('IPC: set-auto-retrain over the real switches', () => {
  /** The handler over a Retrainer whose switches are stored as { enabled: true, onBattery: false }. */
  function wired(): { stored: () => unknown; saves: () => number; trains: () => number } {
    let settings: { enabled: boolean; onBattery: boolean } = { enabled: true, onBattery: false }
    let saves = 0
    let trains = 0
    const retrainer = new Retrainer({
      train: async () => (trains++, { ok: false, error: 'not in this test' }),
      choices: () => ({ learnable: { kept: 228, binned: 84 }, trainedWith: 312 }),
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => settings,
      saveSettings: (s) => void (saves++, (settings = s)),
      lastRetrain: () => null,
      saveLastRetrain: () => undefined,
      defer: () => undefined
    })
    ipc.clear()
    registerTeachIpc({ allowed: (s) => s === sender, teachQueue: async () => ({ total: 0, items: [], next: null }), learning: async () => ({}) as never, retrain: (t) => retrainer.retrain(t), setAuto: (patch) => retrainer.setAuto(patch) })
    return { stored: () => settings, saves: () => saves, trains: () => trains }
  }
  const refusal = { ok: false, autoRetrain: true, autoRetrainOnBattery: false, error: 'That is not a setting the sorter knows.' }

  it('no argument, or more than one, answers the same refusal as a bad patch: the switches as stored, nothing saved, no throw', () => {
    const a = wired()
    const bads: unknown[][] = [[], [{ enabled: false }, { onBattery: true }], [{ enabled: false }, undefined], [{ enabled: false }, 'more', 3], [undefined, { enabled: false }], [null], ['on'], [{ enabled: 'yes' }], [{ every: 5 }], [{}]]
    for (const bad of bads) {
      let got: unknown
      expect(() => (got = call('sorter:set-auto-retrain', ...bad)), JSON.stringify(bad)).not.toThrow()
      expect(got, JSON.stringify(bad)).toEqual(refusal)
    }
    expect(a.saves()).toBe(0)
    expect(a.stored()).toEqual({ enabled: true, onBattery: false })
    expect(a.trains()).toBe(0)
  })

  it('one good patch is stored and answered with both switches', () => {
    const a = wired()
    expect(call('sorter:set-auto-retrain', { enabled: false })).toEqual({ ok: true, autoRetrain: false, autoRetrainOnBattery: false })
    expect(call('sorter:set-auto-retrain', { onBattery: true })).toEqual({ ok: true, autoRetrain: false, autoRetrainOnBattery: true })
    expect(a.stored()).toEqual({ enabled: false, onBattery: true })
    expect(a.saves()).toBe(2)
  })
})

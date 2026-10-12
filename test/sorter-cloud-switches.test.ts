// The cloud step's settings split (ticket 18): the service on or off keeps provider, keys and
// agreements; the nightly batch and second opinions are switches of their own; and the status carries
// the agreement times, tonight's allowance and the last run as numbers. Everything goes through the
// IPC handlers, as the renderer would. Fake transport only (sorter-cloud-fixture.ts); synthetic data,
// made-up keys.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const ipc = vi.hoisted(() => new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { CloudSorter, NIGHTLY_LIMIT, SWITCH_REFUSED, applySettingsPatch, normaliseCloudSettings, registerCloudIpc, withdrawAgreement } = await import('../src/main/sorter/cloud/service')
const { isBatchDue } = await import('../src/main/sorter/cloud/schedule')
const { SorterStore } = await import('../src/main/sorter/store')
const { DEFAULT_THRESHOLDS, SORTER_VERSION } = await import('../src/main/sorter/decide')
const { makeCloudWell, bothStubs, cloudDeps, hashOf, ANTHROPIC_URL, OPENAI_URL, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY } = await import('./sorter-cloud-fixture')
import type { ShotSpec, Says } from './sorter-cloud-fixture'
type StoredCloudSettings = import('../src/main/sorter/cloud/service').StoredCloudSettings
type CloudStatus = import('../src/main/sorter/cloud/service').CloudStatus
type CloudRunSummary = import('../src/main/sorter/cloud/service').CloudRunSummary
type CloudPreview = import('../src/main/sorter/cloud/service').CloudPreview
type ProviderId = import('../src/main/sorter/cloud/provider').ProviderId

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
const well = (shots: ShotSpec[]): string => {
  const w = makeCloudWell(shots)
  dirs.push(w)
  return w
}
/** With the fixture's stubs: d1 keep, d2 throwaway, d3 a weak throwaway (unsure), d4 unsure; d5 unsure and the oldest. */
const SHOTS: ShotSpec[] = [
  { hash: 'd1', proposal: 'doubtful', window: 'keep-chart', takenAt: '2026-10-04T10:00:00' },
  { hash: 'd2', proposal: 'doubtful', window: 'toss-wifi', takenAt: '2026-10-03T10:00:00' },
  { hash: 'd3', proposal: 'doubtful', window: 'weak-picker', takenAt: '2026-10-02T10:00:00' },
  { hash: 'd4', proposal: 'doubtful', window: 'blurry', takenAt: '2026-10-01T10:00:00' },
  { hash: 'd5', proposal: 'doubtful', window: 'fresh', takenAt: '2026-09-30T10:00:00' }
]
const four = (): string => well(SHOTS.slice(0, 4))
const five = (): string => well(SHOTS)
const many = (n: number): string => well(Array.from({ length: n }, (_, i) => ({ hash: `m${i}`, proposal: 'doubtful' as const, window: `blurry-${i}`, takenAt: `2026-10-01T10:${String(i).padStart(2, '0')}:00` })))
const unsure: Says = () => ({ verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.' })

const T1 = '2026-10-05T09:00:00.000Z'
const NIGHT1 = '2026-10-10'
const night1 = (): Date => new Date(2026, 9, 11, 2, 0)
const night2 = (): Date => new Date(2026, 9, 12, 2, 0)
const BOTH: StoredCloudSettings = { provider: 'openai', optedInAt: T1, anthropicOptedInAt: T1 }

const withStore = <T>(w: string, fn: (s: InstanceType<typeof SorterStore>) => T): T => {
  const s = new SorterStore(w)
  try {
    return fn(s)
  } finally {
    s.close()
  }
}
const useAllowance = (w: string, night: string, sent: number): void => {
  const db = new DatabaseSync(join(w, 'triage.db'))
  db.prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?) ON CONFLICT(night) DO UPDATE SET sent = excluded.sent').run(night, sent)
  db.close()
}
const claimsLeft = (w: string): number => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM sorter_cloud_claims').get() as { n: number }).n)
  } finally {
    db.close()
  }
}
const sent = (stub: { seen: Array<{ windows: string[] }> }): string[] => stub.seen.flatMap((r) => r.windows).sort()

/**
 * The app as index.ts wires it: config (the box) → normaliseCloudSettings; settings saved by merging
 * into the box, one write per call; each provider's key in its own field of the same config (the
 * made-up key stands in for its ciphertext); every change made through the IPC handlers.
 * `answers` are what main's dialog returns, in order (then: confirmed). `writes` is the config after
 * each write; `failWrite` makes the next write throw before anything is stored.
 */
function app(w: string, stored: Record<string, unknown>, extra: Parameters<typeof cloudDeps>[1] = {}, answers: boolean[] = []) {
  type Cfg = StoredCloudSettings & { keyEnc?: string; anthropicKeyEnc?: string }
  const FIELD = { openai: 'keyEnc', anthropic: 'anthropicKeyEnc' } as const
  const box = { stored: { keyEnc: FAKE_OPENAI_KEY, anthropicKeyEnc: FAKE_ANTHROPIC_KEY, ...stored } as Cfg }
  const writes: Cfg[] = []
  const fail = { next: false }
  const write = (s: Cfg): void => {
    if (fail.next) {
      fail.next = false
      throw new Error('config.json could not be written')
    }
    box.stored = JSON.parse(JSON.stringify({ ...box.stored, ...s })) // as writeConfig does: what is undefined is not stored
    writes.push(box.stored)
  }
  const keys = {
    get openai(): string | null {
      return box.stored.keyEnc ?? null
    },
    get anthropic(): string | null {
      return box.stored.anthropicKeyEnc ?? null
    }
  }
  const access = (id: ProviderId) => ({ get: () => keys[id], has: () => Boolean(keys[id]), encryptionAvailable: () => true })
  const net = bothStubs()
  const d = cloudDeps(w, { http: net.http, ...extra, key: access('openai'), anthropicKey: access('anthropic') })
  d.settings = () => normaliseCloudSettings(box.stored)
  d.confirm = async (p) => {
    d.prompts.push(p)
    return answers.length ? (answers.shift() as boolean) : true
  }
  const svc = new CloudSorter(d)
  ipc.clear()
  // as ApiKeyStore: a key is saved, or removed, by a write of its own field
  const keyStore = (id: ProviderId) => ({ set: (k: unknown) => (write({ [FIELD[id]]: String(k) }), { ok: true, saved: true }), clear: () => write({ [FIELD[id]]: undefined }) })
  registerCloudIpc(svc, { openai: keyStore('openai'), anthropic: keyStore('anthropic') }, write, () => box.stored, () => true)
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => new Promise<T>((resolve) => resolve(ipc.get(channel)!({ sender: null }, ...args) as T))
  return { svc, d, box, net, keys, writes, failWrite: () => void (fail.next = true), call, set: (patch: unknown) => call<CloudStatus>('cloud:set-settings', patch) }
}
type Switched = { ok: boolean; error?: string; status: CloudStatus }
/** Everything that is not true or false, as it might arrive from a renderer. */
const NOT_SWITCHES = [null, undefined, 'true', 'false', 'on', 1, 0, {}, [], { value: true }, { on: true }]

describe('existing configs read exactly as before', () => {
  it('a config written before ticket 18 has no enabled, nightly or secondOpinions: on iff the selected provider is agreed to, nightly on, second opinions on', () => {
    expect(normaliseCloudSettings(undefined)).toMatchObject({ enabled: false, nightly: true, secondOpinions: true })
    expect(normaliseCloudSettings({})).toMatchObject({ enabled: false, nightly: true, secondOpinions: true })
    expect(normaliseCloudSettings({ optedInAt: T1, batchTime: '03:30' })).toEqual({ enabled: true, batchTime: '03:30', provider: 'openai', nightly: true, secondOpinions: true, agreedAt: { openai: T1, anthropic: null } })
    expect(normaliseCloudSettings({ provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: null })).toMatchObject({ enabled: false, nightly: true, secondOpinions: true })
    expect(normaliseCloudSettings({ provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: T1 })).toMatchObject({ enabled: true, provider: 'anthropic', agreedAt: { openai: T1, anthropic: T1 } })
  })

  it('such a config still runs its nightly batch, second opinions included, and its Sort now', async () => {
    const w = five()
    let now = new Date(2026, 9, 10, 9, 0)
    useAllowance(w, NIGHT1, NIGHTLY_LIMIT - 4) // Luna gets d1..d4 only; d3 and d4 stay unsure, d5 is not asked about
    const a = app(w, { provider: 'openai', optedInAt: T1, anthropicOptedInAt: T1 }, { now: () => now })
    expect(await a.svc.tick()).toBeNull() // starts the clock
    now = night1()
    expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', provider: 'openai', asked: 4 })
    expect(a.svc.status().nextRunAt).not.toBeNull()
    await a.set({ provider: 'anthropic' })
    expect(a.d.prompts).toHaveLength(0) // already agreed to
    now = night2()
    expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', provider: 'anthropic', asked: 3 })
    expect(sent(a.net.haiku)).toEqual(['blurry', 'fresh', 'weak-picker']) // d3 and d4 as second opinions, d5 for the first time
  })
})

describe('the two switches never read as on by accident', () => {
  it('stored as null or as anything but true, nightly and second opinions are off; enabled likewise, whatever the agreement', () => {
    for (const v of [null, 'true', 'on', 1, 0, {}, []]) {
      expect(normaliseCloudSettings({ ...BOTH, nightly: v }).nightly).toBe(false)
      expect(normaliseCloudSettings({ ...BOTH, secondOpinions: v }).secondOpinions).toBe(false)
      expect(normaliseCloudSettings({ ...BOTH, enabled: v }).enabled).toBe(false)
    }
    expect(normaliseCloudSettings({ ...BOTH, nightly: false, secondOpinions: false, enabled: false })).toMatchObject({ enabled: false, nightly: false, secondOpinions: false })
    expect(normaliseCloudSettings({ ...BOTH, nightly: true, secondOpinions: true, enabled: true })).toMatchObject({ enabled: true, nightly: true, secondOpinions: true })
    // enabled: true is not an agreement
    expect(normaliseCloudSettings({ enabled: true, nightly: true })).toMatchObject({ enabled: false })
  })

  it('a malformed stored switch stays off through an unrelated settings change', () => {
    const next = applySettingsPatch({ ...BOTH, nightly: null, secondOpinions: 'yes' } as never, { batchTime: '04:00' }, new Date(T1))
    expect(next).toMatchObject({ nightly: false, secondOpinions: false, batchTime: '04:00', enabled: true })
  })

  it('the settings patch cannot set either switch, an agreement or its time; only true or false reaches the two setters', async () => {
    const a = app(four(), { ...BOTH, enabled: false, nightly: false, secondOpinions: false, anthropicOptedInAt: null })
    await a.set({ nightly: true, secondOpinions: true, anthropicOptedInAt: T1, agreedAt: { anthropic: T1 }, batchTime: '05:00' })
    expect(a.box.stored).toMatchObject({ enabled: false, nightly: false, secondOpinions: false, anthropicOptedInAt: null, batchTime: '05:00' })
    for (const v of NOT_SWITCHES) {
      expect(await a.call<Switched>('cloud:set-nightly', v)).toMatchObject({ ok: false, error: SWITCH_REFUSED, status: { settings: { nightly: false } } })
      expect(await a.call<Switched>('cloud:set-second-opinions', v)).toMatchObject({ ok: false, error: SWITCH_REFUSED, status: { settings: { secondOpinions: false } } })
    }
    expect(a.box.stored).toMatchObject({ nightly: false, secondOpinions: false })
    expect(await a.call<Switched>('cloud:set-nightly', true)).toMatchObject({ ok: true, status: { settings: { nightly: true, enabled: false } } })
    expect(await a.call<Switched>('cloud:set-second-opinions', true)).toMatchObject({ ok: true, status: { settings: { secondOpinions: true, enabled: false } } })
    // and a refused value leaves a switch that is on, on
    for (const v of NOT_SWITCHES) await a.call('cloud:set-nightly', v)
    expect(a.box.stored).toMatchObject({ nightly: true, secondOpinions: true, enabled: false })
    expect(a.d.prompts).toHaveLength(0)
    expect(a.net.urls).toEqual([])
  })
})

describe('the service off keeps the provider, both keys and both agreements', () => {
  it('off, then on again for a provider he agreed to: no dialog, the same agreement time, the keys untouched', async () => {
    const a = app(four(), { provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: T1 })
    const off = await a.set({ enabled: false })
    expect(off.settings).toMatchObject({ enabled: false, provider: 'anthropic', agreedAt: { openai: T1, anthropic: T1 } })
    expect(off.providers.map((p) => [p.id, p.hasKey, p.agreedAt])).toEqual([['openai', true, T1], ['anthropic', true, T1]])
    expect(a.box.stored).toMatchObject({ enabled: false, provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: T1 })
    expect(a.keys).toEqual({ openai: FAKE_OPENAI_KEY, anthropic: FAKE_ANTHROPIC_KEY })
    // off is off: neither path sends, agreement or not
    expect(await a.call<CloudPreview>('cloud:prepare')).toMatchObject({ blocked: 'off', token: null })
    expect(await a.svc.runNightly()).toMatchObject({ skipped: 'off', asked: 0 })
    expect(a.net.urls).toEqual([])
    const on = await a.set({ enabled: true })
    expect(a.d.prompts).toHaveLength(0)
    expect(on.settings).toMatchObject({ enabled: true, provider: 'anthropic', agreedAt: { openai: T1, anthropic: T1 } })
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'anthropic', asked: 4 })
    expect(new Set(a.net.urls)).toEqual(new Set([ANTHROPIC_URL]))
  })

  it('agreement is still per provider: on again with a provider he never agreed to raises its dialog, and declined it stays off', async () => {
    const a = app(four(), { provider: 'openai', optedInAt: T1 }, {}, [false])
    await a.set({ enabled: false })
    await a.set({ provider: 'anthropic' })
    expect(a.d.prompts).toHaveLength(0)
    const st = await a.set({ enabled: true })
    expect(a.d.prompts.map((p) => [p.kind, p.provider])).toEqual([['turn-on', 'anthropic']])
    expect(st.settings).toMatchObject({ enabled: false, provider: 'anthropic', agreedAt: { openai: T1, anthropic: null } })
    expect(await a.svc.runNightly()).toMatchObject({ skipped: 'off', asked: 0 })
    expect(a.net.urls).toEqual([])
  })

  it('removing a key withdraws the agreement to that provider and to no other; a key saved later does not bring it back', async () => {
    const a = app(four(), { ...BOTH })
    const st = await a.call<CloudStatus>('cloud:clear-key', 'openai')
    expect(st.settings).toMatchObject({ enabled: false, provider: 'openai', agreedAt: { openai: null, anthropic: T1 } })
    expect(a.box.stored).toMatchObject({ enabled: false, optedInAt: null, anthropicOptedInAt: T1 })
    await a.call('cloud:set-key', 'openai', FAKE_OPENAI_KEY)
    expect(a.svc.status().settings.enabled).toBe(false) // a saved key turns nothing on
    expect(await a.svc.runNightly()).toMatchObject({ skipped: 'off', asked: 0 })
    expect(a.net.urls).toEqual([])
    await a.set({ enabled: true })
    expect(a.d.prompts.map((p) => [p.kind, p.provider])).toEqual([['turn-on', 'openai']])
    // the other provider's key removed while it is not selected: the service stays on for the selected one
    await a.call('cloud:clear-key', 'anthropic')
    expect(a.svc.status().settings).toMatchObject({ enabled: true, provider: 'openai', agreedAt: { anthropic: null } })
    expect(withdrawAgreement({ ...BOTH, enabled: null } as never, 'anthropic')).toEqual({ enabled: false, optedInAt: T1, anthropicOptedInAt: null })
  })

  it('turning the service off cancels a prepared send, even when it is on again before the click', async () => {
    const a = app(four(), { ...BOTH })
    const p = await a.call<CloudPreview>('cloud:prepare')
    expect(p).toMatchObject({ blocked: null, toSend: 4 })
    await a.set({ enabled: false })
    await a.set({ enabled: true })
    expect(a.d.prompts).toHaveLength(0)
    expect(await a.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0, sent: 0 })
    expect(a.net.urls).toEqual([])
  })

  it('turned off while main’s dialog is open, the send goes nowhere; nor does it when it is on again by the time he confirms', async () => {
    for (const backOn of [false, true]) {
      const a = app(four(), { ...BOTH })
      const p = await a.call<CloudPreview>('cloud:prepare')
      a.d.confirm = async () => {
        await a.set({ enabled: false })
        if (backOn) await a.set({ enabled: true })
        return true
      }
      const s = await a.call<CloudRunSummary>('cloud:send', p.token)
      expect(s).toMatchObject({ asked: 0, skipped: backOn ? 'not-prepared' : 'off' })
      expect(s.message).toMatch(/^(Nothing was sent|Luna was not asked)/)
      expect(a.net.urls).toEqual([])
      expect(withStore(a.d.wellRoot(), (st) => st.allowanceUsed(NIGHT1))).toBe(0)
    }
  })

  it('turned off while a batch is running, the run stops there; turned on again, the rest goes without a new dialog', async () => {
    const w = many(32)
    const a = app(w, { ...BOTH })
    const stub = bothStubs({ delayMs: 20 })
    let calls = 0
    a.d.http = async (u, init) => {
      calls++
      if (calls === 1) await a.set({ enabled: false })
      const r = await stub.http(u, init)
      if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }) // as net.fetch does
      return r
    }
    const s = await a.svc.runNightly()
    expect(s.skipped).toBe('off')
    expect(calls).toBeLessThanOrEqual(2) // the two already started together; the third never went
    expect(claimsLeft(w)).toBe(0)
    expect(a.box.stored).toMatchObject({ enabled: false, optedInAt: T1 })
    await a.set({ enabled: true })
    expect(a.d.prompts).toHaveLength(0)
    a.d.http = stub.http
    expect((await a.svc.runNightly()).asked).toBeGreaterThan(0)
  })
})

describe('nightly sorting is its own switch', () => {
  it('off: no nightly batch at its time, the local sorter is not run and nothing is sent; Sort now still works; on again, the batch runs', async () => {
    const w = four()
    let now = new Date(2026, 9, 10, 9, 0)
    const a = app(w, { ...BOTH }, { now: () => now })
    expect(await a.svc.tick()).toBeNull() // starts the clock
    const off = await a.call<Switched>('cloud:set-nightly', false)
    expect(off).toMatchObject({ ok: true, status: { nextRunAt: null, settings: { enabled: true, nightly: false } } })
    now = night1()
    expect(await a.svc.tick()).toBeNull()
    expect(a.d.localRuns).toBe(0)
    expect(a.net.urls).toEqual([])
    expect(a.d.stateBox.lastRunAt).toBeNull()
    // Sort now needs only the service on
    const p = await a.call<CloudPreview>('cloud:prepare')
    expect(p).toMatchObject({ blocked: null, toSend: 4 })
    useAllowance(w, NIGHT1, NIGHTLY_LIMIT - 1)
    const p1 = await a.call<CloudPreview>('cloud:prepare')
    expect(await a.call<CloudRunSummary>('cloud:send', p1.token)).toMatchObject({ trigger: 'manual', asked: 1, sent: 1 })
    expect(a.net.urls).toEqual([OPENAI_URL])
    // on again: the next slot runs
    const on = await a.call<Switched>('cloud:set-nightly', true)
    expect(on.status.nextRunAt).not.toBeNull()
    now = night2()
    expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', asked: 3 })
  })

  it('needs the service on as well: with the service off, the nightly switch on runs nothing', async () => {
    let now = new Date(2026, 9, 10, 9, 0)
    const a = app(four(), { ...BOTH, enabled: false, nightly: true }, { now: () => now })
    await a.svc.tick()
    now = night1()
    expect(await a.svc.tick()).toBeNull()
    expect(a.svc.status().nextRunAt).toBeNull()
    expect(a.d.localRuns).toBe(0)
    expect(a.net.urls).toEqual([])
  })

  it('a nightly switch stored as null is off', async () => {
    let now = new Date(2026, 9, 10, 9, 0)
    const a = app(four(), { ...BOTH, nightly: null }, { now: () => now })
    await a.svc.tick()
    now = night1()
    expect(await a.svc.tick()).toBeNull()
    expect(a.svc.status()).toMatchObject({ nextRunAt: null, settings: { nightly: false, enabled: true } })
    // asked for directly, the nightly batch still does nothing
    expect(await a.svc.runNightly()).toMatchObject({ skipped: 'nightly-off', asked: 0, message: 'Luna was not asked: nightly sorting is turned off.' })
    expect(a.d.localRuns).toBe(0)
    expect(a.net.urls).toEqual([])
  })

  it('turned off while the nightly batch is running, the batch stops before its next request', async () => {
    const w = many(32)
    const a = app(w, { ...BOTH })
    const stub = bothStubs({ delayMs: 20 })
    let calls = 0
    a.d.http = async (u, init) => {
      calls++
      if (calls === 1) await a.call('cloud:set-nightly', false)
      const r = await stub.http(u, init)
      if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return r
    }
    const s = await a.svc.runNightly()
    expect(s.skipped).toBe('nightly-off')
    expect(calls).toBeLessThanOrEqual(2) // at most the two started together; the third chunk was never sent
    expect(s.asked).toBeLessThanOrEqual(30)
    expect(claimsLeft(w)).toBe(0)
  })

  it('the switch turns nothing on and records no agreement', async () => {
    const a = app(four(), {})
    expect(await a.call<Switched>('cloud:set-nightly', true)).toMatchObject({ ok: true, status: { nextRunAt: null, settings: { enabled: false, nightly: true, agreedAt: { openai: null, anthropic: null } } } })
    expect(a.box.stored).toEqual({ keyEnc: FAKE_OPENAI_KEY, anthropicKeyEnc: FAKE_ANTHROPIC_KEY, nightly: true })
    expect(a.d.prompts).toHaveLength(0)
  })
})

describe('second opinions are a switch', () => {
  /** Night one: Luna answers d1..d4 (d3 and d4 unsure) and is not asked about d5. Then Haiku is selected. */
  async function afterLuna(stored: Record<string, unknown> = {}) {
    const w = five()
    let now = night1()
    useAllowance(w, NIGHT1, NIGHTLY_LIMIT - 4)
    const a = app(w, { ...BOTH, ...stored }, { now: () => now })
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'openai', asked: 4, keep: 1, throwaway: 1 })
    await a.set({ provider: 'anthropic' })
    now = night2()
    return a
  }

  it('off: the nightly batch asks the other provider only about what no provider has answered', async () => {
    const a = await afterLuna({ secondOpinions: false })
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'anthropic', asked: 1 })
    expect(sent(a.net.haiku)).toEqual(['fresh'])
    // and nothing is left for a later night
    expect(await a.svc.runNightly()).toMatchObject({ skipped: 'nothing-doubtful', asked: 0 })
  })

  it('off: Sort now counts and sends none of them, and main’s dialog names none', async () => {
    const a = await afterLuna()
    expect(await a.call<Switched>('cloud:set-second-opinions', false)).toMatchObject({ ok: true, status: { settings: { secondOpinions: false } } })
    const p = await a.call<CloudPreview>('cloud:prepare')
    expect(p).toMatchObject({ provider: 'anthropic', doubtful: 1, toSend: 1, secondOpinions: 0, secondNote: '' })
    expect(await a.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ asked: 1 })
    expect(a.d.prompts.at(-1)).toMatchObject({ kind: 'send', count: 1, secondOpinions: 0 })
    expect(sent(a.net.haiku)).toEqual(['fresh'])
  })

  it('a switch stored as null is off', async () => {
    const a = await afterLuna({ secondOpinions: null })
    expect(a.svc.status().settings.secondOpinions).toBe(false)
    expect(await a.call<CloudPreview>('cloud:prepare')).toMatchObject({ doubtful: 1, toSend: 1, secondOpinions: 0 })
  })

  it('changing the switch cancels a prepared batch, in either direction', async () => {
    for (const from of [true, false]) {
      const a = await afterLuna({ secondOpinions: from })
      const p = await a.call<CloudPreview>('cloud:prepare')
      expect(p).toMatchObject({ blocked: null, toSend: from ? 3 : 1, secondOpinions: from ? 2 : 0 })
      await a.call('cloud:set-second-opinions', !from)
      expect(await a.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
      expect(a.net.haiku.seen).toHaveLength(0)
      expect(a.d.prompts.filter((x) => x.kind === 'send')).toHaveLength(0)
    }
  })

  it('setting the switch to the position it already has leaves a prepared batch alone', async () => {
    const a = await afterLuna()
    const p = await a.call<CloudPreview>('cloud:prepare')
    await a.call('cloud:set-second-opinions', true)
    expect(await a.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ asked: 3 })
  })

  it('changed while main’s dialog is open, the send goes nowhere', async () => {
    const a = await afterLuna()
    const p = await a.call<CloudPreview>('cloud:prepare')
    expect(p.secondOpinions).toBe(2)
    a.d.confirm = async () => {
      await a.call('cloud:set-second-opinions', false)
      return true
    }
    const s = await a.call<CloudRunSummary>('cloud:send', p.token)
    expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(s.message).toBe('Nothing was sent. The second opinions setting was changed, so the count no longer holds. Press Sort now again.')
    expect(a.net.haiku.seen).toHaveLength(0)
    expect(withStore(a.d.wellRoot(), (st) => st.allowanceUsed('2026-10-11'))).toBe(0)
  })

  it('turned off while a batch is running, no further second opinion goes', async () => {
    const w = many(32)
    let now = night1()
    const a = app(w, { ...BOTH }, { now: () => now })
    a.d.http = bothStubs({ lunaSays: unsure }).http
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'openai', asked: 32, keep: 0, throwaway: 0 })
    await a.set({ provider: 'anthropic' })
    now = night2()
    const stub = bothStubs({ delayMs: 20 })
    let calls = 0
    a.d.http = async (u, init) => {
      calls++
      if (calls === 2) await a.call('cloud:set-second-opinions', false) // both first requests are out by now
      return stub.http(u, init)
    }
    const s = await a.svc.runNightly()
    expect(calls).toBe(2) // the third chunk held only second opinions: it was never sent
    expect(s.asked).toBe(30)
    expect(stub.haiku.seen.flatMap((r) => r.windows)).toHaveLength(30)
    expect(withStore(w, (st) => st.allowanceUsed('2026-10-11'))).toBe(30) // what did not go used none of tonight's allowance
    expect(claimsLeft(w)).toBe(0)
  })

  it('the store refuses them at every step: pending, claim and admission', async () => {
    const a = await afterLuna()
    const w = a.d.wellRoot()
    const me = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }
    const scope = (secondOpinions: boolean | undefined) => ({ sorterVersion: SORTER_VERSION, ...me, others: [{ provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1' }], throwawayAt: DEFAULT_THRESHOLDS.throwaway, secondOpinions })
    const all = ['d3', 'd4', 'd5'].map(hashOf)
    withStore(w, (st) => {
      expect(st.cloudPending(scope(true)).map((p) => p.hash).sort()).toEqual([...all].sort())
      expect(st.cloudPending(scope(undefined))).toHaveLength(3) // a scope from before the switch: allowed, as it was
      expect(st.cloudPending(scope(false)).map((p) => p.hash)).toEqual([hashOf('d5')])
      const run = { night: '2026-10-11', limit: NIGHTLY_LIMIT, runId: 'run-a', now: night2() }
      expect(st.claimForCloud(all, { ...scope(false), ...run }).claimed).toEqual([hashOf('d5')])
      st.releaseClaims('run-a')
      // claimed while the switch was on, admitted after it went off: only the first-time one goes and is counted
      expect(st.claimForCloud(all, { ...scope(true), ...run }).claimed).toEqual(all)
      expect(st.admitForRequest(all, { ...scope(false), ...run })).toEqual({ admitted: [hashOf('d5')], overLimit: 0 })
      expect(st.allowanceUsed('2026-10-11')).toBe(1)
    })
  })
})

describe('status for the Auto sorting tab', () => {
  it('says when he agreed to each provider and what is left of tonight’s allowance', async () => {
    const w = four()
    const a = app(w, { provider: 'openai', optedInAt: T1 }, { now: night1 })
    const before = a.svc.status()
    expect(before).toMatchObject({ nightlyLimit: 300, leftTonight: 300, settings: { agreedAt: { openai: T1, anthropic: null } } })
    expect(before.providers.map((p) => [p.id, p.agreedAt])).toEqual([['openai', T1], ['anthropic', null]])
    await a.svc.runNightly()
    expect(a.svc.status().leftTonight).toBe(296)
    useAllowance(w, NIGHT1, 500)
    expect(a.svc.status().leftTonight).toBe(0)
    expect(JSON.stringify(a.svc.status())).not.toMatch(/sk-/)
  })

  it('gives the last run as numbers, kept across a restart, with the sentence as before', async () => {
    const w = four()
    const a = app(w, { ...BOTH }, { now: night1 })
    const s = await a.svc.runNightly()
    expect(s).toMatchObject({ at: night1().toISOString(), trigger: 'nightly', provider: 'openai', asked: 4, sent: 4, settled: 2, stillUnsure: 2 })
    expect(s.message).toBe('Asked Luna about 4 screenshots: 1 keep, 1 throwaway. 2 screenshots still need a look.')
    expect(a.d.stateBox.lastRun).toEqual(s)
    // a restart: another service over the same stored state
    const again = new CloudSorter(a.d).status().lastRun
    expect(again).toEqual(s)
    // a manual run that asked nobody is numbers too
    const b = app(four(), { ...BOTH }, {}, [false])
    const p = await b.call<CloudPreview>('cloud:prepare')
    expect(await b.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ trigger: 'manual', sent: 0, settled: 0, stillUnsure: 0, skipped: 'not-confirmed' })
    expect(b.svc.status().lastRun).toMatchObject({ trigger: 'manual', sent: 0, skipped: 'not-confirmed' })
  })

  it('a summary stored before the numbers were kept gets them from its counts; anything that is not a summary is none', () => {
    const a = app(four(), { ...BOTH })
    const old = { at: '2026-10-09T02:00:00.000Z', trigger: 'nightly', local: null, asked: 9, answered: 9, keep: 4, throwaway: 2, stayedDoubtful: 11, skipped: null, error: null, message: 'Asked Luna about 9 screenshots: 4 keep, 2 throwaway. 11 screenshots still need a look.' }
    a.d.stateBox.lastRun = old as never
    expect(a.svc.status().lastRun).toEqual({ ...old, sent: 9, settled: 6, stillUnsure: 3 })
    for (const bad of ['yesterday', 7, { asked: 3 }, []]) {
      a.d.stateBox.lastRun = bad as never
      expect(a.svc.status().lastRun).toBeNull()
    }
  })
})

describe('second opinions off goes by who answered, not by which model', () => {
  it('an answer the other provider gave under an older model or prompt still keeps the screenshot from this one', async () => {
    const w = five()
    let now = night1()
    useAllowance(w, NIGHT1, NIGHTLY_LIMIT - 4)
    const a = app(w, { ...BOTH, secondOpinions: false }, { now: () => now })
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'openai', asked: 4 }) // d3 and d4 left unsure, d5 not asked about
    // Luna has since moved to another model and prompt: its stored answers are from the earlier ones
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("UPDATE sorter_cloud_answers SET model = 'luna-earlier-model', prompt_version = 'luna-earlier-prompt' WHERE provider = 'openai'").run()
    db.close()
    await a.set({ provider: 'anthropic' })
    now = night2()
    const me = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }
    const scope = (secondOpinions: boolean) => ({ sorterVersion: SORTER_VERSION, ...me, others: [{ provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1' }], throwawayAt: DEFAULT_THRESHOLDS.throwaway, secondOpinions })
    withStore(w, (st) => {
      expect(st.cloudPending(scope(false)).map((p) => p.hash)).toEqual([hashOf('d5')])
      // with second opinions on, the version rules stand: an answer under an earlier model is no answer
      expect(st.cloudPending(scope(true)).map((p) => p.hash).sort()).toEqual(['d3', 'd4', 'd5'].map(hashOf).sort())
      const run = { night: '2026-10-11', limit: NIGHTLY_LIMIT, runId: 'run-b', now: night2() }
      expect(st.claimForCloud(['d3', 'd4', 'd5'].map(hashOf), { ...scope(false), ...run }).claimed).toEqual([hashOf('d5')])
      st.releaseClaims('run-b')
    })
    const p = await a.call<CloudPreview>('cloud:prepare')
    expect(p).toMatchObject({ provider: 'anthropic', toSend: 1, secondOpinions: 0 })
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'anthropic', asked: 1 })
    expect(sent(a.net.haiku)).toEqual(['fresh'])
  })

  it('an earlier answer of the asking provider’s own does not count against it', async () => {
    const w = four()
    const a = app(w, { ...BOTH, secondOpinions: false }, { now: night1 })
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'openai', asked: 4 })
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("UPDATE sorter_cloud_answers SET model = 'luna-earlier-model' WHERE provider = 'openai'").run()
    db.close()
    const scope = { sorterVersion: SORTER_VERSION, provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', others: [{ provider: 'anthropic' as const, model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }], throwawayAt: DEFAULT_THRESHOLDS.throwaway, secondOpinions: false }
    expect(withStore(w, (st) => st.cloudPending(scope).map((p) => p.hash).sort())).toEqual(['d3', 'd4'].map(hashOf).sort())
  })
})

describe('removing a key is one write', () => {
  /** A config that holds an agreement to a provider whose key is not there. */
  const agreedWithoutKey = (c: Record<string, unknown>): boolean => (Boolean(c.optedInAt) && !c.keyEnc) || (Boolean(c.anthropicOptedInAt) && !c.anthropicKeyEnc)

  it('the key, the agreement and on/off go together: no stored config ever has the agreement without the key', async () => {
    const a = app(four(), { ...BOTH })
    const st = await a.call<CloudStatus>('cloud:clear-key', 'openai')
    expect(a.writes).toHaveLength(1)
    expect(a.writes[0]).toEqual({ provider: 'openai', anthropicKeyEnc: FAKE_ANTHROPIC_KEY, optedInAt: null, anthropicOptedInAt: T1, enabled: false })
    expect(a.writes.some(agreedWithoutKey)).toBe(false)
    expect(st).toMatchObject({ hasKey: false, settings: { enabled: false, agreedAt: { openai: null, anthropic: T1 } } })
    // the other provider, not selected: one write as well, and the service stays as it was
    const b = app(four(), { ...BOTH })
    await b.call('cloud:clear-key', 'anthropic')
    expect(b.writes).toEqual([{ provider: 'openai', keyEnc: FAKE_OPENAI_KEY, optedInAt: T1, anthropicOptedInAt: null, enabled: true }])
  })

  it('a write that fails leaves the key and the agreement both in place; a key saved afterwards rides on nothing', async () => {
    const a = app(four(), { ...BOTH }, { now: night1 })
    const p = await a.call<CloudPreview>('cloud:prepare')
    a.failWrite()
    await expect(a.call('cloud:clear-key', 'openai')).rejects.toThrow(/could not be written/)
    expect(a.box.stored).toMatchObject({ keyEnc: FAKE_OPENAI_KEY, optedInAt: T1 })
    expect(agreedWithoutKey(a.box.stored)).toBe(false)
    // nothing was removed, so nothing was signalled: the prepared batch is still his to send
    expect(await a.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ asked: 4 })
    // removed for real, then another key saved: no agreement is left for it, and nothing goes
    await a.call('cloud:clear-key', 'openai')
    await a.call('cloud:set-key', 'openai', 'sk-test-ANOTHERFAKEKEY0123456789abcd')
    expect(a.writes.some(agreedWithoutKey)).toBe(false)
    expect(a.svc.status().settings).toMatchObject({ enabled: false, agreedAt: { openai: null } })
    expect(await a.call<CloudPreview>('cloud:prepare')).toMatchObject({ token: null })
    const requests = a.net.urls.length
    expect(await a.svc.runNightly()).toMatchObject({ asked: 0 })
    expect(a.net.urls).toHaveLength(requests)
  })
})

describe('turning it on does not catch up a slot that passed while it was off', () => {
  const at = (d: number, h: number, m = 0): Date => new Date(2026, 9, d, h, m)
  for (const [what, off, on] of [
    ['the service', { channel: 'cloud:set-settings', arg: { enabled: false } }, { channel: 'cloud:set-settings', arg: { enabled: true } }],
    ['the nightly switch', { channel: 'cloud:set-nightly', arg: false }, { channel: 'cloud:set-nightly', arg: true }]
  ] as const) {
    it(`${what} off before the slot and on after it: nothing runs until the time nextRunAt gives`, async () => {
      let now = at(9, 9)
      const a = app(many(8), { ...BOTH }, { now: () => now })
      useAllowance(a.d.wellRoot(), '2026-10-09', NIGHTLY_LIMIT - 2)
      expect(await a.svc.tick()).toBeNull() // starts the clock
      now = at(10, 2)
      expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', asked: 2 }) // a last run is stored: the anchor the scheduler goes by
      now = at(10, 20)
      await a.call(off.channel, off.arg)
      now = at(11, 8) // the 02:00 slot passed while it was off
      expect(await a.svc.tick()).toBeNull()
      await a.call(on.channel, on.arg)
      expect(a.d.prompts).toHaveLength(0) // agreed to already: no dialog stands between the switch and a send
      expect(a.svc.status().nextRunAt).toBe(at(12, 2).toISOString())
      const sentBefore = a.net.urls.length
      expect(await a.svc.tick()).toBeNull()
      now = at(12, 1, 59)
      expect(await a.svc.tick()).toBeNull()
      expect(a.net.urls).toHaveLength(sentBefore)
      now = at(12, 2)
      expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', asked: 8 - 2 })
    })
  }

  it('on all along, a slot missed while the app was closed still runs at the next check; setting a switch to the position it has moves nothing', async () => {
    let now = at(9, 9)
    const a = app(four(), { ...BOTH }, { now: () => now })
    await a.svc.tick()
    now = at(11, 8) // two slots passed with the app closed
    await a.call('cloud:set-nightly', true)
    await a.set({ enabled: true })
    await a.set({ batchTime: '02:00' })
    expect(a.d.stateBox.since).toBe(at(9, 9).toISOString())
    expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', asked: 4 })
  })

  it('the scheduler goes by the later of the last run and the start of the schedule', () => {
    const base = { enabled: true, batchTime: '02:00' }
    const iso = (d: Date): string => d.toISOString()
    expect(isBatchDue({ ...base, lastRunAt: iso(at(10, 2)), since: iso(at(9, 9)), now: at(11, 8) })).toBe(true)
    expect(isBatchDue({ ...base, lastRunAt: iso(at(10, 2)), since: iso(at(11, 8)), now: at(11, 8, 1) })).toBe(false)
    expect(isBatchDue({ ...base, lastRunAt: iso(at(10, 2)), since: iso(at(11, 8)), now: at(12, 2) })).toBe(true)
    expect(isBatchDue({ ...base, lastRunAt: 'not a time', since: iso(at(9, 9)), now: at(10, 2) })).toBe(true)
    expect(isBatchDue({ ...base, lastRunAt: null, since: null, now: at(10, 2) })).toBe(false)
  })
})

describe('a prepared batch does not outlive a key change', () => {
  for (const [what, change] of [
    ['another key saved for the provider', ['cloud:set-key', 'openai', 'sk-test-ANOTHERFAKEKEY0123456789abcd']],
    ['the same key saved again', ['cloud:set-key', 'openai', FAKE_OPENAI_KEY]],
    ['the other provider’s key saved', ['cloud:set-key', 'anthropic', FAKE_ANTHROPIC_KEY]]
  ] as const) {
    it(`${what} between the count and the click: the send is refused and nothing goes`, async () => {
      const a = app(four(), { ...BOTH }, { now: night1 })
      const p = await a.call<CloudPreview>('cloud:prepare')
      expect(p).toMatchObject({ blocked: null, toSend: 4 })
      await a.call(change[0], change[1], change[2])
      expect(await a.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0, sent: 0 })
      expect(a.d.prompts).toHaveLength(0)
      expect(a.net.urls).toEqual([])
      // prepared again, it goes with the key stored now
      const again = await a.call<CloudPreview>('cloud:prepare')
      expect(await a.call<CloudRunSummary>('cloud:send', again.token)).toMatchObject({ asked: 4 })
    })
  }
})

describe('the allowance is counted against the night a request goes in', () => {
  it('a run that is still preparing when the night ends at noon sends nothing more; its claims go and neither night is charged', async () => {
    const w = four()
    let now = new Date(2026, 9, 11, 11, 59) // the night of 10 October, a minute before it ends
    const a = app(w, { ...BOTH }, { now: () => now })
    useAllowance(w, NIGHT1, NIGHTLY_LIMIT - 1)
    a.d.shrink = async () => {
      now = new Date(2026, 9, 11, 12, 1) // noon passes while the pictures are made ready
      return { mime: 'image/jpeg', base64: 'AAAA' }
    }
    const s = await a.svc.runNightly()
    expect(s).toMatchObject({ asked: 0, sent: 0, skipped: 'cancelled', stayedDoubtful: 4 })
    expect(s.message).toBe('Stopped: the night this run counted against ended at noon. Nothing more was sent. 4 screenshots still need a look.')
    expect(a.net.urls).toEqual([])
    expect(claimsLeft(w)).toBe(0)
    expect(withStore(w, (st) => [st.allowanceUsed(NIGHT1), st.allowanceUsed('2026-10-11')])).toEqual([NIGHTLY_LIMIT - 1, 0])
    // the next run counts against the new night, from nothing
    expect(await a.svc.runNightly()).toMatchObject({ asked: 4, skipped: null })
    expect(withStore(w, (st) => [st.allowanceUsed(NIGHT1), st.allowanceUsed('2026-10-11')])).toEqual([NIGHTLY_LIMIT - 1, 4])
  })

  it('a retry that comes due after noon is not made', async () => {
    const w = four()
    let now = new Date(2026, 9, 11, 11, 59)
    const a = app(w, { ...BOTH }, { now: () => now })
    let calls = 0
    a.d.http = async () => {
      calls++
      return { status: 503, headers: { get: () => null }, text: async () => '' }
    }
    a.d.sleep = async () => void (now = new Date(2026, 9, 11, 12, 1)) // the wait before the retry crosses noon
    const s = await a.svc.runNightly()
    expect(calls).toBe(1)
    expect(s).toMatchObject({ asked: 4, answered: 0, skipped: 'cancelled' })
    expect(s.message).toMatch(/^Stopped after asking Luna about 4 screenshots: the night this run counted against ended at noon\./)
    expect(claimsLeft(w)).toBe(0)
    expect(withStore(w, (st) => [st.allowanceUsed(NIGHT1), st.allowanceUsed('2026-10-11')])).toEqual([4, 0])
  })
})

describe('a manual send is the count he confirmed or nothing', () => {
  it('tonight’s allowance shrinks while main’s dialog is open: fewer could be claimed, so none is sent and the claims go', async () => {
    const w = four()
    const a = app(w, { ...BOTH }, { now: night1 })
    const p = await a.call<CloudPreview>('cloud:prepare')
    expect(p).toMatchObject({ blocked: null, toSend: 4 })
    a.d.confirm = async (prompt) => {
      a.d.prompts.push(prompt)
      useAllowance(w, NIGHT1, NIGHTLY_LIMIT - 2) // another process sent screenshots of its own meanwhile
      return true
    }
    const s = await a.call<CloudRunSummary>('cloud:send', p.token)
    expect(a.d.prompts.map((x) => x.count)).toEqual([4])
    expect(s).toMatchObject({ trigger: 'manual', asked: 0, sent: 0, skipped: 'batch-changed', stayedDoubtful: 4 })
    expect(s.message).toMatch(/^Nothing was sent: the screenshots changed while the question was open\. Press Sort now again\./)
    expect(a.net.urls).toEqual([])
    expect(claimsLeft(w)).toBe(0)
    expect(withStore(w, (st) => st.allowanceUsed(NIGHT1))).toBe(NIGHTLY_LIMIT - 2)
    // prepared again he is shown, and sends, the two that fit
    const again = await a.call<CloudPreview>('cloud:prepare')
    expect(again).toMatchObject({ toSend: 2 })
    a.d.confirm = async () => true
    expect(await a.call<CloudRunSummary>('cloud:send', again.token)).toMatchObject({ asked: 2, sent: 2 })
  })

  it('another run holds one of them when he confirms: none is sent', async () => {
    const w = four()
    const a = app(w, { ...BOTH }, { now: night1 })
    const p = await a.call<CloudPreview>('cloud:prepare')
    a.d.confirm = async () => {
      const scope = { sorterVersion: SORTER_VERSION, provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', throwawayAt: DEFAULT_THRESHOLDS.throwaway }
      withStore(w, (st) => st.claimForCloud([hashOf('d2')], { ...scope, night: NIGHT1, limit: NIGHTLY_LIMIT, runId: 'another-process', now: night1() }))
      return true
    }
    expect(await a.call<CloudRunSummary>('cloud:send', p.token)).toMatchObject({ asked: 0, skipped: 'batch-changed' })
    expect(a.net.urls).toEqual([])
    expect(claimsLeft(w)).toBe(1) // the other run's claim; this run's three went
  })

  it('the nightly batch has no confirmed count and still goes with what fits', async () => {
    const w = four()
    const a = app(w, { ...BOTH }, { now: night1 })
    useAllowance(w, NIGHT1, NIGHTLY_LIMIT - 2)
    expect(await a.svc.runNightly()).toMatchObject({ trigger: 'nightly', asked: 2, sent: 2 })
  })
})

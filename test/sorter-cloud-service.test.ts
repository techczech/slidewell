import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import sharp from 'sharp'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter, normaliseCloudSettings, applySettingsPatch, NIGHTLY_LIMIT, PREPARED_TTL_MS } = await import('../src/main/sorter/cloud/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { shrinkForLuna } = await import('../src/main/sorter/cloud/images')
const { LUNA } = await import('../src/main/sorter/cloud/luna')
const { makeCloudWell, readProposal, lunaStub, cloudDeps, hashOf } = await import('./sorter-cloud-fixture')

let wells: string[] = []
afterEach(() => {
  for (const w of wells) rmSync(w, { recursive: true, force: true })
  wells = []
})
const well = (...a: Parameters<typeof makeCloudWell>): string => {
  const w = makeCloudWell(...a)
  wells.push(w)
  return w
}

// the eligible doubtful ones are d1–d4; the rest must never be sent
const mixed = (): string =>
  well([
    { hash: 'd1', proposal: 'doubtful', window: 'keep-chart', takenAt: '2026-10-04T10:00:00' },
    { hash: 'd2', proposal: 'doubtful', window: 'toss-wifi', takenAt: '2026-10-03T10:00:00' },
    { hash: 'd3', proposal: 'doubtful', window: 'weak-picker', takenAt: '2026-10-02T10:00:00' },
    { hash: 'd4', proposal: 'doubtful', window: 'blurry', takenAt: '2026-10-01T10:00:00' },
    { hash: 'k1', proposal: 'keep', window: 'keep-local' },
    { hash: 't1', proposal: 'throwaway', window: 'toss-local' },
    { hash: 'dDecided', proposal: 'doubtful', window: 'decided-by-him', decided: 'included' },
    { hash: 'dAnswered', proposal: 'doubtful', window: 'answered-in-review', answered: true },
    { hash: 'dOffline', proposal: 'doubtful', window: 'online-only-placeholder', offline: true }
  ])

describe('cloud step: offline or no key', () => {
  it('an offline nightly run completes with the cloud step skipped; items stay doubtful', async () => {
    const w = mixed()
    const stub = lunaStub()
    const d = cloudDeps(w, { online: () => false, http: stub.http })
    const s = await new CloudSorter(d).runNightly()
    expect(d.localRuns).toBe(1) // the local sorter still ran
    expect(s).toMatchObject({ trigger: 'nightly', skipped: 'offline', asked: 0, stayedDoubtful: 4, local: { ok: true } })
    expect(s.message).toMatch(/offline/)
    expect(stub.seen).toHaveLength(0)
    for (const h of ['d1', 'd2', 'd3', 'd4']) expect(readProposal(w, h)).toMatchObject({ proposal: 'doubtful', decided_by: null })
    expect(d.stateBox.lastRunAt).not.toBeNull()
    expect(d.stateBox.lastRun?.skipped).toBe('offline')
  })

  it('a network that fails mid-run counts as offline too', async () => {
    const w = mixed()
    const d = cloudDeps(w, { http: async () => Promise.reject(new TypeError('net::ERR_INTERNET_DISCONNECTED')) })
    const s = await new CloudSorter(d).runNightly()
    expect(s).toMatchObject({ skipped: 'offline', answered: 0, error: null })
    expect(readProposal(w, 'd1')?.proposal).toBe('doubtful')
  })

  it('no key: skipped, nothing sent', async () => {
    const w = mixed()
    const stub = lunaStub()
    const s = await new CloudSorter(cloudDeps(w, { keyValue: null, http: stub.http })).runNightly()
    expect(s).toMatchObject({ skipped: 'no-key', stayedDoubtful: 4 })
    expect(stub.seen).toHaveLength(0)
  })
})

describe('cloud step: what is sent and what comes back', () => {
  it('sends only the undecided, unanswered doubtful ones and records Luna under the keep-bias', async () => {
    const w = mixed()
    const stub = lunaStub()
    const s = await new CloudSorter(cloudDeps(w, { http: stub.http })).runNightly()
    expect(stub.seen.flatMap((r) => r.windows).sort()).toEqual(['blurry', 'keep-chart', 'toss-wifi', 'weak-picker'])
    expect(stub.seen.reduce((n, r) => n + r.images, 0)).toBe(4)
    expect(s).toMatchObject({ asked: 4, answered: 4, keep: 1, throwaway: 1, stayedDoubtful: 2, skipped: null, error: null })
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'keep', decided_by: 'luna', reason: 'A chart worth keeping' })
    expect(readProposal(w, 'd2')).toMatchObject({ proposal: 'throwaway', decided_by: 'luna' })
    expect(readProposal(w, 'd2')?.throwaway_since).not.toBeNull()
    expect(readProposal(w, 'd3')).toMatchObject({ proposal: 'doubtful', decided_by: 'luna' }) // 0.7 throwaway is not sure enough
    expect(readProposal(w, 'd4')?.reason).toMatch(/^Not sure, and Luna was not sure either/)
    for (const h of ['k1', 't1', 'dDecided', 'dAnswered']) expect(readProposal(w, h)?.reason).toBe(`local reason for ${h}`)
  })

  it('a screenshot Luna answered is not sent again', async () => {
    const w = mixed()
    const stub = lunaStub()
    const svc = new CloudSorter(cloudDeps(w, { http: stub.http }))
    await svc.runNightly()
    const before = stub.seen.length
    const again = await svc.runNightly()
    expect(stub.seen.length).toBe(before)
    expect(again.skipped).toBe('nothing-doubtful')
  })

  it('what is left of the night limit caps how many are sent, newest first', async () => {
    const w = mixed()
    const stub = lunaStub()
    const d = cloudDeps(w, { http: stub.http, now: () => new Date(2026, 9, 11, 2, 0) })
    useAllowance(w, '2026-10-10', NIGHTLY_LIMIT - 2)
    const s = await new CloudSorter(d).runNightly()
    expect(stub.seen.flatMap((r) => r.windows)).toEqual(['keep-chart', 'toss-wifi'])
    expect(s.stayedDoubtful).toBe(2) // d3 and d4 were not sent and still need a look
  })

  it('sends in chunks with at most two requests at a time', async () => {
    const shots = Array.from({ length: 32 }, (_, i) => ({ hash: `h${i}`, proposal: 'doubtful' as const, window: 'keep-x' }))
    const w = well(shots)
    const stub = lunaStub({ delayMs: 15 })
    const s = await new CloudSorter(cloudDeps(w, { http: stub.http })).runNightly()
    expect(stub.seen.map((r) => r.images)).toEqual(expect.arrayContaining([15, 15, 2]))
    expect(stub.seen).toHaveLength(Math.ceil(32 / LUNA.chunkSize))
    expect(stub.peak()).toBe(2)
    expect(s.keep).toBe(32)
  })

  it('a rejected key stops the run; nothing changes', async () => {
    const w = mixed()
    const http = async () => ({ status: 401, headers: { get: () => null }, text: async () => '{"error":{"message":"Incorrect API key provided: sk-test-****WXYZ"}}' })
    const s = await new CloudSorter(cloudDeps(w, { http })).runNightly()
    expect(s).toMatchObject({ skipped: 'key-rejected', answered: 0 })
    expect(readProposal(w, 'd1')?.proposal).toBe('doubtful')
  })

  it('a review answer that lands mid-run wins over Luna', async () => {
    const w = mixed()
    const stub = lunaStub()
    const http: typeof stub.http = async (u, init) => {
      const st = new SorterStore(w)
      st.setAnswer(hashOf('d1'), { answer: 'throwaway', answeredAt: '2026-10-09' })
      st.close()
      return stub.http(u, init)
    }
    await new CloudSorter(cloudDeps(w, { http })).runNightly()
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'doubtful', decided_by: null })
  })
})

describe('Sort now: count and cost first, send only on his click', () => {
  it('prepare runs the local sorter and sends nothing; send(token) sends the prepared batch', async () => {
    const w = mixed()
    const stub = lunaStub()
    const d = cloudDeps(w, { http: stub.http })
    const svc = new CloudSorter(d)
    const p = await svc.prepare()
    expect(d.localRuns).toBe(1)
    expect(stub.seen).toHaveLength(0)
    expect(p).toMatchObject({ doubtful: 4, toSend: 4, blocked: null, cap: 300, leftTonight: 300 })
    expect(typeof p.token).toBe('string')
    expect(p.estimate.screenshots).toBe(4)
    expect(p.estimate.usd).toBeGreaterThan(0)
    const s = await svc.send(p.token)
    expect(stub.seen.flatMap((r) => r.windows).sort()).toEqual(['blurry', 'keep-chart', 'toss-wifi', 'weak-picker'])
    expect(s).toMatchObject({ trigger: 'manual', asked: 4 })
  })

  it('prepare says why nothing can be sent: no key, offline', async () => {
    const w = mixed()
    expect((await new CloudSorter(cloudDeps(w, { keyValue: null })).prepare()).blocked).toBe('no-key')
    expect((await new CloudSorter(cloudDeps(w, { online: () => false })).prepare()).blocked).toBe('offline')
  })

  it('an untrained local sorter is reported and only existing doubtful ones are offered', async () => {
    const w = mixed()
    const d = cloudDeps(w, { canSortLocal: () => false })
    const p = await new CloudSorter(d).prepare()
    expect(d.localRuns).toBe(0)
    expect(p.local.ok).toBe(false)
    expect(p.toSend).toBe(4)
  })
})

describe('nightly schedule', () => {
  it('the first check only starts the clock; a due slot runs once', async () => {
    const w = mixed()
    const stub = lunaStub()
    let now = new Date(2026, 9, 10, 9, 0)
    const d = cloudDeps(w, { http: stub.http, now: () => now })
    const svc = new CloudSorter(d)
    expect(await svc.tick()).toBeNull()
    expect(d.stateBox.since).not.toBeNull()
    now = new Date(2026, 9, 10, 23, 0)
    expect(await svc.tick()).toBeNull()
    now = new Date(2026, 9, 11, 2, 0)
    expect((await svc.tick())?.trigger).toBe('nightly')
    now = new Date(2026, 9, 11, 2, 1)
    expect(await svc.tick()).toBeNull()
    expect(d.localRuns).toBe(1)
  })

  it('settings are normalised; the cloud step is off unless an opt-in time is recorded', () => {
    expect(normaliseCloudSettings(undefined)).toEqual({ enabled: false, batchTime: '02:00' })
    expect(normaliseCloudSettings({ enabled: true, batchTime: '7:30', nightlyCap: 99999 } as never)).toEqual({ enabled: false, batchTime: '07:30' }) // an old enabled flag is not an opt-in
    expect(normaliseCloudSettings({ optedInAt: '2026-10-11T09:00:00.000Z', batchTime: 'x' })).toEqual({ enabled: true, batchTime: '02:00' })
  })
})

function useAllowance(w: string, night: string, sent: number): void {
  const st = new SorterStore(w)
  st.close() // creates the tables
  const db = new DatabaseSync(join(w, 'triage.db'))
  db.prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?) ON CONFLICT(night) DO UPDATE SET sent = excluded.sent').run(night, sent)
  db.close()
}

describe('shrinking', () => {
  it('a wide screenshot is sent at 1456 px on its long edge, as JPEG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-shrink-'))
    wells.push(dir)
    const p = join(dir, 'wide.png')
    await sharp({ create: { width: 3024, height: 1964, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toFile(p)
    const r = await shrinkForLuna(readFileSync(p))
    expect(r.mime).toBe('image/jpeg')
    expect(Math.max(r.width, r.height)).toBe(1456)
    const meta = await sharp(Buffer.from(r.base64, 'base64')).metadata()
    expect(meta.format).toBe('jpeg')
    const small = join(dir, 'small.png')
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toFile(small)
    expect((await shrinkForLuna(readFileSync(small))).width).toBe(800) // never enlarged
  })
})

// The cloud step and his app rules (ticket 20 review): while the rules differ from those the accuracy
// report was measured with, the nightly batch does nothing at all (no local sort, no claim, nothing
// sent) and says why; a batch already running stops before its next request. Sort now is his own
// action and is not held back. Fake transport only (sorter-cloud-fixture.ts); synthetic data.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter, describe: inWords } = await import('../src/main/sorter/cloud/service')
const { makeCloudWell, bothStubs, cloudDeps, readProposal, OPENAI_URL } = await import('./sorter-cloud-fixture')
import type { ShotSpec } from './sorter-cloud-fixture'

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
const SHOTS: ShotSpec[] = [
  { hash: 'd1', proposal: 'doubtful', window: 'keep-chart', takenAt: '2026-10-04T10:00:00' },
  { hash: 'd2', proposal: 'doubtful', window: 'toss-wifi', takenAt: '2026-10-03T10:00:00' },
  { hash: 'd3', proposal: 'doubtful', window: 'weak-picker', takenAt: '2026-10-02T10:00:00' },
  { hash: 'd4', proposal: 'doubtful', window: 'blurry', takenAt: '2026-10-01T10:00:00' }
]
const four = (): string => well(SHOTS)
const many = (n: number): string => well(Array.from({ length: n }, (_, i) => ({ hash: `m${i}`, proposal: 'doubtful' as const, window: `blurry-${i}`, takenAt: `2026-10-01T10:${String(i).padStart(2, '0')}:00` })))
const count = (w: string, table: string, what = 'COUNT(*)'): number => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table)) return 0
    return Number((db.prepare(`SELECT ${what} AS n FROM ${table}`).get() as { n: number | null }).n ?? 0)
  } finally {
    db.close()
  }
}
const proposals = (w: string): string[] => SHOTS.map((s) => readProposal(w, s.hash)?.proposal ?? 'none')

describe('nightly batch: app rules changed since the sorter was tested', () => {
  it('does nothing: no local sort, no claim, nothing sent, recorded as skipped for that reason', async () => {
    const w = four()
    const net = bothStubs()
    const d = cloudDeps(w, { http: net.http, rulesChangedSinceTest: () => true })
    const before = proposals(w)
    const s = await new CloudSorter(d).runNightly()
    expect(s).toMatchObject({ trigger: 'nightly', skipped: 'rules-changed', local: null, asked: 0, sent: 0, answered: 0, error: null })
    expect(s.message).toMatch(/app rules changed/)
    expect(d.localRuns).toBe(0)
    expect(net.urls).toEqual([])
    expect(count(w, 'sorter_cloud_claims')).toBe(0)
    expect(count(w, 'sorter_cloud_allowance', 'SUM(sent)')).toBe(0)
    expect(count(w, 'sorter_cloud_answers')).toBe(0)
    expect(proposals(w)).toEqual(before)
    // recorded, and the slot is used: it is not tried again every minute
    expect(d.stateBox.lastRun).toMatchObject({ skipped: 'rules-changed' })
    expect(d.stateBox.lastRunAt).not.toBeNull()
  })

  it('the scheduled check takes the same path', async () => {
    const w = four()
    const net = bothStubs()
    let now = new Date(2026, 9, 10, 9, 0)
    const d = cloudDeps(w, { http: net.http, now: () => now, rulesChangedSinceTest: () => true })
    const svc = new CloudSorter(d)
    expect(await svc.tick()).toBeNull() // starts the clock
    now = new Date(2026, 9, 11, 2, 0)
    expect(await svc.tick()).toMatchObject({ skipped: 'rules-changed', asked: 0 })
    expect(await svc.tick()).toBeNull() // not again tonight
    expect(d.localRuns).toBe(0)
    expect(net.urls).toEqual([])
  })

  it('a mismatch that cannot be read counts as one', async () => {
    const w = four()
    const net = bothStubs()
    const d = cloudDeps(w, { http: net.http, rulesChangedSinceTest: () => { throw new Error('store busy') } }) // prettier-ignore
    expect(await new CloudSorter(d).runNightly()).toMatchObject({ skipped: 'rules-changed', asked: 0 })
    expect(d.localRuns).toBe(0)
    expect(net.urls).toEqual([])
  })

  it('a rule changed while the batch runs: it stops before its next request and its claims go', async () => {
    const w = many(32)
    const stub = bothStubs({ delayMs: 20 })
    let changed = false
    let calls = 0
    const d = cloudDeps(w, {
      rulesChangedSinceTest: () => changed,
      http: async (u, init) => {
        calls++
        if (calls === 1) changed = true
        const r = await stub.http(u, init)
        if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        return r
      }
    })
    const s = await new CloudSorter(d).runNightly()
    expect(d.localRuns).toBe(1) // the rules were as tested when it began
    expect(s.skipped).toBe('rules-changed')
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(2) // at most the two started together; the third chunk was never sent
    expect(s.asked).toBeLessThanOrEqual(30)
    expect(s.message).toMatch(/^Stopped.*app rules changed/)
    expect(count(w, 'sorter_cloud_claims')).toBe(0)
  })

  it('a rule changed during the local sort: nothing is claimed or sent', async () => {
    const w = four()
    const net = bothStubs()
    let changed = false
    const d = cloudDeps(w, { http: net.http, rulesChangedSinceTest: () => changed, sortLocal: async () => ((changed = true), { ok: true, sorted: 0 }) })
    expect(await new CloudSorter(d).runNightly()).toMatchObject({ skipped: 'rules-changed', asked: 0 })
    expect(net.urls).toEqual([])
    expect(count(w, 'sorter_cloud_claims')).toBe(0)
  })

  it('not trained enough and no rule change: as before, the local step is left out and doubtful ones are still asked about', async () => {
    const w = four()
    const net = bothStubs()
    const d = cloudDeps(w, { http: net.http, canSortLocal: () => false, rulesChangedSinceTest: () => false })
    const s = await new CloudSorter(d).runNightly()
    expect(d.localRuns).toBe(0)
    expect(s).toMatchObject({ trigger: 'nightly', skipped: null, asked: 4, local: { ok: false } })
    expect(s.local!.message).toMatch(/not trained enough/)
    expect(net.urls).toEqual([OPENAI_URL])
  })

  it('the reason in words, whether or not some had gone', () => {
    const base = { at: '2026-10-11T02:00:00.000Z', trigger: 'nightly' as const, provider: 'openai' as const, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, sent: 0, settled: 0, stillUnsure: 0, skipped: 'rules-changed' as const, error: null, message: '' }
    expect(inWords(base)).toBe('Nothing was sorted or sent: your app rules changed since the sorter was last tested. Train it again and nightly sorting carries on.')
    expect(inWords({ ...base, asked: 15, stayedDoubtful: 2 })).toBe('Stopped after asking Luna about 15 screenshots: your app rules changed since the sorter was last tested. Train it again and nightly sorting carries on. 2 screenshots still need a look.')
  })
})

describe('Sort now through the cloud step is his own action', () => {
  it('runs the local sort as a manual one and sends the confirmed batch while the app rules differ from the tested ones', async () => {
    const w = four()
    const net = bothStubs()
    const triggers: string[] = []
    const d = cloudDeps(w, { http: net.http, rulesChangedSinceTest: () => true, sortLocal: async (_w, trigger) => (triggers.push(trigger), { ok: true, sorted: 3 }) })
    const svc = new CloudSorter(d)
    const p = await svc.prepare()
    expect(triggers).toEqual(['manual'])
    expect(p).toMatchObject({ local: { ok: true }, blocked: null, toSend: 4 })
    expect(await svc.send(p.token)).toMatchObject({ trigger: 'manual', skipped: null, asked: 4, sent: 4 })
    expect(net.urls).toEqual([OPENAI_URL])
  })

  it('still reports a sorter that is not trained enough, and offers only what is already doubtful', async () => {
    const w = four()
    const d = cloudDeps(w, { canSortLocal: () => false, rulesChangedSinceTest: () => true })
    const p = await new CloudSorter(d).prepare()
    expect(d.localRuns).toBe(0)
    expect(p.local.ok).toBe(false)
    expect(p.toSend).toBe(4)
  })
})

// Three rules of the sorter's cloud step (src/main/sorter/cloud/schedule.ts, service.ts, store.ts):
//   1. the scheduler and the next run shown go by one anchor, and a stored time that is not a past
//      time neither holds the nightly batch back nor brings a catch-up;
//   2. a manual send is the count main's dialog confirmed or nothing, checked again in the
//      transaction that counts the allowance;
//   3. once a run holds claims, whatever happens next ends with the claims released and the sorter idle.
// Fake transport only (sorter-cloud-fixture.ts); synthetic data, made-up keys.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter, NIGHTLY_LIMIT, RELEASE_FAILED, partSent, describe: describeRun } = await import('../src/main/sorter/cloud/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { effectiveAnchor, isBatchDue, nextRunAt, nightOf } = await import('../src/main/sorter/cloud/schedule')
const { makeCloudWell, bothStubs, cloudDeps, hashOf } = await import('./sorter-cloud-fixture')
import type { ShotSpec } from './sorter-cloud-fixture'
type CloudStatus = import('../src/main/sorter/cloud/service').CloudStatus

let dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

const at = (d: number, h: number, m = 0): Date => new Date(2026, 9, d, h, m, 0, 0) // local time, October 2026
const iso = (d: Date): string => d.toISOString()
const SHOTS: ShotSpec[] = ['keep-graph', 'toss-panel', 'weak-chooser', 'smudged'].map((window, i) => ({ hash: `p${i + 1}`, proposal: 'doubtful' as const, window, takenAt: `2026-10-0${i + 1}T10:00:00` }))
const HASHES = SHOTS.map((s) => hashOf(s.hash))
const SCOPE = { sorterVersion: SORTER_VERSION, provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'x', throwawayAt: 0.9 }

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
const claims = (w: string): Array<{ run_id: string; counted: number }> => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return db.prepare('SELECT run_id, counted FROM sorter_cloud_claims ORDER BY run_id, hash').all() as never
  } finally {
    db.close()
  }
}

function app(extra: Parameters<typeof cloudDeps>[1] = {}, start: Date = at(11, 2)) {
  const w = makeCloudWell(SHOTS)
  dirs.push(w)
  const net = bothStubs()
  const clock = { now: start }
  const d = cloudDeps(w, { http: net.http, now: () => clock.now, period: () => 'all', ...extra })
  const svc = new CloudSorter(d)
  return { w, net, clock, d, svc }
}

describe('1. one anchor for the scheduler and for the next run shown', () => {
  const base = { enabled: true, batchTime: '02:00' }

  it('a start of the schedule later than the clock counts as now: no catch-up from the older last run, and the batch runs at the slot shown', () => {
    const stored = { lastRunAt: iso(at(7, 2)), since: '2099-01-01T00:00:00.000Z' }
    expect(effectiveAnchor({ ...stored, now: at(10, 14) })).toEqual({ anchor: at(10, 14).getTime(), sinceMissing: false, rewriteSince: true })
    expect(isBatchDue({ ...base, ...stored, now: at(10, 14) })).toBe(false)
    expect(nextRunAt({ ...base, ...stored, now: at(10, 14) })).toEqual(at(11, 2))
  })

  it('a start of the schedule that is not a time counts as now and never falls back to the last run', () => {
    const stored = { lastRunAt: iso(at(7, 2)), since: 'not-a-time' }
    expect(effectiveAnchor({ ...stored, now: at(10, 14) })).toMatchObject({ anchor: at(10, 14).getTime(), rewriteSince: true })
    expect(isBatchDue({ ...base, ...stored, now: at(10, 14) })).toBe(false)
  })

  it('a last run later than the clock is ignored; the start of the schedule anchors alone', () => {
    const stored = { lastRunAt: '2099-01-01T00:00:00.000Z', since: iso(at(9, 9)) }
    expect(effectiveAnchor({ ...stored, now: at(10, 14) })).toEqual({ anchor: at(9, 9).getTime(), sinceMissing: false, rewriteSince: false })
    expect(isBatchDue({ ...base, ...stored, now: at(10, 14) })).toBe(true)
  })

  it('no start of the schedule stored: the last run anchors, and without one nothing is due', () => {
    for (const since of [null, ''] as Array<string | null>) {
      expect(effectiveAnchor({ lastRunAt: iso(at(7, 2)), since, now: at(10, 14) })).toEqual({ anchor: at(7, 2).getTime(), sinceMissing: true, rewriteSince: false })
      expect(isBatchDue({ ...base, lastRunAt: iso(at(7, 2)), since, now: at(10, 14) })).toBe(true)
      expect(isBatchDue({ ...base, lastRunAt: null, since, now: at(10, 14) })).toBe(false)
    }
  })

  it('the next run is now while a batch is due, the next slot otherwise, and none while nightly is off', () => {
    const stored = { lastRunAt: iso(at(7, 2)), since: iso(at(1, 9)) }
    expect(nextRunAt({ ...base, ...stored, now: at(10, 14) })).toEqual(at(10, 14))
    expect(nextRunAt({ ...base, lastRunAt: iso(at(10, 14)), since: stored.since, now: at(10, 14, 1) })).toEqual(at(11, 2))
    expect(nextRunAt({ ...base, ...stored, enabled: false, now: at(10, 14) })).toBeNull()
  })

  for (const [what, since] of [
    ['later than the clock', '2099-01-01T00:00:00.000Z'],
    ['not a time', 'not-a-time']
  ]) {
    it(`the check stores now over a start of the schedule that is ${what}, runs nothing, and runs at the slot the status gave`, async () => {
      const a = app({}, at(10, 14))
      Object.assign(a.d.stateBox, { lastRunAt: iso(at(7, 2)), since })
      expect(a.svc.status().nextRunAt).toBe(iso(at(11, 2)))
      expect(await a.svc.tick()).toBeNull()
      expect(a.d.stateBox.since).toBe(iso(at(10, 14)))
      expect(a.net.urls).toEqual([])
      a.clock.now = at(11, 1, 59)
      expect(await a.svc.tick()).toBeNull()
      a.clock.now = at(11, 2)
      expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', asked: 4 })
    })
  }

  it('on all along with no start of the schedule stored: the missed slot runs at this check, and the start is stored', async () => {
    const a = app({}, at(10, 14))
    Object.assign(a.d.stateBox, { lastRunAt: iso(at(7, 2)), since: null })
    expect(a.svc.status().nextRunAt).toBe(iso(at(10, 14)))
    expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', asked: 4 })
    expect(a.d.stateBox.since).toBe(iso(at(10, 14)))
    a.clock.now = at(10, 14, 1)
    expect(await a.svc.tick()).toBeNull()
  })

  it('that catch-up waits while the sorter is busy: the start is stored only when the batch can start', async () => {
    const a = app({}, at(10, 14))
    Object.assign(a.d.stateBox, { lastRunAt: iso(at(7, 2)), since: null })
    const busy = vi.spyOn(a.svc, 'busy').mockReturnValue(true)
    expect(await a.svc.tick()).toBeNull()
    expect(a.d.stateBox.since).toBeNull()
    busy.mockRestore()
    expect(await a.svc.tick()).toMatchObject({ trigger: 'nightly', asked: 4 })
  })

  it('a fresh install still only starts the clock', async () => {
    const a = app({}, at(10, 14))
    expect(await a.svc.tick()).toBeNull()
    expect(a.d.stateBox).toMatchObject({ since: iso(at(10, 14)), lastRunAt: null })
    expect(a.svc.status().nextRunAt).toBe(iso(at(11, 2)))
  })
})

describe('2. a manual send is the confirmed count or nothing when the allowance is counted', () => {
  const NIGHT = nightOf(at(11, 2))
  /** Another process sends screenshots of its own while this run prepares its first picture. */
  const usedMeanwhile = (a: ReturnType<typeof app>): void => {
    let first = true
    a.d.shrink = async () => {
      if (first) useAllowance(a.w, NIGHT, NIGHTLY_LIMIT - 2)
      first = false
      return { mime: 'image/jpeg', base64: 'AAAA' }
    }
  }

  it('the allowance shrinks after all four were claimed: none is sent, none is counted and the claims go', async () => {
    const a = app()
    usedMeanwhile(a)
    const p = await a.svc.prepare()
    const s = await a.svc.send(p.token)
    expect(a.d.prompts.map((x) => x.count)).toEqual([4])
    expect(s).toMatchObject({ trigger: 'manual', asked: 0, sent: 0, skipped: 'batch-changed', stayedDoubtful: 4 })
    expect(s.message).toMatch(/^Nothing was sent: /)
    expect(a.net.urls).toEqual([])
    expect(claims(a.w)).toEqual([])
    expect(withStore(a.w, (st) => st.allowanceUsed(NIGHT))).toBe(NIGHTLY_LIMIT - 2)
    expect(a.svc.busy()).toBe(false)
  })

  it('the nightly batch has no confirmed count and goes with the two that fit', async () => {
    const a = app()
    usedMeanwhile(a)
    expect(await a.svc.runNightly()).toMatchObject({ trigger: 'nightly', asked: 2, sent: 2 })
    expect(withStore(a.w, (st) => st.allowanceUsed(NIGHT))).toBe(NIGHTLY_LIMIT)
  })

  it('in the store: a first request that cannot take the whole confirmed batch admits none and deletes only this run’s claims', () => {
    const a = app()
    withStore(a.w, (st) => {
      const run = { ...SCOPE, night: 'n', limit: 5 }
      st.claimForCloud(HASHES.slice(0, 3), { ...run, runId: 'manual', now: at(11, 2) })
      st.claimForCloud(HASHES.slice(3), { ...run, runId: 'other', now: at(11, 2) })
      expect(st.admitForRequest(HASHES.slice(3), { ...run, runId: 'other' }).admitted).toEqual(HASHES.slice(3))
      useAllowance(a.w, 'n', 3) // two places left, three confirmed
      expect(st.admitForRequest(HASHES.slice(0, 2), { ...run, runId: 'manual', confirmed: 3 })).toEqual({ admitted: [], overLimit: 0, short: true })
      expect(st.allowanceUsed('n')).toBe(3)
    })
    expect(claims(a.w)).toEqual([{ run_id: 'other', counted: 1 }])
  })

  it('in the store: fewer claims than confirmed, or one decided meanwhile, admits none', () => {
    const a = app()
    withStore(a.w, (st) => {
      const run = { ...SCOPE, night: 'n', limit: 300 }
      st.claimForCloud(HASHES.slice(0, 3), { ...run, runId: 'manual', now: at(11, 2) })
      expect(st.admitForRequest(HASHES.slice(0, 3), { ...run, runId: 'manual', confirmed: 4 })).toMatchObject({ admitted: [], short: true })
      st.claimForCloud(HASHES, { ...run, runId: 'again', now: at(11, 2) })
      const db = new DatabaseSync(join(a.w, 'triage.db'))
      db.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, 'excluded', '2026-10-11', NULL)").run(HASHES[3])
      db.close()
      expect(st.admitForRequest(HASHES.slice(0, 2), { ...run, runId: 'again', confirmed: 4 })).toMatchObject({ admitted: [], short: true })
      expect(st.allowanceUsed('n')).toBe(0)
    })
    expect(claims(a.w)).toEqual([])
  })

  it('in the store: the whole batch fits, each request counts only its own, a retry counts nothing, and a later request stops when the rest no longer fits', () => {
    const a = app()
    withStore(a.w, (st) => {
      const run = { ...SCOPE, night: 'n', limit: 300, runId: 'manual', confirmed: 4 }
      st.claimForCloud(HASHES, { ...run, now: at(11, 2) })
      expect(st.admitForRequest(HASHES.slice(0, 2), run)).toEqual({ admitted: HASHES.slice(0, 2), overLimit: 0 })
      expect(st.allowanceUsed('n')).toBe(2)
      expect(st.admitForRequest(HASHES.slice(0, 2), run).admitted).toEqual(HASHES.slice(0, 2))
      expect(st.allowanceUsed('n')).toBe(2)
      useAllowance(a.w, 'n', 299) // another run used the rest but one
      expect(st.admitForRequest(HASHES.slice(2), run)).toEqual({ admitted: [], overLimit: 0, short: true })
      expect(st.allowanceUsed('n')).toBe(299)
    })
    expect(claims(a.w)).toEqual([])
  })
})

describe('2b. a manual send that stops after some of it went says what went', () => {
  it('the limit is used up between two requests: the message, the numbers and the stored last run give what was sent, not “nothing”', async () => {
    const shots: ShotSpec[] = Array.from({ length: 20 }, (_, i) => ({ hash: `q${i}`, proposal: 'doubtful' as const, window: `smudged-${i}`, takenAt: `2026-10-01T10:${String(i).padStart(2, '0')}:00` }))
    const w = makeCloudWell(shots)
    dirs.push(w)
    const net = bothStubs()
    const d = cloudDeps(w, { http: net.http, now: () => at(11, 2), period: () => 'all' })
    const svc = new CloudSorter(d)
    const night = nightOf(at(11, 2))
    // another process uses all but one place of tonight's limit once this run's first request has been counted
    const real = SorterStore.prototype.admitForRequest
    let admissions = 0
    vi.spyOn(SorterStore.prototype, 'admitForRequest').mockImplementation(function (this: InstanceType<typeof SorterStore>, ...args: Parameters<typeof real>) {
      const r = real.apply(this, args)
      if (!admissions++) useAllowance(w, night, NIGHTLY_LIMIT - 1)
      return r
    })
    const p = await svc.prepare()
    const s = await svc.send(p.token)
    expect(d.prompts.map((x) => x.count)).toEqual([20])
    expect(net.urls).toHaveLength(1)
    const went = net.luna.seen[0].images
    expect(went).toBeGreaterThan(0)
    expect(s).toMatchObject({ trigger: 'manual', skipped: 'batch-changed', asked: went, sent: went, settled: 0, stillUnsure: went, stayedDoubtful: 20 })
    expect(s.message).toBe(partSent(went, 20, 20))
    expect(s.message).toMatch(new RegExp(`^Sent ${went} of 20\\. The other ${20 - went} screenshots were not sent because tonight’s limit was reached; press Sort now again to prepare them\\.`))
    expect(s.message).not.toMatch(/Nothing was sent/)
    expect(d.stateBox.lastRun).toEqual(s)
    expect(svc.status().lastRun).toMatchObject({ sent: went, settled: 0, stillUnsure: went, message: s.message })
    expect(claims(w)).toEqual([])
    expect(svc.busy()).toBe(false)
  })

  it('a stored summary of that kind read without its own sentence still does not say nothing was sent', () => {
    const run = { at: '', trigger: 'manual' as const, provider: 'openai' as const, local: null, asked: 15, answered: 15, keep: 0, throwaway: 0, stayedDoubtful: 20, sent: 15, settled: 0, stillUnsure: 15, skipped: 'batch-changed' as const, error: null, message: '' }
    expect(describeRun(run)).toMatch(/^Stopped after asking Luna about 15 screenshots: tonight’s limit was reached/)
    expect(describeRun({ ...run, asked: 0, sent: 0, stillUnsure: 0 })).toMatch(/^Nothing was sent: /)
  })
})

describe('3. a run that holds claims always ends with them released and the sorter idle', () => {
  it('the first status broadcast throws: the claims go, nothing is sent and the next run can start', async () => {
    const a = app()
    let thrown = 0
    a.d.broadcast = (s: CloudStatus) => {
      if (s.phase === 'asking' && !thrown++) throw new Error('the window had gone')
    }
    const p = await a.svc.prepare()
    await expect(a.svc.send(p.token)).rejects.toThrow('the window had gone')
    expect(thrown).toBe(1)
    expect(a.net.urls).toEqual([])
    expect(claims(a.w)).toEqual([])
    expect(a.svc.busy()).toBe(false)
    expect(a.svc.status()).toMatchObject({ phase: 'idle', done: 0, total: 0 })
    const again = await a.svc.prepare()
    expect(await a.svc.send(again.token)).toMatchObject({ asked: 4, sent: 4 })
  })

  it('releasing the claims throws: the sorter is idle all the same, and the result and the log say so', async () => {
    const a = app()
    const p = await a.svc.prepare()
    vi.spyOn(SorterStore.prototype, 'releaseClaims').mockImplementation(() => {
      throw new Error('database is locked')
    })
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ asked: 4, sent: 4 })
    expect(s.error).toBe(`${RELEASE_FAILED} (database is locked)`)
    expect(s.message.endsWith(`${RELEASE_FAILED} (database is locked)`)).toBe(true)
    expect(a.d.logs.some((l) => l.includes('its claims could not be released: database is locked'))).toBe(true)
    expect(a.svc.busy()).toBe(false)
    expect(a.svc.status().phase).toBe('idle')
  })

  it('the run throws and releasing the claims throws too: the sorter is idle, the run’s own error is the one thrown, and the log names the release', async () => {
    const a = app()
    a.d.broadcast = (s: CloudStatus) => {
      if (s.phase === 'asking') throw new Error('the window had gone')
    }
    const p = await a.svc.prepare()
    vi.spyOn(SorterStore.prototype, 'releaseClaims').mockImplementation(() => {
      throw new Error('database is locked')
    })
    await expect(a.svc.send(p.token)).rejects.toThrow('the window had gone')
    expect(a.svc.busy()).toBe(false)
    expect(a.d.logs.some((l) => l.includes('its claims could not be released'))).toBe(true)
  })
})

describe('4. cleanup waits for every request of the run', () => {
  it('one worker throws while another request is out: the run is aborted, and the claims stay and the sorter stays busy until that request has settled', async () => {
    const shots: ShotSpec[] = Array.from({ length: 20 }, (_, i) => ({ hash: `r${i}`, proposal: 'doubtful' as const, window: `smudged-${i}`, takenAt: `2026-10-01T10:${String(i).padStart(2, '0')}:00` }))
    const w = makeCloudWell(shots)
    dirs.push(w)
    const net = bothStubs()
    // the first request is answered once the second is out; the second stays out until the test lets it go, whatever its signal says
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let bothOut!: () => void
    const overlap = new Promise<void>((r) => (bothOut = r))
    const signals: AbortSignal[] = []
    let thrown = 0
    const d = cloudDeps(w, {
      now: () => at(11, 2),
      period: () => 'all',
      http: async (url, init) => {
        signals.push(init.signal)
        if (signals.length === 1) await overlap
        else {
          bothOut()
          await gate
        }
        return net.http(url, init)
      },
      broadcast: (s: CloudStatus) => {
        if (s.phase === 'asking' && s.done > 0 && !thrown++) throw new Error('the window had gone')
      }
    })
    const svc = new CloudSorter(d)
    const writesWhileBusy: boolean[] = []
    const realSave = SorterStore.prototype.saveCloudResults
    vi.spyOn(SorterStore.prototype, 'saveCloudResults').mockImplementation(function (this: InstanceType<typeof SorterStore>, ...args: Parameters<typeof realSave>) {
      writesWhileBusy.push(svc.busy())
      return realSave.apply(this, args)
    })
    const p = await svc.prepare()
    let settled = false
    const sending = svc.send(p.token).finally(() => (settled = true))
    sending.catch(() => undefined)
    for (let i = 0; i < 50 && !(thrown && signals.length === 2); i++) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 20))
    expect(thrown).toBe(1)
    expect(signals).toHaveLength(2)
    // the second request is still out: aborted, but nothing is released and no other run can start
    expect(signals[1].aborted).toBe(true)
    expect(settled).toBe(false)
    expect(svc.busy()).toBe(true)
    expect(claims(w)).toHaveLength(20)
    release()
    await expect(sending).rejects.toThrow('the window had gone')
    expect(signals).toHaveLength(2)
    expect(claims(w)).toEqual([])
    expect(svc.busy()).toBe(false)
    // whatever was written was written before the cleanup, never after it
    expect(writesWhileBusy.length).toBeGreaterThan(0)
    expect(writesWhileBusy.every(Boolean)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(writesWhileBusy.every(Boolean)).toBe(true)
  })
})

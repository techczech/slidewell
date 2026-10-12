// "Sort now" under a period, the checks made after main's dialog and at each request
// (src/main/sorter/cloud/service.ts, store.ts admitForRequest, period.ts):
//   1. a capture date that moves out of the window after the dialog is caught when the request is admitted;
//   2. a batch that is no longer the one the dialog counted is not sent at all;
//   3. a prepared batch that grew too old while the dialog stood open is not sent, and a wall clock
//      set back does not keep it alive;
//   4. a stored period of null is not Everything;
//   5. a limited period takes no screenshot dated in the future.
// Fake transport only (sorter-cloud-fixture.ts); synthetic data, made-up keys.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter, PREPARED_TTL_MS, describe: describeRun } = await import('../src/main/sorter/cloud/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { nightOf } = await import('../src/main/sorter/cloud/schedule')
const { EVERYTHING, PERIOD_UNREADABLE, periodWindow } = await import('../src/main/sorter/period')
const { makeCloudWell, bothStubs, cloudDeps, hashOf, lunaStub } = await import('./sorter-cloud-fixture')
import type { ShotSpec } from './sorter-cloud-fixture'
type ConsentPrompt = import('../src/main/sorter/cloud/service').ConsentPrompt
type HttpPost = import('../src/main/sorter/cloud/client').HttpPost

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** The clock on the wall: 12 October 2026, 16:00. */
const NOW = new Date(2026, 9, 12, 16, 0, 0)
const NIGHT = nightOf(NOW)
const SHOTS: ShotSpec[] = [
  { hash: 'recent', proposal: 'doubtful', window: 'keep-recent', takenAt: '2026-10-10T09:00:00' },
  { hash: 'edge', proposal: 'doubtful', window: 'blurry-edge', takenAt: '2026-10-05T16:00:00' },
  { hash: 'third', proposal: 'doubtful', window: 'toss-third', takenAt: '2026-10-08T12:00:00' },
  { hash: 'old', proposal: 'doubtful', window: 'keep-old', takenAt: '2025-01-01T10:00:00' }
]
const windowsOf = (names: string[]): string[] => names.map((n) => SHOTS.find((s) => s.hash === n)!.window!).sort()
const SCOPE = { sorterVersion: SORTER_VERSION, provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'x', throwawayAt: 0.9 }

const write = (w: string, sql: string, ...args: string[]): void => {
  const db = new DatabaseSync(join(w, 'triage.db'))
  try {
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}
/** A rescan read another date from the file name. */
const redate = (w: string, name: string, takenAt: string): void => write(w, 'UPDATE triage_fts SET taken_at = ? WHERE hash = ?', takenAt, hashOf(name))
const decide = (w: string, name: string): void => write(w, "INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, 'excluded', '2026-10-12', NULL)", hashOf(name))
const count = (w: string, q: string): number => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return Number((db.prepare(q).get() as { n: number }).n)
  } finally {
    db.close()
  }
}
const allowance = (w: string): number => {
  const s = new SorterStore(w)
  try {
    return s.allowanceUsed(NIGHT)
  } finally {
    s.close()
  }
}

/** The app as wired in index.ts, with a wall clock and a separate monotonic clock (milliseconds). */
function app(period: unknown, extra: Parameters<typeof cloudDeps>[1] = {}, shots: ShotSpec[] = SHOTS) {
  const w = makeCloudWell(shots)
  dirs.push(w)
  const net = bothStubs()
  const clock = { now: NOW, mono: 5_000 }
  const d = cloudDeps(w, { http: net.http, now: () => clock.now, monotonic: () => clock.mono, period: () => period, ...extra })
  const svc = new CloudSorter(d)
  const sent = (): string[] => [...net.luna.seen, ...net.haiku.seen].flatMap((r) => r.windows).sort()
  /** Nothing went out and nothing was used. */
  const untouched = (): void => {
    expect(sent()).toEqual([])
    expect(net.urls).toEqual([])
    expect(allowance(w)).toBe(0)
    expect(count(w, 'SELECT COUNT(*) AS n FROM sorter_cloud_claims')).toBe(0)
    expect(count(w, 'SELECT COUNT(*) AS n FROM sorter_cloud_answers')).toBe(0)
  }
  return { w, net, clock, d, svc, sent, untouched }
}

describe('1. the capture date is checked again when a request is admitted', () => {
  it('store: a claimed screenshot whose date has left the window is not admitted and uses no allowance; nor is anything else in that request', () => {
    const w = makeCloudWell(SHOTS)
    dirs.push(w)
    const window = periodWindow('7d', NOW)!
    const hs = ['recent', 'edge', 'third'].map(hashOf)
    const st = new SorterStore(w)
    try {
      expect(st.claimForCloud(hs, { ...SCOPE, night: 'n', limit: 10, runId: 'r', now: NOW }).claimed).toEqual(hs)
      redate(w, 'edge', '2026-01-01T10:00:00')
      expect(st.admitForRequest(hs, { ...SCOPE, runId: 'r', night: 'n', limit: 10, window })).toEqual({ admitted: [], overLimit: 0, outOfPeriod: 1 })
      expect(st.allowanceUsed('n')).toBe(0)
      // the others alone are still in the window
      expect(st.admitForRequest([hs[0], hs[2]], { ...SCOPE, runId: 'r', night: 'n', limit: 10, window })).toEqual({ admitted: [hs[0], hs[2]], overLimit: 0, outOfPeriod: 0 })
      expect(st.allowanceUsed('n')).toBe(2)
      // a retry of those: one has moved into the future meanwhile; what went stays counted, nothing goes again
      redate(w, 'recent', '2099-01-01T00:00:00')
      expect(st.admitForRequest([hs[0], hs[2]], { ...SCOPE, runId: 'r', night: 'n', limit: 10, window })).toEqual({ admitted: [], overLimit: 0, outOfPeriod: 1 })
      expect(st.allowanceUsed('n')).toBe(2)
      // a date that can no longer be read is outside every limited window
      redate(w, 'third', '')
      expect(st.admitForRequest([hs[2]], { ...SCOPE, runId: 'r', night: 'n', limit: 10, window }).outOfPeriod).toBe(1)
      // everything, and a call with no window (the nightly batch), do not look at the date
      expect(st.admitForRequest(hs, { ...SCOPE, runId: 'r', night: 'n', limit: 10, window: EVERYTHING }).admitted).toEqual(hs)
      expect(st.admitForRequest(hs, { ...SCOPE, runId: 'r', night: 'n', limit: 10 })).toEqual({ admitted: hs, overLimit: 0 })
    } finally {
      st.close()
    }
  })

  it('a rescan moves a date out of the window after the dialog, while the pictures are read: nothing is sent or counted', async () => {
    let a!: ReturnType<typeof app>
    let shrunk = 0
    a = app('7d', {
      shrink: async () => {
        if (shrunk++ === 0) redate(a.w, 'recent', '2026-01-01T10:00:00')
        return { mime: 'image/jpeg', base64: 'AAAA' }
      }
    })
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ toSend: 3 })
    const s = await a.svc.send(p.token)
    expect(a.d.prompts.at(-1)).toMatchObject({ kind: 'send', count: 3 }) // he confirmed three
    expect(shrunk).toBeGreaterThan(0)
    expect(s).toMatchObject({ skipped: 'date-changed', asked: 0, answered: 0, period: '7d' })
    expect(s.message).toBe('Stopped: a screenshot’s date changed and it is no longer in the period. Nothing more was sent. Press Sort now again. 4 screenshots still need a look.')
    a.untouched()
    expect(a.d.logs.join('\n')).toMatch(/1 screenshot\(s\) not sent: its date is no longer in the period/)
  })

  it('a date that moves out during a retry’s wait: the retry is not made, and what already went stays counted', async () => {
    const stub = lunaStub()
    const bodies: string[] = []
    const http: HttpPost = async (u, init) => {
      bodies.push(init.body)
      if (bodies.length === 1) return { status: 500, headers: { get: () => null }, text: async () => '{}' }
      return stub.http(u, init)
    }
    let a!: ReturnType<typeof app>
    a = app('7d', { http, sleep: async () => redate(a.w, 'edge', '2099-01-01T00:00:00') })
    const p = await a.svc.prepare()
    const s = await a.svc.send(p.token)
    expect(bodies).toHaveLength(1)
    expect(s).toMatchObject({ skipped: 'date-changed', asked: 3, answered: 0 })
    expect(s.message).toBe('Stopped after asking Luna about 3 screenshots: a screenshot’s date changed and it is no longer in the period. Nothing more was sent. Press Sort now again. 4 screenshots still need a look.')
    expect(allowance(a.w)).toBe(3)
    expect(count(a.w, 'SELECT COUNT(*) AS n FROM sorter_cloud_claims')).toBe(0)
  })

  it('the nightly batch is not held to any date', async () => {
    let a!: ReturnType<typeof app>
    let shrunk = 0
    a = app('7d', {
      shrink: async () => {
        if (shrunk++ === 0) redate(a.w, 'recent', '2099-01-01T00:00:00')
        return { mime: 'image/jpeg', base64: 'AAAA' }
      }
    })
    expect(await a.svc.runNightly()).toMatchObject({ asked: 4, skipped: null })
    expect(allowance(a.w)).toBe(4)
  })
})

describe('2. what is sent is the batch main’s dialog counted, or nothing', () => {
  const during = (change: (w: string) => void) => {
    let a!: ReturnType<typeof app>
    const prompts: ConsentPrompt[] = []
    a = app('7d', {
      confirm: async (p) => {
        prompts.push(p)
        change(a.w)
        return true
      }
    })
    return { a, prompts }
  }
  const cases: Array<[string, (w: string) => void]> = [
    ['a date moves out of the period', (w) => redate(w, 'recent', '2026-01-01T10:00:00')],
    ['a date moves into the future', (w) => redate(w, 'edge', '2099-01-01T00:00:00')],
    ['he decides one in Triage', (w) => decide(w, 'third')]
  ]
  for (const [what, change] of cases) {
    it(`${what} while the dialog is open: confirmed, and nothing is sent`, async () => {
      const { a, prompts } = during(change)
      const p = await a.svc.prepare()
      const s = await a.svc.send(p.token)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ count: 3, confirmLabel: 'Send 3' })
      expect(s).toMatchObject({ skipped: 'batch-changed', asked: 0, period: '7d' })
      expect(s.message).toMatch(/^Nothing was sent: the screenshots changed while the question was open\. Press Sort now again\. \d screenshots still need a look\.$/)
      a.untouched()
    })
  }

  it('the sentence, with and without screenshots left', () => {
    const run = { at: '', trigger: 'manual' as const, provider: 'openai' as const, period: '7d' as const, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, skipped: 'batch-changed' as const, error: null, message: '' }
    expect(describeRun(run)).toBe('Nothing was sent: the screenshots changed while the question was open. Press Sort now again.')
    expect(describeRun({ ...run, stayedDoubtful: 1 })).toBe('Nothing was sent: the screenshots changed while the question was open. Press Sort now again. 1 screenshot still needs a look.')
  })

  it('a change before the dialog is still just counted out: the dialog gives the smaller count and that is what goes', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    redate(a.w, 'recent', '2026-01-01T10:00:00')
    expect(await a.svc.send(p.token)).toMatchObject({ asked: 2, skipped: null })
    expect(a.d.prompts.at(-1)).toMatchObject({ count: 2 })
    expect(a.sent()).toEqual(windowsOf(['edge', 'third']))
    expect(allowance(a.w)).toBe(2)
  })

  it('nothing changed: the three he confirmed are the three sent', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    expect(await a.svc.send(p.token)).toMatchObject({ asked: 3, skipped: null })
    expect(a.sent()).toEqual(windowsOf(['recent', 'edge', 'third']))
  })
})

describe('3. a prepared batch is good for ten minutes, measured on a clock that cannot be set', () => {
  const TOO_OLD = 'Nothing was sent. The prepared batch is too old. Press Sort now again to see the current count.'

  it('the dialog stands open past the ten minutes: confirmed, and nothing is sent', async () => {
    let a!: ReturnType<typeof app>
    const prompts: ConsentPrompt[] = []
    a = app('7d', {
      confirm: async (p) => {
        prompts.push(p)
        a.clock.mono += 4 * 60 * 1000 + 1000
        a.clock.now = new Date(a.clock.now.getTime() + 4 * 60 * 1000 + 1000)
        return true
      }
    })
    const p = await a.svc.prepare()
    a.clock.mono += 6 * 60 * 1000 // send is called six minutes in: still good
    a.clock.now = new Date(NOW.getTime() + 6 * 60 * 1000)
    const s = await a.svc.send(p.token)
    expect(prompts).toHaveLength(1)
    expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(s.message).toBe(TOO_OLD)
    a.untouched()
  })

  it('only the monotonic clock passes the ten minutes while the dialog is open (the wall clock was set back): nothing is sent', async () => {
    let a!: ReturnType<typeof app>
    a = app('7d', {
      confirm: async () => {
        a.clock.mono += PREPARED_TTL_MS + 1
        a.clock.now = new Date(NOW.getTime() - 60 * 60 * 1000)
        return true
      }
    })
    const p = await a.svc.prepare()
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(s.message).toBe(TOO_OLD)
    a.untouched()
  })

  it('the wall clock is set back an hour after prepare: the batch still expires ten minutes on', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    a.clock.now = new Date(NOW.getTime() - 60 * 60 * 1000)
    a.clock.mono += PREPARED_TTL_MS + 1
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(s.message).toBe(TOO_OLD)
    expect(a.d.prompts).toHaveLength(0) // main's dialog is not even raised
    a.untouched()
  })

  it('the wall clock alone passing the ten minutes still expires it (the Mac slept)', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    a.clock.now = new Date(NOW.getTime() + PREPARED_TTL_MS + 1000)
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    a.untouched()
  })

  it('just inside the ten minutes on both clocks, dialog included, it is sent', async () => {
    let a!: ReturnType<typeof app>
    a = app('7d', {
      confirm: async () => {
        a.clock.mono += 60 * 1000
        return true
      }
    })
    const p = await a.svc.prepare()
    a.clock.mono += PREPARED_TTL_MS - 61 * 1000
    a.clock.now = new Date(NOW.getTime() - 24 * 60 * 60 * 1000) // a wall clock set back does not shorten it either
    expect(await a.svc.send(p.token)).toMatchObject({ asked: 3, skipped: null })
  })

  it('without an injected monotonic clock the service has its own, and a fresh batch is sent', async () => {
    const w = makeCloudWell(SHOTS)
    dirs.push(w)
    const svc = new CloudSorter(cloudDeps(w, { now: () => NOW, period: () => '7d' }))
    const p = await svc.prepare()
    expect(await svc.send(p.token)).toMatchObject({ asked: 3, skipped: null })
  })
})

describe('4. a stored period of null is not Everything', () => {
  it('prepares nothing, sorts nothing and sends nothing; an absent one is still everything', async () => {
    const a = app(null)
    expect(a.svc.status().period).toBeNull()
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ blocked: 'period', token: null, period: null, toSend: 0, doubtful: 0 })
    expect(p.message).toBe(PERIOD_UNREADABLE)
    expect(a.d.localRuns).toBe(0)
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared' })
    a.untouched()
    const b = app(undefined)
    expect(b.svc.status().period).toBe('all')
    expect(await b.svc.prepare()).toMatchObject({ period: 'all', blocked: null, toSend: 4 })
  })
})

describe('5. a limited period takes no screenshot dated in the future', () => {
  const FUTURE: ShotSpec[] = [
    ...SHOTS,
    { hash: 'tomorrow', proposal: 'doubtful', window: 'keep-tomorrow', takenAt: '2026-10-13T16:00:00' }, // exactly one day ahead: allowed for a clock that is off
    { hash: 'later', proposal: 'doubtful', window: 'keep-later', takenAt: '2026-10-13T16:00:01' },
    { hash: 'far', proposal: 'doubtful', window: 'keep-far', takenAt: '2099-01-01T00:00:00' }
  ]
  for (const [period, n] of [['7d', 4], ['30d', 4], ['90d', 4], ['all', 7]] as const) {
    it(`${period}: ${n} are counted and sent`, async () => {
      const a = app(period, {}, FUTURE)
      const p = await a.svc.prepare()
      expect(p).toMatchObject({ period, doubtful: n, toSend: n })
      expect(await a.svc.send(p.token)).toMatchObject({ asked: n, skipped: null })
      const sent = a.sent()
      expect(sent).toHaveLength(n)
      expect(sent.includes('keep-tomorrow')).toBe(true)
      expect(sent.includes('keep-far')).toBe(period === 'all')
      expect(sent.includes('keep-later')).toBe(period === 'all')
      expect(allowance(a.w)).toBe(n)
    })
  }
})

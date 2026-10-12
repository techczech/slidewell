// "Sort now" limited to a period (src/main/sorter/period.ts, cloud/service.ts): which doubtful
// screenshots the cloud step is offered under each period; the counts and the period in words in the
// preview and in main's dialog; the period bound into the prepared batch (a change between prepare
// and send sends nothing and uses no allowance); a stored period that is not a period prepares
// nothing; the nightly batch ignores the period.
// Fake transport only (sorter-cloud-fixture.ts); synthetic data, made-up keys.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const ipc = vi.hoisted(() => new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { CloudSorter, NIGHTLY_LIMIT, PREPARED_TTL_MS, describe: describeRun, registerCloudIpc, sendPrompt } = await import('../src/main/sorter/cloud/service')
const { changePeriod } = await import('../src/main/sorter/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { nightOf } = await import('../src/main/sorter/cloud/schedule')
const { HAIKU_PROVIDER, LUNA_PROVIDER } = await import('../src/main/sorter/cloud/provider')
const { EVERYTHING, PERIOD_UNREADABLE } = await import('../src/main/sorter/period')
const { makeCloudWell, readProposal, bothStubs, cloudDeps, hashOf } = await import('./sorter-cloud-fixture')
import type { ShotSpec } from './sorter-cloud-fixture'
type PeriodWindow = import('../src/main/sorter/period').PeriodWindow
type ConsentPrompt = import('../src/main/sorter/cloud/service').ConsentPrompt

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  ipc.clear()
})

/** The clock on the wall: 12 October 2026, 16:00. */
const NOW = new Date(2026, 9, 12, 16, 0, 0)
const NIGHT = nightOf(NOW)

/** Doubtful screenshots by capture time; the window title says how the stubs answer (all unsure unless 'keep…' / 'toss…'). */
const SHOTS: ShotSpec[] = [
  { hash: 'recent', proposal: 'doubtful', window: 'keep-recent', takenAt: '2026-10-10T09:00:00' },
  { hash: 'edge', proposal: 'doubtful', window: 'blurry-edge', takenAt: '2026-10-05T16:00:00' }, // exactly seven days before NOW
  { hash: 'justout', proposal: 'doubtful', window: 'blurry-justout', takenAt: '2026-10-05T15:59:59' },
  { hash: 'month', proposal: 'doubtful', window: 'toss-month', takenAt: '2026-09-20T10:00:00' },
  { hash: 'quarter', proposal: 'doubtful', window: 'blurry-quarter', takenAt: '2026-08-01T10:00:00' },
  { hash: 'old', proposal: 'doubtful', window: 'keep-old', takenAt: '2025-01-01T10:00:00' },
  { hash: 'nodate', proposal: 'doubtful', window: 'keep-nodate' } // taken_at '' : no date in the name the scan read
]
const NAMES = SHOTS.map((s) => s.hash)
const IN: Record<string, string[]> = {
  '7d': ['edge', 'recent'],
  '30d': ['edge', 'justout', 'month', 'recent'],
  '90d': ['edge', 'justout', 'month', 'quarter', 'recent'],
  all: [...NAMES].sort()
}
const windowsOf = (names: string[]): string[] => names.map((n) => SHOTS.find((s) => s.hash === n)!.window!).sort()

const query = <T>(w: string, q: string): T[] => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return db.prepare(q).all() as T[]
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
const claims = (w: string): number => Number(query<{ n: number }>(w, 'SELECT COUNT(*) AS n FROM sorter_cloud_claims')[0].n)
const answered = (w: string): string[] => query<{ hash: string }>(w, 'SELECT hash FROM sorter_cloud_answers ORDER BY hash').map((r) => r.hash)
const proposedAt = (w: string): Record<string, string> => Object.fromEntries(query<{ hash: string; proposed_at: string; proposal: string }>(w, 'SELECT hash, proposed_at, proposal FROM sorter_proposals').map((r) => [r.hash, `${r.proposal}@${r.proposed_at}`]))

/**
 * The app as wired in index.ts: `box.period` is what config holds; `setPeriod` is the IPC path
 * (changePeriod → periodChanged). `sorted` records the window each local sort was given.
 */
function app(period: unknown, extra: Parameters<typeof cloudDeps>[1] = {}, shots: ShotSpec[] = SHOTS) {
  const w = makeCloudWell(shots)
  dirs.push(w)
  const box: { period: unknown } = { period }
  const net = bothStubs()
  const sorted: PeriodWindow[] = []
  const clock = { now: NOW }
  const d = cloudDeps(w, { http: net.http, now: () => clock.now, period: () => box.period, ...extra })
  d.sortLocal = async (window: PeriodWindow) => {
    sorted.push(window)
    return { ok: true, sorted: 0 }
  }
  const svc = new CloudSorter(d)
  const setPeriod = (p: unknown) => changePeriod(p, () => box.period, (v) => void (box.period = v), () => svc.periodChanged())
  const sent = (): string[] => [...net.luna.seen, ...net.haiku.seen].flatMap((r) => r.windows).sort()
  return { w, box, net, sorted, clock, d, svc, setPeriod, sent }
}

describe('what the cloud step is offered under each period', () => {
  for (const period of ['7d', '30d', '90d', 'all'] as const) {
    it(`${period}: the preview counts, and the send carries, only doubtful screenshots in the period`, async () => {
      const a = app(period)
      const before = proposedAt(a.w)
      const p = await a.svc.prepare()
      const names = IN[period]
      expect(p).toMatchObject({ period, blocked: null, doubtful: names.length, toSend: names.length })
      expect(p.estimate).toEqual(LUNA_PROVIDER.estimateCost(names.length))
      expect(a.sorted).toHaveLength(1)
      expect(a.sent()).toEqual([]) // a preview sends nothing
      expect(allowance(a.w)).toBe(0)

      const s = await a.svc.send(p.token)
      expect(s).toMatchObject({ trigger: 'manual', period, asked: names.length, skipped: null })
      expect(a.sent()).toEqual(windowsOf(names))
      expect(a.d.prompts.at(-1)).toMatchObject({ kind: 'send', period, count: names.length })
      // outside the period: no answer, no claim, no allowance, and the proposal row is as it was
      expect(allowance(a.w)).toBe(names.length)
      expect(claims(a.w)).toBe(0)
      expect(answered(a.w)).toEqual(names.map(hashOf).sort())
      const after = proposedAt(a.w)
      for (const n of NAMES.filter((x) => !names.includes(x))) {
        expect(after[hashOf(n)]).toBe(before[hashOf(n)])
        expect(readProposal(a.w, n)).toMatchObject({ proposal: 'doubtful', decided_by: null })
      }
    })
  }

  it('the local sorter is given the same window: the stored period and a cut-off from main’s clock', async () => {
    const a = app('30d')
    await a.svc.prepare()
    expect(a.sorted).toEqual([{ period: '30d', cutoff: '2026-09-12T16:00:00' }])
    const b = app(undefined) // nothing stored: everything
    expect(await b.svc.prepare()).toMatchObject({ period: 'all', doubtful: 7 })
    expect(b.sorted).toEqual([EVERYTHING])
  })

  it('the batch goes under the window it was prepared with, even minutes later', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    a.clock.now = new Date(NOW.getTime() + PREPARED_TTL_MS - 1000) // 'edge' is by now a few minutes older than seven days
    expect(await a.svc.send(p.token)).toMatchObject({ asked: 2 })
    expect(a.sent()).toEqual(windowsOf(['edge', 'recent']))
  })

  it('a screenshot in the period that he decided meanwhile still drops out; nothing outside takes its place', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    const db = new DatabaseSync(join(a.w, 'triage.db'))
    db.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, 'excluded', '2026-10-12', NULL)").run(hashOf('recent'))
    db.close()
    expect(await a.svc.send(p.token)).toMatchObject({ asked: 1 })
    expect(a.sent()).toEqual(windowsOf(['edge']))
    expect(allowance(a.w)).toBe(1)
  })

  it('a screenshot whose recorded date has moved out of the period by the time of the send is not sent', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    const db = new DatabaseSync(join(a.w, 'triage.db'))
    db.prepare("UPDATE triage_fts SET taken_at = '2026-01-01T10:00:00' WHERE hash = ?").run(hashOf('recent')) // a rescan read another date
    db.close()
    expect(await a.svc.send(p.token)).toMatchObject({ asked: 1 })
    expect(a.sent()).toEqual(windowsOf(['edge']))
    expect(a.d.prompts.at(-1)).toMatchObject({ count: 1 }) // the dialog counts what is still in the period
    expect(allowance(a.w)).toBe(1)
  })

  it('tonight’s allowance is counted inside the period only', async () => {
    const a = app('30d')
    const db = new DatabaseSync(join(a.w, 'triage.db'))
    db.prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?)').run(NIGHT, NIGHTLY_LIMIT - 2)
    db.close()
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ doubtful: 4, toSend: 2, leftTonight: 2 })
    expect(p.message).toBe('Last 30 days: ask Luna about 2 screenshots of 4 (2 left of tonight’s 300)?')
    await a.svc.send(p.token)
    expect(a.sent()).toEqual(windowsOf(['recent', 'edge'])) // the two newest in the period
    expect(allowance(a.w)).toBe(NIGHTLY_LIMIT)
  })

  it('nothing doubtful in the period: nothing is prepared, though older ones are waiting', async () => {
    const a = app('7d', {}, SHOTS.filter((s) => !['recent', 'edge'].includes(s.hash)))
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ blocked: 'nothing-doubtful', token: null, doubtful: 0, toSend: 0 })
    expect(p.message).toBe('Nothing doubtful from the last 7 days is waiting for Luna.')
    expect(await a.svc.send('anything')).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(a.sent()).toEqual([])
  })
})

describe('the period in words, with the count for that period', () => {
  it('preview and main’s dialog under Last 30 days', async () => {
    const a = app('30d')
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ period: '30d', periodLabel: 'Last 30 days', periodPrefix: 'Last 30 days: ' })
    expect(p.periodNote).toBe('Period: the last 30 days, by the date in each file name. Screenshots taken before that, or with no date in their name, are not sorted or sent and stay as they are.')
    expect(p.message).toBe('Last 30 days: ask Luna about 4 screenshots?')
    expect(p.local.message).toBe('Sorted 0 screenshots from the last 30 days on this Mac.')
    const s = await a.svc.send(p.token)
    const dialog = a.d.prompts.at(-1)!
    expect(dialog).toMatchObject({ kind: 'send', provider: 'openai', period: '30d', count: 4, message: 'Send 4 screenshots from the last 30 days to Luna?', confirmLabel: 'Send 4' })
    expect(dialog.detail).toMatch(/^Last 30 days: 4 screenshots the sorter could not call will go to OpenAI in 1 request\. Estimated cost: /)
    expect(dialog.detail).toContain('\n\nPeriod: the last 30 days, by the date in each file name. Screenshots taken before that, or with no date in their name, are not sorted or sent and stay as they are.\n\n')
    expect(dialog.detail).toMatch(/OpenAI \(gpt-6-luna\) receives the picture/)
    // keep-recent → keep, toss-month → throwaway; five doubtful ones are left in all (three outside the period)
    expect(s.message).toBe('Asked Luna about 4 screenshots from the last 30 days: 1 keep, 1 throwaway. 5 screenshots still need a look.')
  })

  it('second opinions are counted inside the period too', async () => {
    const a = app('all')
    // Luna answers everything first; edge, justout and quarter stay unsure
    expect(await a.svc.runNightly()).toMatchObject({ asked: 7 })
    const b = new CloudSorter({ ...a.d, settings: () => ({ enabled: true, batchTime: '02:00', provider: 'anthropic' as const }), period: () => '30d' })
    const p = await b.prepare()
    expect(p).toMatchObject({ provider: 'anthropic', period: '30d', doubtful: 2, toSend: 2, secondOpinions: 2, secondNote: '2 of them ones Luna was unsure about' })
    expect(p.message).toBe('Last 30 days: ask Haiku about 2 screenshots, 2 of them ones Luna was unsure about?')
    await b.send(p.token)
    const dialog = a.d.prompts.at(-1)!
    expect(dialog.message).toBe('Send 2 screenshots from the last 30 days to Haiku?')
    expect(dialog.detail).toMatch(/^Last 30 days: 2 screenshots the sorter could not call, 2 of them ones Luna was unsure about, will go to Anthropic in 1 request\. /)
    expect(a.net.haiku.seen.flatMap((r) => r.windows).sort()).toEqual(windowsOf(['edge', 'justout'])) // not 'quarter': outside the period
  })

  it('the dialog words for each period, and for one screenshot', () => {
    expect(sendPrompt(41, LUNA_PROVIDER, 0, '7d').message).toBe('Send 41 screenshots from the last 7 days to Luna?')
    expect(sendPrompt(41, HAIKU_PROVIDER, 6, '30d').detail).toMatch(/^Last 30 days: 41 screenshots the sorter could not call, 6 of them ones Luna was unsure about, will go to Anthropic in /)
    expect(sendPrompt(1, LUNA_PROVIDER, 0, '90d')).toMatchObject({ period: '90d', message: 'Send 1 screenshot from the last 90 days to Luna?' })
    expect(sendPrompt(1, LUNA_PROVIDER, 0, '90d').detail).toMatch(/^Last 90 days: 1 screenshot the sorter could not call will go to OpenAI in 1 request\./)
    // everything: the wording is as it was, with one sentence naming the period
    const all = sendPrompt(4)
    expect(all).toMatchObject({ period: 'all', message: 'Send 4 screenshots to Luna?' })
    expect(all.detail).toMatch(/^4 screenshots the sorter could not call will go to OpenAI in 1 request\. Estimated cost: /)
    expect(all.detail).toContain('\n\nPeriod: everything, whatever the date.\n\n')
  })

  it('everything: the preview says so and its question is as before', async () => {
    const a = app('all')
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ period: 'all', periodLabel: 'Everything', periodPrefix: '', periodNote: 'Period: everything, whatever the date.' })
    expect(p.message).toBe('Ask Luna about 7 screenshots?')
    expect(p.local.message).toBe('Sorted 0 screenshots on this Mac.')
  })

  it('the blocked messages name the period', async () => {
    expect((await app('7d', { settings: { enabled: false } }).svc.prepare()).message).toBe('2 screenshots from the last 7 days stay in Review: asking Luna is turned off.')
    expect((await app('90d', { keyValue: null }).svc.prepare()).message).toBe('5 screenshots from the last 90 days stay in Review: no OpenAI key is saved.')
    expect(describeRun({ at: '', trigger: 'manual', provider: 'openai', period: '7d', local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, skipped: 'nothing-doubtful', error: null, message: '' })).toBe('Nothing doubtful from the last 7 days was waiting for Luna.')
  })
})

describe('the period is bound into the prepared batch', () => {
  /** Nothing went out and nothing was used. */
  const untouched = (a: ReturnType<typeof app>): void => {
    expect(a.sent()).toEqual([])
    expect(a.net.urls).toEqual([])
    expect(allowance(a.w)).toBe(0)
    expect(claims(a.w)).toBe(0)
    expect(answered(a.w)).toEqual([])
  }

  for (const [from, to] of [['7d', 'all'], ['7d', '30d'], ['all', '7d'], ['90d', '30d']] as const) {
    it(`prepared under ${from}, then ${to} is chosen: the batch cannot be sent`, async () => {
      const a = app(from)
      const p = await a.svc.prepare()
      expect(p.token).toBeTruthy()
      expect(a.setPeriod(to)).toEqual({ ok: true, period: to })
      const s = await a.svc.send(p.token)
      expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
      expect(s.message).toMatch(/^Nothing was sent\./)
      expect(a.d.prompts).toHaveLength(0) // main's dialog is not even raised
      untouched(a)
    })
  }

  it('changed and changed back: still the old batch, still refused', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    a.setPeriod('all')
    a.setPeriod('7d')
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    untouched(a)
  })

  it('the stored period differs at send though no change was signalled: refused, naming the period', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    a.box.period = 'all' // config changed behind the service's back
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(s.message).toBe('Nothing was sent. The batch was prepared for last 7 days, and another period is selected now. Press Sort now again.')
    untouched(a)
    a.box.period = '7d'
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared' }) // the token was used up
    untouched(a)
  })

  it('the period is changed while main’s dialog is open: confirmed, and still nothing is sent', async () => {
    for (const moves of [['all'], ['all', '7d'], ['30d']]) {
      let a!: ReturnType<typeof app>
      const prompts: ConsentPrompt[] = []
      a = app('7d', {
        confirm: async (p) => {
          prompts.push(p)
          for (const m of moves) a.setPeriod(m)
          return true
        }
      })
      const p = await a.svc.prepare()
      const s = await a.svc.send(p.token)
      expect(prompts).toHaveLength(1)
      expect(s).toMatchObject({ skipped: 'period-changed', asked: 0, period: '7d' })
      expect(s.message).toBe('Nothing was sent: the period was changed in Settings. Press Sort now again. 7 screenshots still need a look.')
      untouched(a)
    }
  })

  it('the period is changed while the local sorter runs: nothing is prepared', async () => {
    const a = app('7d')
    a.d.sortLocal = async () => {
      a.setPeriod('all')
      return { ok: true, sorted: 0 }
    }
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ blocked: 'period', token: null, toSend: 0 })
    expect(p.message).toBe('The period was changed while sorting, so nothing was prepared. Press Sort now again.')
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared' })
    untouched(a)
  })

  it('a stored period that is not a period prepares nothing and sorts nothing (it is not everything)', async () => {
    for (const bad of ['everything', '365d', 30, '', { period: 'all' }]) {
      const a = app(bad)
      expect(a.svc.status().period).toBeNull()
      const p = await a.svc.prepare()
      expect(p).toMatchObject({ blocked: 'period', token: null, period: null, toSend: 0, doubtful: 0 })
      expect(p.message).toBe(PERIOD_UNREADABLE)
      expect(a.sorted).toEqual([])
      expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared' })
      untouched(a)
    }
  })

  it('the renderer cannot widen it: prepare and send read no period, date or list from their arguments', async () => {
    const a = app('7d')
    const sender = {}
    registerCloudIpc(a.svc, { openai: { set: () => ({ ok: false, saved: false }), clear: () => undefined }, anthropic: { set: () => ({ ok: false, saved: false }), clear: () => undefined } }, () => undefined, () => ({}), (s) => s === sender)
    const widen = { period: 'all', window: { period: 'all', cutoff: null }, cutoff: '1970-01-01T00:00:00', since: '1970-01-01', hashes: NAMES.map(hashOf), only: NAMES.map(hashOf) }
    const p = (await ipc.get('cloud:prepare')!({ sender }, widen, 'all')) as Awaited<ReturnType<typeof a.svc.prepare>>
    expect(p).toMatchObject({ period: '7d', toSend: 2 })
    expect(a.sorted).toEqual([{ period: '7d', cutoff: '2026-10-05T16:00:00' }])
    // a token that is not the string main issued is no token
    expect(await ipc.get('cloud:send')!({ sender }, { token: p.token, ...widen })).toMatchObject({ skipped: 'not-prepared' })
    const q = (await ipc.get('cloud:prepare')!({ sender })) as typeof p
    expect(await ipc.get('cloud:send')!({ sender }, q.token, widen, 'all')).toMatchObject({ asked: 2, period: '7d' })
    expect(a.sent()).toEqual(windowsOf(['edge', 'recent']))
    expect(allowance(a.w)).toBe(2)
  })
})

describe('the nightly batch ignores the period', () => {
  for (const period of ['7d', '30d', 'all', 'not-a-period'] as const) {
    it(`stored ${period}: sorts and asks about everything, within the nightly limit`, async () => {
      const a = app(period)
      const s = await a.svc.runNightly()
      expect(a.sorted).toEqual([EVERYTHING])
      expect(s).toMatchObject({ trigger: 'nightly', asked: 7, skipped: null })
      expect(s.period).toBeUndefined()
      expect(s.message).toBe('Asked Luna about 7 screenshots: 3 keep, 1 throwaway. 3 screenshots still need a look.')
      expect(a.sent()).toEqual(windowsOf(NAMES))
      expect(a.d.prompts).toHaveLength(0)
      expect(allowance(a.w)).toBe(7)
    })
  }

  it('still stops at the nightly limit', async () => {
    const a = app('7d')
    const db = new DatabaseSync(join(a.w, 'triage.db'))
    db.prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?)').run(NIGHT, NIGHTLY_LIMIT - 3)
    db.close()
    expect(await a.svc.runNightly()).toMatchObject({ asked: 3 })
    expect(a.sent()).toEqual(windowsOf(['recent', 'edge', 'justout'])) // the three newest of everything
    expect(allowance(a.w)).toBe(NIGHTLY_LIMIT)
  })

  it('a nightly batch does not use up or disturb a batch prepared for a period', async () => {
    const a = app('7d')
    const p = await a.svc.prepare()
    await a.svc.runNightly() // everything is answered
    expect(await a.svc.send(p.token)).toMatchObject({ asked: 0, skipped: 'nothing-doubtful' })
    expect(allowance(a.w)).toBe(7)
  })
})

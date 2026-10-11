// A second opinion from the other provider (ticket 17): answers are kept per screenshot and provider;
// a screenshot one provider answered and was unsure about may go to the other, once; one a provider
// decided, or that the selected provider has answered, never goes again. Also here: the upgrade of an
// answers table written before there was a row per provider.
// Fake transport only (sorter-cloud-fixture.ts); synthetic data, made-up keys.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter, NIGHTLY_LIMIT, secondOpinionNote, sendPrompt, turnOnPrompt } = await import('../src/main/sorter/cloud/service')
const { SorterStore, CloudAnswersUnavailable, migrateCloudAnswers } = await import('../src/main/sorter/store')
const { DEFAULT_THRESHOLDS, SORTER_VERSION } = await import('../src/main/sorter/decide')
const { isConfident, settledAnswer } = await import('../src/main/sorter/cloud/cascade')
const { HAIKU_PROVIDER, LUNA_PROVIDER, providerOfModel } = await import('../src/main/sorter/cloud/provider')
const { makeCloudWell, readProposal, bothStubs, cloudDeps, hashOf } = await import('./sorter-cloud-fixture')
import type { ShotSpec, Says } from './sorter-cloud-fixture'

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

const LUNA = { provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1' }
const HAIKU = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }
const scope = (me: typeof LUNA | typeof HAIKU, throwawayAt = DEFAULT_THRESHOLDS.throwaway) => ({ sorterVersion: SORTER_VERSION, ...me, others: [me === LUNA ? HAIKU : LUNA], throwawayAt })

const night1 = '2026-10-10'
const now1 = (): Date => new Date(2026, 9, 11, 2, 0)
const now2 = (): Date => new Date(2026, 9, 12, 2, 0)

const rows = <T>(w: string, q: string): T[] => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return db.prepare(q).all() as T[]
  } finally {
    db.close()
  }
}
const withStore = <T>(w: string, fn: (s: InstanceType<typeof SorterStore>) => T): T => {
  const s = new SorterStore(w)
  try {
    return fn(s)
  } finally {
    s.close()
  }
}
const allowance = (w: string, night: string): number => withStore(w, (s) => s.allowanceUsed(night))
const useAllowance = (w: string, night: string, sent: number): void => {
  const db = new DatabaseSync(join(w, 'triage.db'))
  db.prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?) ON CONFLICT(night) DO UPDATE SET sent = excluded.sent').run(night, sent)
  db.close()
}
type AnswerRow = { hash: string; provider: string; verdict: string; confidence: number; reason: string; model: string; prompt_version: string; asked_at: string }
const answers = (w: string): AnswerRow[] => rows<AnswerRow>(w, 'SELECT hash, provider, verdict, confidence, reason, model, prompt_version, asked_at FROM sorter_cloud_answers ORDER BY hash, provider')
/** How many answer rows each shot has, by shot name. */
const answeredBy = (w: string, names: string[]): Record<string, string[]> => {
  const all = answers(w)
  return Object.fromEntries(names.map((n) => [n, all.filter((r) => r.hash === hashOf(n)).map((r) => r.provider)]))
}
/** Every window title a stub was sent, across all its requests. */
const sent = (stub: { seen: Array<{ windows: string[] }> }): string[] => stub.seen.flatMap((r) => r.windows).sort()
const unsure: Says = () => ({ verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.' })

describe('eligibility across providers', () => {
  it('after Luna leaves some unsure, Haiku is offered exactly those plus the doubtful ones nobody has seen', async () => {
    const w = five()
    useAllowance(w, night1, NIGHTLY_LIMIT - 4) // Luna gets the four newest; d5 is seen by nobody
    const net = bothStubs()
    expect(await new CloudSorter(cloudDeps(w, { http: net.http, now: now1 })).runNightly()).toMatchObject({ provider: 'openai', asked: 4, keep: 1, throwaway: 1 })
    expect(sent(net.luna)).toEqual(['blurry', 'keep-chart', 'toss-wifi', 'weak-picker'])

    const d = cloudDeps(w, { http: net.http, now: now2, settings: { provider: 'anthropic' } })
    const svc = new CloudSorter(d)
    const p = await svc.prepare()
    expect(p).toMatchObject({ provider: 'anthropic', doubtful: 3, toSend: 3, secondOpinions: 2, secondNote: '2 of them ones Luna was unsure about', blocked: null })
    expect(p.message).toBe('Ask Haiku about 3 screenshots, 2 of them ones Luna was unsure about?')
    expect(p.estimate).toEqual(HAIKU_PROVIDER.estimateCost(3)) // the cost covers all three
    expect(net.haiku.seen).toHaveLength(0) // a preview sends nothing

    expect(await svc.send(p.token)).toMatchObject({ provider: 'anthropic', asked: 3, answered: 3, keep: 0, throwaway: 0 })
    expect(sent(net.haiku)).toEqual(['blurry', 'fresh', 'weak-picker']) // never the two Luna decided
    const dialog = d.prompts.at(-1)!
    expect(dialog).toMatchObject({ kind: 'send', provider: 'anthropic', count: 3, secondOpinions: 2, message: 'Send 3 screenshots to Haiku?', confirmLabel: 'Send 3' })
    expect(dialog.detail).toMatch(/^3 screenshots the sorter could not call, 2 of them ones Luna was unsure about, will go to Anthropic in 1 request\. Estimated cost at list price: /)
    expect(dialog.estimate).toEqual(HAIKU_PROVIDER.estimateCost(3))
  })

  it('the other way round: what Haiku left unsure is offered to Luna, and what Haiku decided is not', async () => {
    const w = four()
    const net = bothStubs()
    await new CloudSorter(cloudDeps(w, { http: net.http, settings: { provider: 'anthropic' } })).runNightly()
    const d = cloudDeps(w, { http: net.http })
    const svc = new CloudSorter(d)
    const p = await svc.prepare()
    expect(p).toMatchObject({ provider: 'openai', doubtful: 2, toSend: 2, secondOpinions: 2, message: 'Ask Luna about 2 screenshots, 2 of them ones Haiku was unsure about?' })
    expect(p.estimate).toEqual(LUNA_PROVIDER.estimateCost(2))
    await svc.send(p.token)
    expect(sent(net.luna)).toEqual(['blurry', 'weak-picker'])
    expect(d.prompts.at(-1)!.detail).toMatch(/^2 screenshots the sorter could not call, 2 of them ones Haiku was unsure about, will go to OpenAI in 1 request\. Estimated cost: /)
  })

  it('never eligible: one the selected provider has answered, however unsure it was', async () => {
    const w = four()
    const net = bothStubs()
    const svc = new CloudSorter(cloudDeps(w, { http: net.http }))
    expect(await svc.runNightly()).toMatchObject({ asked: 4 })
    // d3 and d4 are still doubtful, and Luna is not asked about them again
    expect(await svc.runNightly()).toMatchObject({ provider: 'openai', skipped: 'nothing-doubtful', asked: 0 })
    expect(await svc.prepare()).toMatchObject({ blocked: 'nothing-doubtful', doubtful: 0, toSend: 0, secondOpinions: 0, secondNote: '', token: null })
    expect(net.luna.seen).toHaveLength(1)
  })

  it('never eligible: one he has decided in Review or in Triage after the first provider was unsure', async () => {
    const w = four()
    const net = bothStubs()
    await new CloudSorter(cloudDeps(w, { http: net.http })).runNightly()
    withStore(w, (s) => s.setAnswer(hashOf('d3'), { answer: 'keep', answeredAt: '2026-10-11T08:00:00Z' }))
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, 'excluded', '2026-10-11', NULL)").run(hashOf('d4'))
    db.close()
    const svc = new CloudSorter(cloudDeps(w, { http: net.http, settings: { provider: 'anthropic' } }))
    expect(await svc.prepare()).toMatchObject({ blocked: 'nothing-doubtful', doubtful: 0 })
    expect(await svc.runNightly()).toMatchObject({ provider: 'anthropic', skipped: 'nothing-doubtful', asked: 0 })
    expect(net.haiku.seen).toHaveLength(0)
  })

  it('the store: which answers make a screenshot eligible, a second opinion, or neither', () => {
    const w = well(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((hash) => ({ hash, proposal: 'doubtful' as const })))
    const at = '2026-10-11T00:00:00Z'
    const T = DEFAULT_THRESHOLDS.throwaway
    withStore(w, (st) => {
      st.saveCloudResults(
        [
          { hash: hashOf('b'), verdict: 'unsure', confidence: 0.5, reason: 'x', ...HAIKU, askedAt: at }, // Haiku unsure: a second opinion for Luna
          { hash: hashOf('c'), verdict: 'keep', confidence: 0.2, reason: 'x', ...HAIKU, askedAt: at }, // a keep is a decision at any confidence
          { hash: hashOf('d'), verdict: 'throwaway', confidence: T, reason: 'x', ...HAIKU, askedAt: at }, // a throwaway at the threshold is a decision
          { hash: hashOf('e'), verdict: 'throwaway', confidence: T - 0.001, reason: 'x', ...HAIKU, askedAt: at }, // just below it: unsure
          { hash: hashOf('f'), verdict: 'keep', confidence: 0.9, reason: 'x', provider: 'anthropic', model: 'claude-haiku-4', promptVersion: 'haiku-prompt-0', askedAt: at }, // an older model's answer does not count
          { hash: hashOf('g'), verdict: 'unsure', confidence: 0.5, reason: 'x', ...LUNA, askedAt: at }, // Luna's own
          { hash: hashOf('g'), verdict: 'unsure', confidence: 0.5, reason: 'x', ...HAIKU, askedAt: at } // and Haiku's: both have answered
        ],
        []
      )
      const pending = (me: typeof LUNA | typeof HAIKU): Record<string, boolean> =>
        Object.fromEntries(st.cloudPending(scope(me)).map((p) => [['a', 'b', 'c', 'd', 'e', 'f', 'g'].find((n) => hashOf(n) === p.hash)!, p.secondOpinion]))
      expect(pending(LUNA)).toEqual({ a: false, b: true, e: true, f: false })
      // Haiku: its own current answers rule b–e and g out; f (its older model's) is asked again; a is new
      expect(pending(HAIKU)).toEqual({ a: false, f: false })
      // the claim and the check before each request apply the same test
      const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(hashOf)
      const eligible = ['a', 'b', 'e', 'f'].map(hashOf)
      expect(st.claimForCloud(all, { ...scope(LUNA), night: 'n', limit: 10, runId: 'r', now: new Date('2026-10-11T01:00:00Z') }).claimed).toEqual(eligible)
      expect(st.admitForRequest(all, { ...scope(LUNA), runId: 'r', night: 'n', limit: 10 })).toEqual({ admitted: eligible, overLimit: 0 })
      // Haiku decides b while Luna's run holds it: it is dropped before the request
      st.saveCloudResults([{ hash: hashOf('b'), verdict: 'keep', confidence: 0.9, reason: 'x', ...HAIKU, askedAt: at }], [])
      expect(st.admitForRequest(all, { ...scope(LUNA), runId: 'r', night: 'n', limit: 10 }).admitted).toEqual(['a', 'e', 'f'].map(hashOf))
    })
  })

  it('the store’s test for a decision is the cascade’s (isConfident), answer by answer', () => {
    const cases = [
      { verdict: 'keep' as const, confidence: 0 },
      { verdict: 'keep' as const, confidence: 1 },
      { verdict: 'unsure' as const, confidence: 1 },
      { verdict: 'throwaway' as const, confidence: 0.5 },
      { verdict: 'throwaway' as const, confidence: 0.899999 },
      { verdict: 'throwaway' as const, confidence: 0.9 },
      { verdict: 'throwaway' as const, confidence: 0.949999 },
      { verdict: 'throwaway' as const, confidence: 0.95 },
      { verdict: 'throwaway' as const, confidence: 0.97 },
      { verdict: 'throwaway' as const, confidence: 0.99 },
      { verdict: 'throwaway' as const, confidence: 1 }
    ]
    const w = well(cases.map((_, i) => ({ hash: `c${i}`, proposal: 'doubtful' as const })))
    withStore(w, (st) => {
      st.saveCloudResults(cases.map((c, i) => ({ hash: hashOf(`c${i}`), ...c, reason: 'x', ...HAIKU, askedAt: '2026-10-11T00:00:00Z' })), [])
      for (const throwaway of [DEFAULT_THRESHOLDS.throwaway, 0.95, 0.97, 0.999]) {
        const offered = new Set(st.cloudPending(scope(LUNA, throwaway)).map((p) => p.hash))
        cases.forEach((c, i) => expect([throwaway, c, offered.has(hashOf(`c${i}`))]).toEqual([throwaway, c, !isConfident(c, { ...DEFAULT_THRESHOLDS, throwaway })]))
      }
    })
  })
})

describe('no further sends after both have answered', () => {
  it('each screenshot goes to each provider at most once; switching back and forth afterwards sends nothing', async () => {
    const w = four()
    const net = bothStubs()
    const run = async (provider: 'openai' | 'anthropic', now: () => Date) => {
      const svc = new CloudSorter(cloudDeps(w, { http: net.http, now, settings: { provider } }))
      const nightly = await svc.runNightly()
      const p = await svc.prepare()
      const manual = p.token ? await svc.send(p.token) : null
      return { nightly, p, manual }
    }
    expect((await run('openai', now1)).nightly).toMatchObject({ asked: 4 })
    expect((await run('anthropic', now1)).nightly).toMatchObject({ asked: 2, stayedDoubtful: 2 })
    const requests = net.urls.length
    expect(requests).toBe(2)
    for (let i = 0; i < 4; i++) {
      for (const provider of ['openai', 'anthropic'] as const) {
        const r = await run(provider, i % 2 ? now2 : now1) // the same night and the next
        expect(r.nightly).toMatchObject({ provider, skipped: 'nothing-doubtful', asked: 0 })
        expect(r.p).toMatchObject({ blocked: 'nothing-doubtful', doubtful: 0, toSend: 0, token: null })
        expect(r.manual).toBeNull()
      }
    }
    expect(net.urls.length).toBe(requests)
    // once per provider, twice in all, and only for the two Luna was unsure about
    expect(sent(net.luna)).toEqual(['blurry', 'keep-chart', 'toss-wifi', 'weak-picker'])
    expect(sent(net.haiku)).toEqual(['blurry', 'weak-picker'])
    expect(answeredBy(w, ['d1', 'd2', 'd3', 'd4'])).toEqual({ d1: ['openai'], d2: ['openai'], d3: ['anthropic', 'openai'], d4: ['anthropic', 'openai'] })
    expect(allowance(w, night1)).toBe(6)
    // the two both were unsure about wait in Review
    for (const h of ['d3', 'd4']) expect(readProposal(w, h)).toMatchObject({ proposal: 'doubtful' })
  })
})

describe('second opinions use the one shared nightly allowance', () => {
  it('they are counted at send, in the same row as first opinions, whichever provider asks', async () => {
    const w = four()
    const net = bothStubs()
    await new CloudSorter(cloudDeps(w, { http: net.http, now: now1 })).runNightly()
    expect(allowance(w, night1)).toBe(4)
    const svc = new CloudSorter(cloudDeps(w, { http: net.http, now: now1, settings: { provider: 'anthropic' } }))
    const p = await svc.prepare()
    expect(p).toMatchObject({ toSend: 2, secondOpinions: 2, leftTonight: NIGHTLY_LIMIT - 4 })
    expect(allowance(w, night1)).toBe(4) // a preview uses none of it
    await svc.send(p.token)
    expect(rows(w, 'SELECT night, sent FROM sorter_cloud_allowance')).toEqual([{ night: night1, sent: 6 }])
  })

  it('with one left tonight, one second opinion goes and the other waits; with none left, none goes', async () => {
    const w = four()
    useAllowance(w, night1, NIGHTLY_LIMIT - 5)
    const net = bothStubs()
    await new CloudSorter(cloudDeps(w, { http: net.http, now: now1 })).runNightly() // Luna: four, one left
    const d = cloudDeps(w, { http: net.http, now: now1, settings: { provider: 'anthropic' } })
    const svc = new CloudSorter(d)
    const p = await svc.prepare()
    expect(p).toMatchObject({ doubtful: 2, toSend: 1, secondOpinions: 1, secondNote: 'one Luna was unsure about', leftTonight: 1, blocked: null })
    expect(p.message).toBe('Ask Haiku about 1 screenshot of 2 (1 left of tonight’s 300), one Luna was unsure about?')
    expect(p.estimate).toEqual(HAIKU_PROVIDER.estimateCost(1))
    expect(await svc.send(p.token)).toMatchObject({ asked: 1 })
    expect(d.prompts.at(-1)).toMatchObject({ kind: 'send', count: 1, secondOpinions: 1 })
    expect(sent(net.haiku)).toEqual(['weak-picker']) // the newer of the two
    expect(allowance(w, night1)).toBe(NIGHTLY_LIMIT)
    // nothing is left for the other second opinion tonight, by Sort now or by the nightly run
    expect(await svc.prepare()).toMatchObject({ blocked: 'limit-reached', doubtful: 1, toSend: 0, secondOpinions: 0, token: null })
    expect(await svc.runNightly()).toMatchObject({ skipped: 'limit-reached', asked: 0 })
    expect(net.haiku.seen).toHaveLength(1)
    expect(allowance(w, night1)).toBe(NIGHTLY_LIMIT)
    // the next night it goes
    expect(await new CloudSorter(cloudDeps(w, { http: net.http, now: now2, settings: { provider: 'anthropic' } })).runNightly()).toMatchObject({ asked: 1 })
    expect(sent(net.haiku)).toEqual(['blurry', 'weak-picker'])
  })
})

describe('what a second answer does to the proposal', () => {
  it('a confident second answer becomes the proposal in the second provider’s name and model; an unsure one leaves it in Review; the first row is kept', async () => {
    const w = four()
    const net = bothStubs({ lunaSays: unsure }) // Luna is unsure about all four; Haiku answers as the fixture does
    await new CloudSorter(cloudDeps(w, { http: net.http })).runNightly()
    for (const h of ['d1', 'd2', 'd3', 'd4']) expect(readProposal(w, h)).toMatchObject({ proposal: 'doubtful', decided_by: 'luna', decided_model: 'gpt-6-luna' })
    const lunaRows = answers(w)
    expect(lunaRows.map((r) => [r.provider, r.verdict])).toEqual(Array(4).fill(['openai', 'unsure']))

    const s = await new CloudSorter(cloudDeps(w, { http: net.http, settings: { provider: 'anthropic' } })).runNightly()
    expect(s).toMatchObject({ provider: 'anthropic', asked: 4, answered: 4, keep: 1, throwaway: 1, stayedDoubtful: 2 })
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'keep', decided_by: 'haiku', decided_model: 'claude-haiku-5-5', reason: 'A chart worth keeping' })
    expect(readProposal(w, 'd2')).toMatchObject({ proposal: 'throwaway', decided_by: 'haiku', decided_model: 'claude-haiku-5-5', reason: 'A settings pane' })
    expect(readProposal(w, 'd2')?.throwaway_since).not.toBeNull()
    // unsure again: it waits in Review, as after an unsure first answer, with the words of the one asked last
    expect(readProposal(w, 'd3')).toMatchObject({ proposal: 'doubtful', decided_by: 'haiku', decided_model: 'claude-haiku-5-5', reason: 'Not sure: Haiku leans throwaway (70%), not sure enough to throw away: probably a file picker' })
    expect(readProposal(w, 'd4')).toMatchObject({ proposal: 'doubtful', decided_by: 'haiku', reason: 'Not sure, and Haiku was not sure either: hard to tell' })
    // Luna's four rows are exactly as they were, beside Haiku's four
    const after = answers(w)
    expect(after.filter((r) => r.provider === 'openai')).toEqual(lunaRows)
    expect(after.filter((r) => r.provider === 'anthropic').map((r) => [r.verdict, r.model, r.prompt_version]).sort()).toEqual(
      [
        ['keep', 'claude-haiku-5-5', 'haiku-prompt-1'],
        ['throwaway', 'claude-haiku-5-5', 'haiku-prompt-1'],
        ['throwaway', 'claude-haiku-5-5', 'haiku-prompt-1'],
        ['unsure', 'claude-haiku-5-5', 'haiku-prompt-1']
      ].sort()
    )
  })

  it('and with the providers the other way round, in Luna’s name', async () => {
    const w = four()
    const net = bothStubs({ haikuSays: unsure })
    await new CloudSorter(cloudDeps(w, { http: net.http, settings: { provider: 'anthropic' } })).runNightly()
    await new CloudSorter(cloudDeps(w, { http: net.http })).runNightly()
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'keep', decided_by: 'luna', decided_model: 'gpt-6-luna' })
    expect(readProposal(w, 'd2')).toMatchObject({ proposal: 'throwaway', decided_by: 'luna', decided_model: 'gpt-6-luna' })
    expect(readProposal(w, 'd4')).toMatchObject({ proposal: 'doubtful', decided_by: 'luna', reason: 'Not sure, and Luna was not sure either: hard to tell' })
    expect(answeredBy(w, ['d1', 'd4'])).toEqual({ d1: ['anthropic', 'openai'], d4: ['anthropic', 'openai'] })
  })

  it('settledAnswer: the decision stands; with none, the answer asked last; keep wins if the thresholds moved', () => {
    const a = (provider: string, verdict: 'keep' | 'throwaway' | 'unsure', confidence: number, askedAt: string) => ({ provider, verdict, confidence, askedAt })
    expect(settledAnswer([])).toBeNull()
    const first = a('openai', 'unsure', 0.5, '2026-10-10T02:00:00Z')
    expect(settledAnswer([first])).toBe(first)
    const keep = a('anthropic', 'keep', 0.8, '2026-10-11T02:00:00Z')
    expect(settledAnswer([first, keep])).toBe(keep)
    expect(settledAnswer([keep, first])).toBe(keep)
    // the decision stands even when the unsure answer came later
    const laterUnsure = a('openai', 'unsure', 0.5, '2026-10-12T02:00:00Z')
    expect(settledAnswer([keep, laterUnsure])).toBe(keep)
    // neither is a decision: the one asked last
    const weak = a('anthropic', 'throwaway', 0.7, '2026-10-11T02:00:00Z')
    expect(settledAnswer([first, weak])).toBe(weak)
    expect(settledAnswer([weak, first])).toBe(weak)
    // 0.96 was unsure under a 0.97 threshold, so the other was asked and said keep; under 0.95 both are decisions: keep
    const toss = a('openai', 'throwaway', 0.96, '2026-10-12T02:00:00Z')
    expect(settledAnswer([toss, keep], { ...DEFAULT_THRESHOLDS, throwaway: 0.95 })).toBe(keep)
    expect(settledAnswer([toss, keep], { ...DEFAULT_THRESHOLDS, throwaway: 0.97 })).toBe(keep)
    expect(settledAnswer([toss, weak], { ...DEFAULT_THRESHOLDS, throwaway: 0.95 })).toBe(toss)
  })
})

describe('the counts shown', () => {
  it('the words for second opinions', () => {
    expect(secondOpinionNote(12, 0, HAIKU_PROVIDER)).toBe('')
    expect(secondOpinionNote(12, 5, HAIKU_PROVIDER)).toBe('5 of them ones Luna was unsure about')
    expect(secondOpinionNote(12, 1, HAIKU_PROVIDER)).toBe('1 of them one Luna was unsure about')
    expect(secondOpinionNote(1, 1, HAIKU_PROVIDER)).toBe('one Luna was unsure about')
    expect(secondOpinionNote(1200, 1100, LUNA_PROVIDER)).toBe('1,100 of them ones Haiku was unsure about')
  })

  it('the send dialog gives them as their own number and estimates the cost of all', () => {
    const p = sendPrompt(12, HAIKU_PROVIDER, 5)
    expect(p).toMatchObject({ kind: 'send', provider: 'anthropic', count: 12, secondOpinions: 5, message: 'Send 12 screenshots to Haiku?', confirmLabel: 'Send 12' })
    expect(p.detail).toMatch(/^12 screenshots the sorter could not call, 5 of them ones Luna was unsure about, will go to Anthropic in /)
    expect(p.estimate).toEqual(HAIKU_PROVIDER.estimateCost(12))
    // with none, the dialog reads as it did
    expect(sendPrompt(12, HAIKU_PROVIDER)).toMatchObject({ secondOpinions: 0 })
    expect(sendPrompt(12, HAIKU_PROVIDER).detail).toMatch(/^12 screenshots the sorter could not call will go to Anthropic in /)
    expect(sendPrompt(4).detail).not.toMatch(/unsure about/)
  })

  it('the turn-on dialog says how many of those waiting the other provider was unsure about', async () => {
    expect(turnOnPrompt(12, 300, HAIKU_PROVIDER, LUNA_PROVIDER, 5).detail).toMatch(/12 doubtful screenshots are waiting now, 5 of them ones Luna was unsure about; 12 screenshots would go at the next sort\./)
    expect(turnOnPrompt(4, 300).detail).toMatch(/^4 doubtful screenshots are waiting now; 4 screenshots would go at the next sort\./)
    // as main raises it when he chooses Haiku after a Luna run
    const w = five()
    useAllowance(w, night1, NIGHTLY_LIMIT - 4)
    await new CloudSorter(cloudDeps(w, { now: now1 })).runNightly()
    const d = cloudDeps(w, { now: now2 })
    expect(await new CloudSorter(d).consentToTurnOn('anthropic', 'openai')).toBe(true)
    expect(d.prompts).toHaveLength(1)
    expect(d.prompts[0]).toMatchObject({ kind: 'turn-on', provider: 'anthropic', count: 3, secondOpinions: 2 })
    expect(d.prompts[0].detail).toMatch(/3 doubtful screenshots are waiting now, 2 of them ones Luna was unsure about; 3 screenshots would go at the next sort\. Estimated cost at list price: /)
    expect(d.prompts[0].estimate).toEqual(HAIKU_PROVIDER.estimateCost(3))
  })
})

// ---------------------------------------------------------------------------------------------
// The upgrade. Until ticket 17 the table had one row per screenshot:
const BEFORE_17 = `CREATE TABLE sorter_cloud_answers (
  hash TEXT PRIMARY KEY,
  verdict TEXT NOT NULL CHECK (verdict IN ('keep', 'throwaway', 'unsure')),
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  asked_at TEXT NOT NULL
)`
type OldRow = Omit<AnswerRow, 'provider'>
/** Put the well's answers table back as an earlier version of the app left it, holding `old`. */
function asBefore17(w: string, old: OldRow[], ddl = BEFORE_17): void {
  const db = new DatabaseSync(join(w, 'triage.db'))
  db.exec('DROP TABLE sorter_cloud_answers')
  db.exec(ddl)
  const put = db.prepare('INSERT INTO sorter_cloud_answers (hash, verdict, confidence, reason, model, prompt_version, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const r of old) put.run(r.hash, r.verdict, r.confidence, r.reason, r.model, r.prompt_version, r.asked_at)
  db.close()
}
const columns = (w: string, table = 'sorter_cloud_answers'): Array<{ name: string; pk: number }> => rows(w, `SELECT name, pk FROM pragma_table_info('${table}')`)
const oldRows = (): OldRow[] => [
  { hash: hashOf('d1'), verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell', model: 'gpt-6-luna', prompt_version: 'luna-prompt-1', asked_at: '2026-10-09T02:00:00.000Z' },
  { hash: hashOf('d2'), verdict: 'keep', confidence: 0.93, reason: 'A chart worth keeping', model: 'gpt-6-luna', prompt_version: 'luna-prompt-1', asked_at: '2026-10-09T02:00:01.000Z' },
  { hash: hashOf('d3'), verdict: 'throwaway', confidence: 0.7, reason: 'Probably a file picker', model: 'claude-haiku-5-5', prompt_version: 'haiku-prompt-1', asked_at: '2026-10-10T02:00:00.000Z' },
  { hash: hashOf('d4'), verdict: 'throwaway', confidence: 0.99, reason: 'A settings pane', model: 'some-other-model', prompt_version: 'luna-prompt-1', asked_at: '2026-10-08T02:00:00.000Z' },
  { hash: 'a-screenshot-no-longer-in-triage', verdict: 'keep', confidence: 0.9, reason: 'A diagram', model: 'claude-haiku-5-5', prompt_version: 'haiku-prompt-1', asked_at: '2026-10-10T02:00:02.000Z' }
]

describe('an answers table from before there was a row per provider', () => {
  it('is migrated on open: every row kept, each with the provider its model belongs to; opening again changes nothing', () => {
    const w = four()
    asBefore17(w, oldRows())
    expect(columns(w).map((c) => c.name)).toEqual(['hash', 'verdict', 'confidence', 'reason', 'model', 'prompt_version', 'asked_at'])

    expect(withStore(w, (s) => s.cloudAnswersReady())).toBe(true)
    expect(columns(w)).toEqual([
      { name: 'hash', pk: 1 },
      { name: 'provider', pk: 2 },
      { name: 'verdict', pk: 0 },
      { name: 'confidence', pk: 0 },
      { name: 'reason', pk: 0 },
      { name: 'model', pk: 0 },
      { name: 'prompt_version', pk: 0 },
      { name: 'asked_at', pk: 0 }
    ])
    const provider: Record<string, string> = { [hashOf('d1')]: 'openai', [hashOf('d2')]: 'openai', [hashOf('d3')]: 'anthropic', [hashOf('d4')]: 'unknown', 'a-screenshot-no-longer-in-triage': 'anthropic' }
    const expected = oldRows()
      .map((r) => ({ ...r, provider: provider[r.hash] }))
      .sort((a, b) => (a.hash < b.hash ? -1 : 1))
    const migrated = answers(w)
    expect(migrated).toEqual(expected.map((r) => ({ hash: r.hash, provider: r.provider, verdict: r.verdict, confidence: r.confidence, reason: r.reason, model: r.model, prompt_version: r.prompt_version, asked_at: r.asked_at })))
    expect(rows(w, "SELECT name FROM sqlite_master WHERE name LIKE 'sorter_cloud_answers%' ORDER BY name")).toEqual([{ name: 'sorter_cloud_answers' }]) // no table left beside it

    // again, and again through the function itself: nothing to do, nothing changed
    withStore(w, () => undefined)
    const db = new DatabaseSync(join(w, 'triage.db'))
    expect(migrateCloudAnswers(db)).toBeNull()
    expect(migrateCloudAnswers(db)).toBeNull()
    db.close()
    expect(answers(w)).toEqual(migrated)
  })

  it('the provider of an old row is the one whose model id it carries; any other model id is nobody’s', () => {
    expect(providerOfModel('gpt-6-luna')).toBe('openai')
    expect(providerOfModel('claude-haiku-5-5')).toBe('anthropic')
    for (const m of ['', 'some-other-model', 'claude-haiku-4', 'GPT-6-LUNA', 'openai', 'anthropic']) expect(providerOfModel(m)).toBeNull()
  })

  it('migrated answers count as before and open the second opinion: Luna’s unsure one may go to Haiku, its decided one may not', async () => {
    const w = four()
    asBefore17(w, oldRows())
    const names = ['d1', 'd2', 'd3', 'd4']
    const pending = (me: typeof LUNA | typeof HAIKU): Record<string, boolean> =>
      withStore(w, (st) => Object.fromEntries(st.cloudPending(scope(me)).map((p) => [names.find((n) => hashOf(n) === p.hash)!, p.secondOpinion])))
    // d1 Luna unsure · d2 Luna keep · d3 Haiku unsure (0.7 throwaway) · d4 an answer under neither provider's model
    expect(pending(HAIKU)).toEqual({ d1: true, d4: false })
    expect(pending(LUNA)).toEqual({ d3: true, d4: false })

    const net = bothStubs({ haikuSays: () => ({ verdict: 'keep', confidence: 0.9, reason: 'Worth keeping.' }) })
    const s = await new CloudSorter(cloudDeps(w, { http: net.http, settings: { provider: 'anthropic' } })).runNightly()
    expect(s).toMatchObject({ provider: 'anthropic', asked: 2, keep: 2 })
    expect(sent(net.haiku)).toEqual(['blurry', 'keep-chart'])
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'keep', decided_by: 'haiku', decided_model: 'claude-haiku-5-5' })
    // Luna's migrated row for d1 is still there, word for word, beside Haiku's new one
    const d1 = answers(w).filter((r) => r.hash === hashOf('d1'))
    expect(d1.map((r) => r.provider)).toEqual(['anthropic', 'openai'])
    expect(d1[1]).toEqual({ ...oldRows()[0], provider: 'openai' })
    // the row that was nobody's is kept too, beside the answer Haiku has now given
    expect(answers(w).filter((r) => r.hash === hashOf('d4')).map((r) => [r.provider, r.model])).toEqual([['anthropic', 'claude-haiku-5-5'], ['unknown', 'some-other-model']])
  })

  it('an empty old table, and a database with no answers table at all, open in the new shape', () => {
    const w = four()
    asBefore17(w, [])
    withStore(w, (s) => expect(s.cloudAnswersReady()).toBe(true))
    expect(columns(w).map((c) => c.name)).toContain('provider')
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.exec('DROP TABLE sorter_cloud_answers')
    db.close()
    withStore(w, (s) => expect(s.cloudAnswersReady()).toBe(true))
    expect(columns(w).filter((c) => c.pk).map((c) => c.name)).toEqual(['hash', 'provider'])
  })

  it('if the upgrade fails the old rows are left exactly as they were and the cloud step is unavailable: nothing is sent', async () => {
    const w = four()
    // an old table that holds a row the new one refuses (a verdict that is none of the three)
    const loose = BEFORE_17.replace(/ CHECK \(verdict IN \('keep', 'throwaway', 'unsure'\)\)/, '')
    expect(loose).not.toBe(BEFORE_17)
    const old = [...oldRows(), { hash: 'odd', verdict: 'maybe', confidence: 0.5, reason: 'x', model: 'gpt-6-luna', prompt_version: 'luna-prompt-1', asked_at: '2026-10-09T02:00:03.000Z' }]
    asBefore17(w, old, loose)
    const before = rows(w, 'SELECT * FROM sorter_cloud_answers ORDER BY hash')
    expect(before).toHaveLength(6)

    withStore(w, (s) => {
      expect(s.cloudAnswersReady()).toBe(false)
      // the rest of the store works: proposals can be read and answered in Review
      expect(s.pendingCounts()).toMatchObject({ doubtful: 4 })
      s.setAnswer(hashOf('d4'), null)
      // nothing reads or writes the answers
      expect(() => s.cloudPending(scope(LUNA))).toThrow(CloudAnswersUnavailable)
      expect(() => s.cloudAnswersIn([LUNA, HAIKU])).toThrow(CloudAnswersUnavailable)
      expect(() => s.claimForCloud([hashOf('d1')], { ...scope(LUNA), night: 'n', limit: 10, runId: 'r', now: new Date() })).toThrow(CloudAnswersUnavailable)
      expect(() => s.admitForRequest([hashOf('d1')], { ...scope(LUNA), runId: 'r', night: 'n', limit: 10 })).toThrow(CloudAnswersUnavailable)
      expect(() => s.saveCloudResults([{ hash: hashOf('d1'), verdict: 'keep', confidence: 0.9, reason: 'x', ...LUNA, askedAt: 'now' }], [])).toThrow(CloudAnswersUnavailable)
    })
    // the old table, untouched, and nothing left beside it
    expect(columns(w).map((c) => c.name)).toEqual(['hash', 'verdict', 'confidence', 'reason', 'model', 'prompt_version', 'asked_at'])
    expect(rows(w, 'SELECT * FROM sorter_cloud_answers ORDER BY hash')).toEqual(before)
    expect(rows(w, "SELECT name FROM sqlite_master WHERE name LIKE 'sorter_cloud_answers_%' AND type = 'table'")).toEqual([])

    for (const provider of ['openai', 'anthropic'] as const) {
      const net = bothStubs()
      const d = cloudDeps(w, { http: net.http, settings: { provider } })
      const svc = new CloudSorter(d)
      const p = await svc.prepare()
      expect(p).toMatchObject({ provider, blocked: 'unavailable', toSend: 0, token: null })
      expect(p.message).toBe('The answers stored on this Mac could not be read, so nothing can be sent. The stored answers were left as they are.')
      expect(await svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
      const s = await svc.runNightly()
      expect(s).toMatchObject({ provider, skipped: 'unavailable', asked: 0, error: null })
      expect(s.message).toMatch(/was not asked\. The answers stored on this Mac could not be read, so nothing can be sent\./)
      expect(await svc.consentToTurnOn(provider)).toBe(false) // and it cannot be turned on
      expect(d.prompts).toEqual([])
      expect(net.urls).toEqual([])
    }
    expect(rows(w, 'SELECT * FROM sorter_cloud_answers ORDER BY hash')).toEqual(before)
    expect(rows(w, 'SELECT * FROM sorter_cloud_allowance')).toEqual([])

    // once the row is one the new table takes, the next open migrates
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("UPDATE sorter_cloud_answers SET verdict = 'unsure' WHERE hash = 'odd'").run()
    db.close()
    withStore(w, (s) => expect(s.cloudAnswersReady()).toBe(true))
    expect(answers(w)).toHaveLength(6)
    expect(answers(w).find((r) => r.hash === 'odd')).toMatchObject({ provider: 'openai', verdict: 'unsure' })
  })

  it('a failure part-way through the copy rolls everything back (the function itself)', () => {
    const w = four()
    asBefore17(w, oldRows())
    const db = new DatabaseSync(join(w, 'triage.db'))
    // the name the new table is built under is taken: the migration cannot proceed
    db.exec('CREATE TABLE sorter_cloud_answers_by_provider (note TEXT)')
    db.prepare('INSERT INTO sorter_cloud_answers_by_provider (note) VALUES (?)').run('not ours')
    expect(() => migrateCloudAnswers(db)).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM sorter_cloud_answers').get()).toEqual({ n: 5 })
    expect(db.prepare('SELECT note FROM sorter_cloud_answers_by_provider').all()).toEqual([{ note: 'not ours' }])
    expect((db.prepare("SELECT name FROM pragma_table_info('sorter_cloud_answers')").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('provider')
    // and the connection is usable afterwards (no transaction left open)
    db.exec('BEGIN IMMEDIATE; COMMIT')
    db.exec('DROP TABLE sorter_cloud_answers_by_provider')
    expect(migrateCloudAnswers(db)).toBe(5)
    db.close()
    expect(answers(w)).toHaveLength(5)
  })
})

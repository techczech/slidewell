import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { addShots, countRows, fakePictures, openTriage, proposalsOf, seedProposals, teachWell, type FixtureShot, type ProposalSeed } from './sorter-teach-fixture'
import type { SorterRetrain } from '../src/preload'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { SorterService } = await import('../src/main/sorter/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { doubtfulProposals, writeRescored } = await import('../src/main/sorter/rescore')
const { Retrainer, storedRetrain } = await import('../src/main/sorter/retrain')

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})

/** 70 kept + 30 thrown away, and undecided screenshots: some that look kept, some thrown away, some neither. */
function well(): string {
  const undecided: FixtureShot[] = [
    ...Array.from({ length: 6 }, (_, i) => ({ hash: `new-keep-${i}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ hash: `new-toss-${i}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ hash: `new-plain-${i}` })),
    { hash: 'never-sorted-keep' }
  ]
  const w = teachWell(70, 30, undecided)
  wells.push(w)
  new SorterStore(w).close() // the sorter's tables
  // as an earlier, weaker model left them: everything doubtful, in one sort run
  seedProposals(w, undecided.filter((s) => s.hash !== 'never-sorted-keep').map((s) => ({ hash: s.hash, sorterVersion: SORTER_VERSION, runId: 'run-earlier' })))
  return w
}

const service = (w: string): InstanceType<typeof SorterService> => new SorterService({ wellRoot: () => w, pictures: fakePictures(), broadcast: () => undefined })

describe('what moved after a retrain', () => {
  it('re-scores existing proposals of undecided screenshots and counts those that moved to sure', async () => {
    const w = well()
    const r = await service(w).trainAndTest({ rescore: true })
    expect(r.ok).toBe(true)
    const after = proposalsOf(w)
    const sure = [...after.values()].filter((p) => p.proposal !== 'doubtful')
    expect(r.moved).toMatchObject({ rescored: 15, needALook: { before: 15, after: 15 - sure.length } })
    expect(r.moved!.movedToSure).toEqual({ keep: sure.filter((p) => p.proposal === 'keep').length, throwaway: sure.filter((p) => p.proposal === 'throwaway').length })
    expect(r.moved!.movedToSure.keep).toBeGreaterThanOrEqual(5) // the ones that look like what he kept
    expect([...r.moved!.movedHashes].sort()).toEqual([...after].filter(([, p]) => p.proposal !== 'doubtful').map(([h]) => h).sort())
    for (const h of r.moved!.movedHashes) expect(h).toMatch(/keep|toss/)
    expect(after.get('new-plain-0')!.proposal).toBe('doubtful')
  })

  it('is not a sort: no run, no new proposal, no decision, and each row stays in its run with its time', async () => {
    const w = well()
    const decisions = countRows(w, 'triage_decisions')
    const r = await service(w).trainAndTest({ rescore: true })
    expect(r.moved!.rescored).toBe(15)
    expect(countRows(w, 'sorter_runs')).toBe(0)
    expect(countRows(w, 'triage_decisions')).toBe(decisions)
    const after = proposalsOf(w)
    expect(after.has('never-sorted-keep')).toBe(false)
    expect(after.size).toBe(15)
    for (const p of after.values()) {
      expect(p.run_id).toBe('run-earlier')
      expect(p.proposed_at).toBe('2026-10-10T08:00:00.000Z')
      expect(p.sorter_version).toBe(SORTER_VERSION)
      expect(p.model_id).toBe(`model-${r.report!.trainedAt}`)
      expect(p.throwaway_since === null).toBe(p.proposal !== 'throwaway')
    }
  })

  it('leaves alone what he has decided or answered since', async () => {
    const w = well()
    addShots(w, [{ hash: 'new-keep-0', state: 'excluded' }]) // he threw it away in Triage
    const t = openTriage(w)
    t.prepare("UPDATE sorter_proposals SET answered_at = '2026-10-12T10:00:00.000Z', answer = 'keep' WHERE hash = 'new-keep-1'").run()
    t.close()
    const r = await service(w).trainAndTest({ rescore: true })
    expect(r.moved!.needALook.before).toBe(13)
    expect(r.moved!.movedHashes).not.toContain('new-keep-0')
    expect(r.moved!.movedHashes).not.toContain('new-keep-1')
    const after = proposalsOf(w)
    expect(after.get('new-keep-0')).toMatchObject({ proposal: 'doubtful', p_keep: 0.5, model_id: null })
    expect(after.get('new-keep-1')).toMatchObject({ proposal: 'doubtful', p_keep: 0.5, model_id: null })
  })

  it('without rescore a training changes no proposal', async () => {
    const w = well()
    const before = proposalsOf(w)
    const r = await service(w).trainAndTest()
    expect(r.ok).toBe(true)
    expect(r.moved ?? null).toBeNull()
    expect(proposalsOf(w)).toEqual(before)
  })

  it('says what the model before was (none the first time), and records the choices it was trained with', async () => {
    const w = well()
    const svc = service(w)
    const first = await svc.trainAndTest({ rescore: true })
    expect(first.before).toBeNull()
    expect(first.report!.choicesAtTraining).toBe(100)
    addShots(w, Array.from({ length: 10 }, (_, i) => ({ hash: `more-keep-${i}`, state: 'included' as const })))
    expect(svc.choices()).toEqual({ learnable: { kept: 80, binned: 30 }, trainedWith: 100 })
    expect(svc.status()).toMatchObject({ answersSinceTraining: 0, autoRetrain: false, choicesNeeded: 0, lastRetrain: null }) // nothing supplies the teaching status here
    const second = await svc.trainAndTest({ rescore: true })
    expect(second.before!.trainedAt).toBe(first.report!.trainedAt)
    expect(second.report!.choicesAtTraining).toBe(110)
  })

  it('a row changed since it was read is left to whoever changed it', () => {
    const w = well()
    const read = doubtfulProposals(w, SORTER_VERSION)
    expect(read).toHaveLength(15)
    const row = (hash: string, proposal: 'keep' | 'throwaway', proposedAt: string) => ({ hash, proposal, confidence: 0.95, pKeep: proposal === 'keep' ? 0.95 : 0.05, reason: 'Looks like screenshots you kept before', rule: null, decidedBy: 'history' as const, proposedAt })
    seedProposals(w, [{ hash: 'new-keep-2', sorterVersion: SORTER_VERSION, runId: 'run-later', proposedAt: '2026-10-12T09:00:00.000Z' }]) // a sort got there first
    const written = writeRescored(w, [row('new-keep-2', 'keep', '2026-10-10T08:00:00.000Z'), row('new-keep-3', 'keep', '2026-10-10T08:00:00.000Z'), row('new-toss-0', 'throwaway', '2026-10-10T08:00:00.000Z'), row('no-such-row', 'keep', '2026-10-10T08:00:00.000Z')], SORTER_VERSION, 'model-x', new Date('2026-10-13T10:00:00.000Z'))
    expect(written).toEqual(['new-keep-3', 'new-toss-0'])
    const after = proposalsOf(w)
    expect(after.get('new-keep-2')).toMatchObject({ proposal: 'doubtful', run_id: 'run-later' })
    expect(after.get('new-keep-3')).toMatchObject({ proposal: 'keep', run_id: 'run-earlier', throwaway_since: null })
    expect(after.get('new-toss-0')).toMatchObject({ proposal: 'throwaway', throwaway_since: '2026-10-13T10:00:00.000Z' }) // its 30-day clock starts now
    expect(after.has('no-such-row')).toBe(false)
    // a row that is sure by now is not written again, whatever is passed: only a real sort changes it
    expect(writeRescored(w, [row('new-toss-0', 'keep', '2026-10-10T08:00:00.000Z'), row('new-keep-3', 'throwaway', '2026-10-10T08:00:00.000Z')], SORTER_VERSION, 'model-y', new Date('2026-10-20T10:00:00.000Z'))).toEqual([])
    expect(proposalsOf(w)).toEqual(after)
  })
})

describe('a re-score that does not finish', () => {
  /** A service whose picture engine does `then` the first time the re-score asks it for anything (the training asks once before that). */
  function failing(w: string, then: (svc: InstanceType<typeof SorterService>) => void): { svc: InstanceType<typeof SorterService>; lines: string[] } {
    const pictures = fakePictures()
    const lines: string[] = []
    let asked = 0
    const svc: InstanceType<typeof SorterService> = new SorterService({
      wellRoot: () => w,
      pictures: {
        modelReady: () => true,
        ensureVectors: async (items) => {
          if (++asked === 2) then(svc)
          return pictures.ensureVectors(items)
        }
      },
      broadcast: () => undefined,
      log: (l) => void lines.push(l)
    })
    return { svc, lines }
  }

  it('logs one line when it fails; the training stands and no proposal changed', async () => {
    const w = well()
    const before = proposalsOf(w)
    const { svc, lines } = failing(w, () => {
      throw new Error(`could not read ${w}/source/new-keep-0.png`)
    })
    const r = await svc.trainAndTest({ rescore: true })
    expect(r).toMatchObject({ ok: true, moved: null })
    expect(lines).toEqual(['[sorter] the re-score after training failed (Error); proposals keep their earlier scores'])
    expect(proposalsOf(w)).toEqual(before)
  })

  it('logs one line when it is stopped', async () => {
    const w = well()
    const { svc, lines } = failing(w, (s) => s.cancel())
    const r = await svc.trainAndTest({ rescore: true })
    expect(r.ok).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[sorter\] the re-score after training was stopped/)
    expect(lines[0]).not.toContain(w)
  })

  it('stopped part-way: what moved is recorded as not checked, never as the counts of a part; the rows already written stay', async () => {
    // 60 doubtful proposals: the re-score writes them 50 at a time, and is stopped as it starts on the rest
    const undecided: FixtureShot[] = Array.from({ length: 60 }, (_, i) => ({ hash: `late-${i % 2 ? 'keep' : 'plain'}-${i}` }))
    const w = teachWell(70, 30, undecided)
    wells.push(w)
    new SorterStore(w).close()
    seedProposals(w, undecided.map((s) => ({ hash: s.hash, sorterVersion: SORTER_VERSION, runId: 'run-earlier' })))
    const pictures = fakePictures()
    const lines: string[] = []
    let asked = 0
    const svc: InstanceType<typeof SorterService> = new SorterService({
      wellRoot: () => w,
      pictures: { modelReady: () => true, ensureVectors: async (items) => (++asked === 3 && svc.cancel(), pictures.ensureVectors(items)) },
      broadcast: () => undefined,
      log: (l) => void lines.push(l)
    })
    const saved: SorterRetrain[] = []
    const retrainer = new Retrainer({
      train: () => svc.trainAndTest({ rescore: true }),
      choices: () => svc.choices(),
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => ({ enabled: false }),
      saveSettings: () => undefined,
      lastRetrain: () => saved[saved.length - 1],
      saveLastRetrain: (r) => void saved.push(r),
      defer: () => undefined
    })
    const r = await retrainer.retrain('manual')
    expect(r).toMatchObject({ ok: true, moved: null })
    expect(lines).toEqual(['[sorter] the re-score after training was stopped after 50 proposals; the rest keep their earlier scores'])
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ trigger: 'manual', needALook: null, movedToSure: null, movedHashes: [] })
    expect(saved[0].accuracy.after).not.toBeNull()
    expect(storedRetrain(JSON.parse(JSON.stringify(saved[0])))).toEqual(saved[0])
    // the first fifty were written under the new model and stay; the other ten are as they were
    const after = [...proposalsOf(w).values()]
    expect(after.filter((p) => p.model_id === `model-${r.report!.trainedAt}`)).toHaveLength(50)
    expect(after.filter((p) => p.model_id === null && p.proposal === 'doubtful' && p.p_keep === 0.5)).toHaveLength(10)
    expect(after.some((p) => p.proposal === 'keep')).toBe(true)
  }, 30_000)

  it('logs nothing when it runs to the end', async () => {
    const { svc, lines } = failing(well(), () => undefined)
    expect((await svc.trainAndTest({ rescore: true })).moved!.rescored).toBe(15)
    expect(lines).toEqual([])
  })
})

describe('a re-score and what a cloud model may be asked about', () => {
  const LUNA = { provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1' }
  const HAIKU = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }
  /** What each provider may be asked about, with second opinions on and off: "<provider> <on|off> <hash>". */
  const eligible = (w: string): string[] => {
    const st = new SorterStore(w)
    try {
      return [LUNA, HAIKU]
        .flatMap((me) => [true, false].flatMap((second) => st.cloudPending({ sorterVersion: SORTER_VERSION, ...me, others: [me === LUNA ? HAIKU : LUNA], throwawayAt: 0.95, secondOpinions: second }).map((p) => `${me.provider} ${second ? 'on' : 'off'} ${p.hash}`)))
        .sort()
    } finally {
      st.close()
    }
  }
  /** Every column of every proposal, by hash. */
  const fullRows = (w: string): Map<string, Record<string, unknown>> => {
    const t = openTriage(w)
    try {
      return new Map((t.prepare('SELECT * FROM sorter_proposals').all() as Array<Record<string, unknown>>).map((r) => [String(r.hash), { ...r }]))
    } finally {
      t.close()
    }
  }
  const OLDER = 'sorter-before-this-one'
  const KINDS = ['keep', 'toss', 'plain'] // the picture looks kept, looks thrown away, looks like neither
  const each = (prefix: string, n = 2): FixtureShot[] => KINDS.flatMap((k) => Array.from({ length: n }, (_, i) => ({ hash: `${prefix}-${k}-${i}` })))

  /**
   * Undecided screenshots of every kind a re-score could meet. Only "doubt-…" and "asked-unsure-…" are
   * doubtful, undecided and of the current sorter version: the set a re-score may read and write.
   *   was-kept / was-thrown   the sorter was sure (keep / throwaway), current version. Their pictures
   *                           look like anything, so a re-score would call some of them doubtful
   *   doubt                   doubtful, current version, no cloud answer
   *   old / old-kept          doubtful / keep under an older sorter version
   *   asked-unsure            doubtful; OpenAI answered and was not sure
   *   asked-settled           keep, because OpenAI said so
   *   his                     doubtful, and he threw it away in Triage since
   *   reviewed                doubtful, and he answered it in Review
   */
  function mixed(): string {
    const groups = { wasKept: each('was-kept'), wasThrown: each('was-thrown'), doubt: each('doubt', 3), old: each('old'), oldKept: each('old-kept', 1), askedUnsure: each('asked-unsure'), askedSettled: each('asked-settled', 1), his: each('his', 1), reviewed: each('reviewed', 1) }
    const w = teachWell(70, 30, Object.values(groups).flat())
    wells.push(w)
    const st = new SorterStore(w)
    const cur = (rows: FixtureShot[], more: Partial<ProposalSeed> = {}): ProposalSeed[] => rows.map((s) => ({ hash: s.hash, sorterVersion: SORTER_VERSION, runId: 'run-earlier', ...more }))
    seedProposals(w, [
      ...cur(groups.wasKept, { proposal: 'keep', pKeep: 0.9 }),
      ...cur(groups.wasThrown, { proposal: 'throwaway', pKeep: 0.04 }),
      ...cur(groups.doubt),
      ...cur(groups.old, { sorterVersion: OLDER, runId: 'run-long-ago' }),
      ...cur(groups.oldKept, { sorterVersion: OLDER, runId: 'run-long-ago', proposal: 'keep', pKeep: 0.9 }),
      ...cur(groups.askedUnsure),
      ...cur(groups.askedSettled, { proposal: 'keep', pKeep: 0.93 }),
      ...cur(groups.his),
      ...cur(groups.reviewed, { answeredAt: '2026-10-12T10:00:00.000Z' })
    ])
    const said = (rows: FixtureShot[], verdict: 'keep' | 'unsure'): Parameters<typeof st.saveCloudResults>[0] => rows.map((s) => ({ hash: s.hash, verdict, confidence: verdict === 'keep' ? 0.93 : 0.5, reason: 'x', ...LUNA, askedAt: '2026-10-11T02:00:00.000Z' }))
    st.saveCloudResults([...said(groups.askedUnsure, 'unsure'), ...said(groups.askedSettled, 'keep')], [])
    st.close()
    addShots(w, groups.his.map((s) => ({ hash: s.hash, state: 'excluded' as const })))
    return w
  }
  const mayBeRescored = (hash: string): boolean => hash.startsWith('doubt-') || hash.startsWith('asked-unsure-')

  it('reads and writes only proposals that are doubtful now: one the sorter was sure about keeps every column', async () => {
    const w = mixed()
    const before = fullRows(w)
    expect(doubtfulProposals(w, SORTER_VERSION).map((r) => r.hash).sort()).toEqual([...before.keys()].filter(mayBeRescored).sort())
    const r = await service(w).trainAndTest({ rescore: true })
    expect(r.ok).toBe(true)
    const after = fullRows(w)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [hash, row] of before) if (!mayBeRescored(hash)) expect(after.get(hash), hash).toEqual(row)
    // the counts are over that set alone: 9 without an answer and 6 OpenAI was unsure about
    const stillDoubtful = [...after].filter(([h, p]) => mayBeRescored(h) && p.proposal === 'doubtful').map(([h]) => h)
    expect(r.moved!.rescored).toBe(15)
    expect(r.moved!.needALook).toEqual({ before: 15, after: stillDoubtful.length })
    expect(r.moved!.movedToSure.keep + r.moved!.movedToSure.throwaway).toBe(15 - stillDoubtful.length)
    expect(15 - stillDoubtful.length).toBeGreaterThanOrEqual(4) // the test moves something
    expect([...r.moved!.movedHashes].sort()).toEqual([...after].filter(([h, p]) => mayBeRescored(h) && p.proposal !== 'doubtful').map(([h]) => h).sort())
    // and the fixture bites: the new model would not have been sure about every row it was sure about before
    expect(after.get('was-kept-toss-0')!.proposal).toBe('keep')
    expect(after.get('was-thrown-keep-0')!.proposal).toBe('throwaway')
  }, 30_000)

  it('never adds a screenshot to what a cloud model may be asked about: either provider, second opinions on or off', async () => {
    const w = mixed()
    const before = eligible(w)
    // doubt-*: both providers, on and off. asked-unsure-*: Anthropic only, and only with second opinions on
    expect(before).toHaveLength(9 * 4 + 6)
    const r = await service(w).trainAndTest({ rescore: true })
    const after = eligible(w)
    expect(after.filter((x) => !before.includes(x))).toEqual([])
    // exactly the ones that moved to sure left it
    const moved = new Set(r.moved!.movedHashes)
    expect(moved.size).toBeGreaterThan(0)
    expect(before.filter((x) => !after.includes(x)).map((x) => x.split(' ')[2]).every((h) => moved.has(h))).toBe(true)
    expect(after.filter((x) => moved.has(x.split(' ')[2]))).toEqual([])
    expect(after.every((x) => mayBeRescored(x.split(' ')[2]))).toBe(true)
  }, 30_000)

  it('the same holds when the retrain starts by itself', async () => {
    const w = mixed()
    const before = { eligible: eligible(w), rows: fullRows(w), decisions: countRows(w, 'triage_decisions'), answers: countRows(w, 'sorter_cloud_answers') }
    const svc = service(w)
    const deferred: Array<() => void> = []
    const saved: SorterRetrain[] = []
    const retrainer = new Retrainer({
      train: () => svc.trainAndTest({ rescore: true }),
      choices: () => ({ learnable: { kept: 70, binned: 40 }, trainedWith: 100 }), // ten answers since the model in use
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => ({}),
      saveSettings: () => undefined,
      lastRetrain: () => saved[saved.length - 1],
      saveLastRetrain: (r) => void saved.push(r),
      defer: (fn) => void deferred.push(fn)
    })
    retrainer.noteAnswer()
    for (const fn of deferred.splice(0)) fn()
    expect(retrainer.status({ learnable: { kept: 70, binned: 40 }, trainedWith: 100 }).retraining).toBe('auto')
    await retrainer.retrain('round') // joins the one running by itself
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ trigger: 'auto', needALook: { before: 15 } })
    expect(eligible(w).filter((x) => !before.eligible.includes(x))).toEqual([])
    const after = fullRows(w)
    for (const [hash, row] of before.rows) if (!mayBeRescored(hash)) expect(after.get(hash), hash).toEqual(row)
    expect(countRows(w, 'triage_decisions')).toBe(before.decisions)
    expect(countRows(w, 'sorter_cloud_answers')).toBe(before.answers)
    expect(countRows(w, 'sorter_runs')).toBe(0)
  }, 30_000)

  it('writeRescored does not touch a row from another sorter version or one that is not doubtful', () => {
    const w = mixed()
    const before = fullRows(w)
    const at = '2026-10-10T08:00:00.000Z'
    const hashes = ['old-plain-0', 'was-kept-plain-0', 'was-thrown-plain-0', 'asked-settled-plain-0', 'his-plain-0', 'reviewed-plain-0', 'doubt-plain-0']
    const written = writeRescored(w, hashes.map((hash) => ({ hash, proposal: 'doubtful' as const, confidence: 0.69, pKeep: 0.69, reason: 'Not sure', rule: null, decidedBy: null, proposedAt: at })), SORTER_VERSION, 'model-x')
    expect(written).toEqual(['doubt-plain-0'])
    const after = fullRows(w)
    for (const [hash, row] of before) if (hash !== 'doubt-plain-0') expect(after.get(hash), hash).toEqual(row)
    expect(doubtfulProposals(w, SORTER_VERSION).some((r) => !mayBeRescored(r.hash))).toBe(false)
    expect(doubtfulProposals(w, OLDER)).toHaveLength(6)
  })
})

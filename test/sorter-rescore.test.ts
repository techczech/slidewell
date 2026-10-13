import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { addShots, countRows, fakePictures, openTriage, proposalsOf, seedProposals, teachWell, type FixtureShot } from './sorter-teach-fixture'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { SorterService } = await import('../src/main/sorter/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { undecidedProposals, writeRescored } = await import('../src/main/sorter/rescore')

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
    const read = undecidedProposals(w, SORTER_VERSION)
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
    // a throwaway that stays throwaway keeps the clock it had
    writeRescored(w, [row('new-toss-0', 'throwaway', '2026-10-10T08:00:00.000Z')], SORTER_VERSION, 'model-y', new Date('2026-10-20T10:00:00.000Z'))
    expect(proposalsOf(w).get('new-toss-0')).toMatchObject({ model_id: 'model-y', throwaway_since: '2026-10-13T10:00:00.000Z' })
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

  it('logs nothing when it runs to the end', async () => {
    const { svc, lines } = failing(well(), () => undefined)
    expect((await svc.trainAndTest({ rescore: true })).moved!.rescored).toBe(15)
    expect(lines).toEqual([])
  })
})

describe('a re-score and what a cloud model may be asked about', () => {
  const LUNA = { provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1' }
  const HAIKU = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }
  const eligible = (w: string): string[] => {
    const st = new SorterStore(w)
    try {
      return [LUNA, HAIKU].flatMap((me) => st.cloudPending({ sorterVersion: SORTER_VERSION, ...me, others: [me === LUNA ? HAIKU : LUNA], throwawayAt: 0.95 }).map((p) => `${me.provider} ${p.hash}`)).sort()
    } finally {
      st.close()
    }
  }
  const OLDER = 'sorter-before-this-one'

  /** Undecided screenshots proposed under the current sorter and under an older one, in every label. */
  function mixed(): string {
    const names = ['keep', 'toss', 'plain']
    const current: FixtureShot[] = names.flatMap((n) => Array.from({ length: 4 }, (_, i) => ({ hash: `now-${n}-${i}` })))
    const old: FixtureShot[] = names.flatMap((n) => Array.from({ length: 3 }, (_, i) => ({ hash: `old-${n}-${i}` })))
    const w = teachWell(70, 30, [...current, ...old])
    wells.push(w)
    new SorterStore(w).close()
    seedProposals(w, current.map((s) => ({ hash: s.hash, sorterVersion: SORTER_VERSION, runId: 'run-earlier' })))
    seedProposals(w, [
      ...old.map((s) => ({ hash: s.hash, sorterVersion: OLDER, runId: 'run-long-ago' })),
      { hash: 'old-keep-2', proposal: 'keep' as const, pKeep: 0.9, sorterVersion: OLDER, runId: 'run-long-ago' },
      { hash: 'old-toss-2', proposal: 'throwaway' as const, pKeep: 0.05, sorterVersion: OLDER, runId: 'run-long-ago' }
    ])
    return w
  }

  it('leaves a proposal from an older sorter version exactly as it is and does not count it', async () => {
    const w = mixed()
    const before = proposalsOf(w)
    const r = await service(w).trainAndTest({ rescore: true })
    expect(r.ok).toBe(true)
    const after = proposalsOf(w)
    for (const [h, p] of before) if (h.startsWith('old-')) expect(after.get(h), h).toEqual(p)
    expect(r.moved!.rescored).toBe(12)
    expect(r.moved!.needALook.before).toBe(12) // the seven doubtful old ones are not in it
    const sure = [...after].filter(([h, p]) => h.startsWith('now-') && p.proposal !== 'doubtful').map(([h]) => h)
    expect(sure.length).toBeGreaterThanOrEqual(4)
    expect(r.moved!.needALook.after).toBe(12 - sure.length)
    expect(r.moved!.movedToSure.keep + r.moved!.movedToSure.throwaway).toBe(sure.length)
    expect([...r.moved!.movedHashes].sort()).toEqual(sure.sort())
  })

  it('never adds a screenshot to what a cloud model may be asked about', async () => {
    const w = mixed()
    const before = eligible(w)
    expect(before).toHaveLength(24) // the twelve current doubtful ones, for either provider; none of the old
    const r = await service(w).trainAndTest({ rescore: true })
    const after = eligible(w)
    expect(after.filter((x) => !before.includes(x))).toEqual([])
    // exactly the ones that moved to sure left it
    const moved = new Set(r.moved!.movedHashes)
    expect(before.filter((x) => !after.includes(x)).map((x) => x.split(' ')[1]).every((h) => moved.has(h))).toBe(true)
    expect(after).toHaveLength(24 - 2 * moved.size)
    expect(after.some((x) => x.includes('old-'))).toBe(false)
  })

  it('writeRescored does not touch a row from another sorter version', () => {
    const w = mixed()
    const before = proposalsOf(w)
    const at = '2026-10-10T08:00:00.000Z'
    const written = writeRescored(w, ['old-plain-0', 'now-plain-0'].map((hash) => ({ hash, proposal: 'doubtful' as const, confidence: 0.69, pKeep: 0.69, reason: 'Not sure', rule: null, decidedBy: null, proposedAt: at })), SORTER_VERSION, 'model-x')
    expect(written).toEqual(['now-plain-0'])
    expect(proposalsOf(w).get('old-plain-0')).toEqual(before.get('old-plain-0'))
    expect(undecidedProposals(w, SORTER_VERSION).some((r) => r.hash.startsWith('old-'))).toBe(false)
    expect(undecidedProposals(w, OLDER)).toHaveLength(9)
  })
})

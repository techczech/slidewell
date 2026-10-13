import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { addShots, countRows, fakePictures, openTriage, proposalsOf, seedProposals, teachWell } from './sorter-teach-fixture'
import type { SorterStatus } from '../src/preload'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { SorterService } = await import('../src/main/sorter/service')
const { SorterStore, loadLabelled } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { Retrainer } = await import('../src/main/sorter/retrain')
type Train = Awaited<ReturnType<InstanceType<typeof SorterService>['trainAndTest']>>

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})

/** The sorter and the retrainer wired as index.ts wires them, over a scratch well and a pretend config. */
function app(o: { battery?: boolean } = {}) {
  const w = teachWell(70, 30, Array.from({ length: 8 }, (_, i) => ({ hash: `new-${i % 2 ? 'keep' : 'plain'}-${i}` })))
  wells.push(w)
  new SorterStore(w).close()
  seedProposals(w, Array.from({ length: 8 }, (_, i) => ({ hash: `new-${i % 2 ? 'keep' : 'plain'}-${i}`, sorterVersion: SORTER_VERSION, runId: 'run-earlier' })))
  const config: Record<string, unknown> = {}
  const pushed: SorterStatus[] = []
  const deferred: Array<() => void> = []
  const ac: Array<() => void> = []
  const power = { battery: o.battery ?? false }
  const sorter: InstanceType<typeof SorterService> = new SorterService({
    wellRoot: () => w,
    pictures: fakePictures(),
    broadcast: (st) => {
      pushed.push(st as SorterStatus)
      retrainer.sorterStatus(st.phase)
    },
    appRules: () => config.sorterAppRules,
    teach: (c) => retrainer.status(c)
  })
  const retrainer: InstanceType<typeof Retrainer<Train>> = new Retrainer<Train>({
    train: () => sorter.trainAndTest({ rescore: true }),
    choices: () => sorter.choices(),
    changed: () => sorter.push(),
    power: { onBattery: () => power.battery, onAc: (cb) => void ac.push(cb) },
    settings: () => ({ enabled: config.sorterAutoRetrain, onBattery: config.sorterAutoRetrainOnBattery }),
    saveSettings: (s) => Object.assign(config, { sorterAutoRetrain: s.enabled, sorterAutoRetrainOnBattery: s.onBattery }),
    lastRetrain: () => config.sorterLastRetrain,
    saveLastRetrain: (r) => void (config.sorterLastRetrain = JSON.parse(JSON.stringify(r))),
    defer: (fn) => void deferred.push(fn)
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && (deferred.length || sorter.status().retraining || i < 3); i++) {
      for (const fn of deferred.splice(0)) fn()
      await new Promise((res) => setTimeout(res, 5))
    }
  }
  const answer = (n: number, from = 0): void => {
    addShots(w, Array.from({ length: n }, (_, i) => ({ hash: `answer-keep-${from + i}`, state: 'included' as const })))
    retrainer.noteAnswer()
  }
  return { w, config, pushed, sorter, retrainer, settle, answer, power, ac }
}

describe('teaching, end to end in main', () => {
  it('Train records the retrain; the tenth answer after it retrains by itself and says what moved', async () => {
    const a = app()
    expect(a.sorter.status({ count: true })).toMatchObject({ answersSinceTraining: 0, retrainEvery: 10, autoRetrain: true, autoRetrainOnBattery: false, retraining: null, waitingForPower: null, choicesNeeded: 0, lastRetrain: null })
    const first = await a.retrainer.retrain('manual')
    expect(first.ok).toBe(true)
    await a.settle()
    expect(a.sorter.status().lastRetrain).toMatchObject({ trigger: 'manual', choices: { before: 0, after: 100 }, accuracy: { before: null } })
    expect(a.pushed.some((s) => s.retraining === 'manual' && s.phase === 'training')).toBe(true)

    a.answer(9)
    await a.settle()
    expect(a.sorter.status()).toMatchObject({ answersSinceTraining: 9, retraining: null })
    expect(a.sorter.status().lastRetrain!.trigger).toBe('manual')

    a.pushed.length = 0
    a.answer(1, 9)
    await a.settle()
    const st = a.sorter.status()
    expect(st).toMatchObject({ answersSinceTraining: 0, retraining: null, phase: 'idle' })
    expect(st.lastRetrain).toMatchObject({ trigger: 'auto', choices: { before: 100, after: 110 } })
    expect(st.lastRetrain!.accuracy.before).not.toBeNull()
    expect(st.lastRetrain!.needALook).not.toBeNull()
    expect(a.pushed.some((s) => s.retraining === 'auto')).toBe(true)
    expect(a.pushed[a.pushed.length - 1]).toMatchObject({ retraining: null, answersSinceTraining: 0 })
    expect(st.report!.choicesAtTraining).toBe(110)
  }, 30_000)

  it('a retrain by itself decides nothing and sorts nothing: no decision, no run, no new proposal', async () => {
    const a = app()
    await a.retrainer.retrain('manual')
    a.answer(10)
    const decisions = countRows(a.w, 'triage_decisions')
    await a.settle()
    expect(a.sorter.status().lastRetrain!.trigger).toBe('auto')
    expect(countRows(a.w, 'triage_decisions')).toBe(decisions)
    expect(countRows(a.w, 'sorter_runs')).toBe(0)
    expect(countRows(a.w, 'sorter_cloud_answers')).toBe(0)
    const after = proposalsOf(a.w)
    expect(after.size).toBe(8)
    for (const p of after.values()) expect(p.run_id).toBe('run-earlier')
  }, 30_000)

  it('a rule change stops unattended sorting until a training; the retrain by itself is that training', async () => {
    const a = app()
    await a.retrainer.retrain('manual')
    expect(a.sorter.status()).toMatchObject({ canRunUnattended: true, rulesChangedSinceTest: false })
    a.config.sorterAppRules = [{ app: 'Brightloom', rule: 'throwaway' }]
    expect(a.sorter.status()).toMatchObject({ canRunUnattended: false, rulesChangedSinceTest: true })
    expect((await a.sorter.sortUndecided({ trigger: 'nightly' })).ok).toBe(false)
    a.answer(10)
    await a.settle()
    expect(a.sorter.status()).toMatchObject({ canRunUnattended: true, rulesChangedSinceTest: false })
    expect(a.sorter.status().lastRetrain!.trigger).toBe('auto')
  }, 30_000)

  it('on battery it waits with the count in the status, and starts when power returns', async () => {
    const a = app({ battery: true })
    await a.retrainer.retrain('manual')
    a.answer(11)
    await a.settle()
    expect(a.sorter.status()).toMatchObject({ waitingForPower: { answers: 11 }, answersSinceTraining: 11, retraining: null })
    expect(a.sorter.status().lastRetrain!.trigger).toBe('manual')
    a.power.battery = false
    for (const cb of a.ac) cb()
    await a.settle()
    expect(a.sorter.status()).toMatchObject({ waitingForPower: null, answersSinceTraining: 0 })
    expect(a.sorter.status().lastRetrain!.trigger).toBe('auto')
  }, 30_000)

  it('while a sort is running the retrain waits for it', async () => {
    const a = app()
    await a.retrainer.retrain('manual')
    a.answer(10)
    const sort = a.sorter.sortUndecided() // busy from here
    await a.settle()
    expect((await sort).ok).toBe(true)
    await a.settle()
    expect(a.sorter.status().lastRetrain).toMatchObject({ trigger: 'auto', choices: { before: 100, after: 110 } })
    expect(countRows(a.w, 'sorter_runs')).toBe(1) // the sort he started; the retrain added none
  }, 30_000)
})

describe('his choices, read without joining the index in SQL', () => {
  it('each decision gets its picture: the readable file row wins, a decision with no row has no picture', () => {
    const w = teachWell(3, 3, [{ hash: 'staged', state: 'selected' }, { hash: 'undecided' }])
    wells.push(w)
    const src = join(w, 'source')
    const t = openTriage(w)
    const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, ?, ?, ?, 'png', ?, '', ?, '2026-10-02T10:00:00', 'Quillpad', '')")
    row.run('keep0', 'image', 'keep1.png', 'second-copy.png', '0', src) // a second file with the same content
    row.run('toss1', 'image', 'toss1.png', 'online-only.png', '1', src) // not on this Mac: not a row that counts
    row.run('toss2', 'video', 'clip.mov', 'clip.mov', '0', src)
    t.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES ('no-row', 'excluded', '2026-10-01', NULL)").run()
    t.close()
    unlinkSync(join(src, 'keep0.png')) // the first file row of keep0 is gone; the second is readable
    unlinkSync(join(src, 'toss0.png'))
    const shots = new Map(loadLabelled(w).map((s) => [s.hash, s]))
    expect([...shots.keys()].sort()).toEqual(['keep0', 'keep1', 'keep2', 'no-row', 'toss0', 'toss1', 'toss2'])
    expect(shots.get('keep0')).toMatchObject({ truth: 'keep', image: { path: join(src, 'keep1.png') }, facts: { filename: 'second-copy.png', app: 'Quillpad' } })
    expect(shots.get('toss0')).toMatchObject({ truth: 'throwaway', image: null, facts: { filename: 'toss0.png' } })
    expect(shots.get('toss1')).toMatchObject({ image: { path: join(src, 'toss1.png') }, facts: { filename: 'toss1.png' } })
    expect(shots.get('no-row')).toMatchObject({ truth: 'throwaway', image: null, facts: { filename: '', app: '' }, takenAt: '' })
  })
})

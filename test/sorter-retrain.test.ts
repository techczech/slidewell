import { describe, it, expect } from 'vitest'
import { Retrainer, retrainRecord, storedAutoRetrain, storedRetrain, type RetrainDeps, type RetrainOutcome } from '../src/main/sorter/retrain'
import { accuracyReport, type LabelledPrediction } from '../src/main/sorter/accuracy'
import type { SorterRetrain } from '../src/preload'

const held = (throwawayRight: number, of: number): ReturnType<typeof accuracyReport> => {
  const rows: LabelledPrediction[] = []
  for (let i = 0; i < of; i++) rows.push({ truth: i < throwawayRight ? 'throwaway' : 'keep', proposal: 'throwaway' })
  for (let i = 0; i < 30; i++) rows.push({ truth: 'keep', proposal: 'keep' })
  return accuracyReport(rows)
}
const report = (choices: number, right = 9): NonNullable<RetrainOutcome['report']> => ({ heldBack: held(right, 10), choicesAtTraining: choices })

/** A retrainer over a pretend sorter: `kept`/`thrown` are his choices now, `trainedWith` those of the model in use. */
function rig(o: { kept?: number; thrown?: number; trainedWith?: number | null; battery?: boolean; settings?: { enabled?: unknown; onBattery?: unknown } } = {}) {
  const w = {
    kept: o.kept ?? 228,
    thrown: o.thrown ?? 84,
    trainedWith: o.trainedWith === undefined ? 312 : o.trainedWith,
    battery: o.battery ?? false,
    settings: o.settings ?? {},
    trains: 0,
    pushes: 0,
    saved: [] as SorterRetrain[],
    deferred: [] as Array<() => void>,
    ac: [] as Array<() => void>,
    /** What the next training answers; default: ok, trained with all his choices now. */
    next: null as null | (() => Promise<RetrainOutcome> | RetrainOutcome)
  }
  const deps: RetrainDeps = {
    train: async () => {
      w.trains++
      if (w.next) return w.next()
      const before = w.trainedWith === null ? null : report(w.trainedWith)
      w.trainedWith = w.kept + w.thrown
      return { ok: true, report: report(w.trainedWith), before, moved: { rescored: 30, needALook: { before: 41, after: 18 }, movedToSure: { keep: 19, throwaway: 4 }, movedHashes: ['aa', 'bb'] } }
    },
    choices: () => ({ learnable: { kept: w.kept, binned: w.thrown }, trainedWith: w.trainedWith }),
    changed: () => void w.pushes++,
    power: { onBattery: () => w.battery, onAc: (cb) => void w.ac.push(cb) },
    settings: () => w.settings,
    saveSettings: (s) => void (w.settings = s),
    lastRetrain: () => w.saved[w.saved.length - 1],
    saveLastRetrain: (r) => void w.saved.push(r),
    defer: (fn) => void w.deferred.push(fn),
    now: () => new Date('2026-10-13T10:00:00.000Z')
  }
  const r = new Retrainer(deps)
  /** Run what was deferred (the count after an answer), then let a started retrain finish. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      for (const fn of w.deferred.splice(0)) fn()
      await new Promise((res) => setTimeout(res, 0))
    }
  }
  const answer = (n: number): void => {
    w.kept += n
    r.noteAnswer()
  }
  const status = (): ReturnType<Retrainer['status']> => r.status(deps.choices())
  return { w, r, settle, answer, status }
}

describe('retrain by itself: when it starts', () => {
  it('starts after the tenth answer, not the ninth, and records what moved', async () => {
    const t = rig()
    t.answer(9)
    await t.settle()
    expect(t.w.trains).toBe(0)
    expect(t.status()).toMatchObject({ answersSinceTraining: 9, retrainEvery: 10, autoRetrain: true, autoRetrainOnBattery: false, retraining: null, waitingForPower: null, choicesNeeded: 0, lastRetrain: null })
    t.answer(1)
    await t.settle()
    expect(t.w.trains).toBe(1)
    expect(t.status()).toMatchObject({ answersSinceTraining: 0, retraining: null })
    expect(t.status().lastRetrain).toEqual({
      at: '2026-10-13T10:00:00.000Z',
      trigger: 'auto',
      choices: { before: 312, after: 322 },
      needALook: { before: 41, after: 18 },
      movedToSure: { keep: 19, throwaway: 4 },
      accuracy: { before: { throwawayRight: 0.9, keepRight: 1 }, after: { throwawayRight: 0.9, keepRight: 1 } },
      movedHashes: ['aa', 'bb']
    })
  })

  it('counts several answers in a row once, and pushes the status when the count changes', async () => {
    const t = rig()
    t.answer(1)
    t.answer(1)
    t.answer(1)
    expect(t.w.deferred).toHaveLength(1)
    await t.settle()
    expect(t.w.pushes).toBe(1)
    expect(t.w.trains).toBe(0)
  })

  it('switched off: never starts, whatever the count', async () => {
    const t = rig({ settings: { enabled: false } })
    t.answer(40)
    await t.settle()
    expect(t.w.trains).toBe(0)
    expect(t.status()).toMatchObject({ autoRetrain: false, answersSinceTraining: 40, waitingForPower: null })
  })

  it('on battery: waits and says so with the count; starts when power returns', async () => {
    const t = rig({ battery: true })
    t.answer(12)
    await t.settle()
    expect(t.w.trains).toBe(0)
    expect(t.status().waitingForPower).toEqual({ answers: 12 })
    t.w.battery = false
    for (const cb of t.w.ac) cb() // powerMonitor 'on-ac'
    await t.settle()
    expect(t.w.trains).toBe(1)
    expect(t.status().waitingForPower).toBeNull()
  })

  it('on battery with battery allowed: starts', async () => {
    const t = rig({ battery: true, settings: { enabled: true, onBattery: true } })
    t.answer(10)
    await t.settle()
    expect(t.w.trains).toBe(1)
  })

  it('on battery: Retrain now runs it, and allowing battery starts the one that was waiting', async () => {
    const a = rig({ battery: true })
    a.answer(10)
    await a.settle()
    expect((await a.r.retrain('manual')).ok).toBe(true)
    expect(a.status().lastRetrain?.trigger).toBe('manual')
    expect(a.status().waitingForPower).toBeNull()

    const b = rig({ battery: true })
    b.answer(10)
    await b.settle()
    expect(b.r.setAuto({ onBattery: true })).toEqual({ ok: true, autoRetrain: true, autoRetrainOnBattery: true })
    await b.settle()
    expect(b.w.trains).toBe(1)
    expect(b.status().lastRetrain?.trigger).toBe('auto')
  })

  it('fewer choices than a training can be measured with: no retrain, and the status says how many more', async () => {
    const t = rig({ kept: 50, thrown: 20, trainedWith: 60 })
    t.answer(0)
    await t.settle()
    expect(t.status()).toMatchObject({ answersSinceTraining: 10, choicesNeeded: 26, waitingForPower: null })
    expect(t.w.trains).toBe(0)
  })

  it('no current model: nothing counts as an answer and nothing starts', async () => {
    const t = rig({ trainedWith: null })
    t.answer(30)
    await t.settle()
    expect(t.w.trains).toBe(0)
    expect(t.status().answersSinceTraining).toBe(0)
  })
})

describe('retrain: one at a time', () => {
  it('a request while one runs joins it; answers given meanwhile are counted when it ends', async () => {
    const t = rig()
    let finish: (r: RetrainOutcome) => void = () => undefined
    t.w.next = () => new Promise<RetrainOutcome>((res) => (finish = res))
    t.answer(10)
    await t.settle()
    expect(t.w.trains).toBe(1)
    expect(t.status().retraining).toBe('auto')
    const round = t.r.retrain('round') // the round ended while the retrain by itself was running
    const manual = t.r.retrain('manual')
    t.answer(3)
    await t.settle()
    expect(t.w.trains).toBe(1)
    t.w.next = null
    t.w.trainedWith = 322
    finish({ ok: true, report: report(322), before: report(312), moved: null })
    expect(await round).toBe(await manual)
    await t.settle()
    expect(t.w.trains).toBe(1) // three answers since: not due
    expect(t.status()).toMatchObject({ retraining: null, answersSinceTraining: 3 })
    expect(t.status().lastRetrain).toMatchObject({ trigger: 'auto', needALook: null, movedToSure: null, movedHashes: [] })
  })

  it('ten more answers during a retrain start the next one when it ends', async () => {
    const t = rig()
    let finish: (r: RetrainOutcome) => void = () => undefined
    t.w.next = () => new Promise<RetrainOutcome>((res) => (finish = res))
    t.answer(10)
    await t.settle()
    t.answer(10)
    await t.settle()
    t.w.next = null
    t.w.trainedWith = 322
    finish({ ok: true, report: report(322), before: report(312), moved: null })
    await t.settle()
    expect(t.w.trains).toBe(2)
    expect(t.status().answersSinceTraining).toBe(0)
  })

  it('the sorter is busy sorting: waits, and starts when the sorter is idle again', async () => {
    const t = rig()
    t.w.next = () => ({ ok: false, error: 'the sorter is already running', busy: true })
    t.answer(10)
    await t.settle()
    expect(t.w.trains).toBe(1)
    t.r.sorterStatus('sorting')
    await t.settle()
    expect(t.w.trains).toBe(1)
    t.w.next = null
    t.r.sorterStatus('idle')
    await t.settle()
    expect(t.w.trains).toBe(2)
    expect(t.w.saved).toHaveLength(1)
    t.r.sorterStatus('idle') // nothing is waiting any more
    await t.settle()
    expect(t.w.trains).toBe(2)
  })

  it('a retrain by itself that fails is not repeated until he answers again', async () => {
    const t = rig()
    t.w.next = () => ({ ok: false, error: 'download the picture search model first (Settings › Picture search)' })
    t.answer(10)
    await t.settle()
    expect(t.w.trains).toBe(1)
    t.r.noteAnswer() // same number of choices
    await t.settle()
    expect(t.w.trains).toBe(1)
    expect(t.w.saved).toHaveLength(0)
    t.answer(1)
    await t.settle()
    expect(t.w.trains).toBe(2)
  })

  it('Train with the sorter busy answers with the refusal and records nothing', async () => {
    const t = rig()
    t.w.next = () => ({ ok: false, error: 'the sorter is already running', busy: true })
    expect(await t.r.retrain('manual')).toMatchObject({ ok: false, error: 'the sorter is already running' })
    expect(t.w.saved).toHaveLength(0)
    expect(t.status().retraining).toBeNull()
  })
})

describe('retrain: the switches and the stored record', () => {
  it('defaults: by itself on, on battery off; only a stored false / true changes them', () => {
    expect(storedAutoRetrain(undefined)).toEqual({ enabled: true, onBattery: false })
    expect(storedAutoRetrain({ enabled: 'no', onBattery: 1 })).toEqual({ enabled: true, onBattery: false })
    expect(storedAutoRetrain({ enabled: false, onBattery: true })).toEqual({ enabled: false, onBattery: true })
  })

  it('setAuto stores a boolean for either switch and refuses anything else', () => {
    const t = rig()
    expect(t.r.setAuto({ enabled: false })).toEqual({ ok: true, autoRetrain: false, autoRetrainOnBattery: false })
    expect(t.w.settings).toEqual({ enabled: false, onBattery: false })
    for (const bad of [null, 'on', [], {}, { enabled: 'yes' }, { onBattery: 1 }, { enabled: true, every: 5 }]) {
      expect(t.r.setAuto(bad), JSON.stringify(bad)).toMatchObject({ ok: false, autoRetrain: false, autoRetrainOnBattery: false, error: 'That is not a setting the sorter knows.' })
    }
    expect(t.w.settings).toEqual({ enabled: false, onBattery: false })
  })

  it('the first training has nothing before it', () => {
    const r = retrainRecord(new Date('2026-10-13T10:00:00.000Z'), 'manual', null, report(120, 8), null)
    expect(r).toMatchObject({ trigger: 'manual', choices: { before: 0, after: 120 }, accuracy: { before: null, after: { throwawayRight: 0.8, keepRight: 1 } }, needALook: null, movedToSure: null })
  })

  it('reads back only a whole record', () => {
    const good = retrainRecord(new Date('2026-10-13T10:00:00.000Z'), 'round', report(312), report(322, 10), { rescored: 5, needALook: { before: 41, after: 18 }, movedToSure: { keep: 19, throwaway: 4 }, movedHashes: ['aa'] })
    expect(storedRetrain(JSON.parse(JSON.stringify(good)))).toEqual(good)
    expect(storedRetrain(JSON.parse(JSON.stringify(retrainRecord(new Date(0), 'auto', null, report(100), null))))).not.toBeNull()
    for (const bad of [null, 'x', {}, { ...good, trigger: 'nightly' }, { ...good, at: 'soon' }, { ...good, choices: { before: -1, after: 2 } }, { ...good, needALook: null }, { ...good, accuracy: { before: null } }, { ...good, movedHashes: Array(201).fill('a') }]) {
      expect(storedRetrain(bad), JSON.stringify(bad).slice(0, 60)).toBeNull()
    }
  })
})

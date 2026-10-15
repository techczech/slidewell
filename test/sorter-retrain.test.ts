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
    next: null as null | (() => Promise<RetrainOutcome> | RetrainOutcome),
    /** Called on every status push (index.ts hands each pushed status to sorterStatus). */
    onPush: null as null | (() => void)
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
    changed: () => {
      w.pushes++
      w.onPush?.()
    },
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
    // the round's request got the result of the retrain that was running by itself, not a refusal
    expect(await round).toMatchObject({ ok: true, report: { choicesAtTraining: 322 } })
    expect((await round).busy).toBeUndefined()
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

  it('`at` is an ISO-8601 string from the system clock, the one the renderer\'s new Date().toISOString() reads', async () => {
    const saved: SorterRetrain[] = []
    const r = new Retrainer({
      train: async () => ({ ok: true, report: report(312), before: null, moved: null }),
      choices: () => ({ learnable: { kept: 228, binned: 84 }, trainedWith: 312 }),
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => ({ enabled: false }),
      saveSettings: () => undefined,
      lastRetrain: () => saved[saved.length - 1],
      saveLastRetrain: (x) => void saved.push(x),
      defer: () => undefined
      // no `now`: the clock the app runs with
    })
    const from = Date.now()
    await r.retrain('round')
    const to = Date.now()
    expect(saved).toHaveLength(1)
    const at = saved[0].at
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(at).toISOString()).toBe(at)
    expect(Date.parse(at)).toBeGreaterThanOrEqual(from)
    expect(Date.parse(at)).toBeLessThanOrEqual(to)
    expect(storedRetrain(saved[0])!.at).toBe(at)
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

  it('reads a stored record strictly: numbers in range, a real date, hashes shaped like hashes', () => {
    const good = retrainRecord(new Date('2026-10-13T10:00:00.000Z'), 'round', report(312), report(322, 10), { rescored: 5, needALook: { before: 41, after: 18 }, movedToSure: { keep: 19, throwaway: 4 }, movedHashes: ['aa', 'p:0123abc'] })
    const bads: unknown[] = [
      { ...good, choices: { before: 312, after: Infinity } },
      { ...good, choices: { before: 312, after: 322.5 } },
      { ...good, needALook: { before: Number.NaN, after: 18 } },
      { ...good, movedToSure: { keep: -1, throwaway: 4 } },
      { ...good, movedToSure: { keep: '19', throwaway: 4 } },
      { ...good, accuracy: { before: good.accuracy.before, after: { throwawayRight: 1.2, keepRight: 1 } } },
      { ...good, accuracy: { before: { throwawayRight: Infinity, keepRight: 1 }, after: good.accuracy.after } },
      { ...good, accuracy: { before: good.accuracy.before, after: { throwawayRight: Number.NaN, keepRight: 1 } } },
      { ...good, at: 'not a date' },
      { ...good, at: `2026-10-13T10:00:00.000Z${' '.repeat(60)}` },
      { ...good, at: 1760349600000 },
      { ...good, movedHashes: ['aa', 'has a space'] },
      { ...good, movedHashes: ['a'.repeat(65)] },
      { ...good, movedHashes: ['aa', 7] },
      { ...good, movedHashes: 'aa' },
      [good]
    ]
    for (const bad of bads) expect(storedRetrain(bad), JSON.stringify(bad).slice(0, 80)).toBeNull()
    // 1e400 in stored JSON reads as Infinity
    expect(storedRetrain(JSON.parse(JSON.stringify(good).replace('"after":322', '"after":1e400')))).toBeNull()
    expect(storedRetrain({ ...good, movedHashes: Array.from({ length: 200 }, (_, i) => `h${i}`) })?.movedHashes).toHaveLength(200)
  })

  it('copies out only the fields a record has: anything stored beside them is dropped', () => {
    const good = retrainRecord(new Date('2026-10-13T10:00:00.000Z'), 'auto', report(312), report(322, 10), { rescored: 5, needALook: { before: 41, after: 18 }, movedToSure: { keep: 19, throwaway: 4 }, movedHashes: ['aa'] })
    const big = 'x'.repeat(1_000_000)
    const stored = { ...good, extra: big, choices: { ...good.choices, extra: big }, needALook: { ...good.needALook, extra: big }, accuracy: { before: { ...good.accuracy.before, extra: big }, after: { ...good.accuracy.after, extra: big }, extra: big } }
    const read = storedRetrain(stored)
    expect(read).toEqual(good)
    expect(JSON.stringify(read).length).toBeLessThan(600)
    expect(read).not.toBe(stored)
    expect(read!.movedHashes).not.toBe(stored.movedHashes)
  })

  it('logs one line when the record cannot be saved; the training stands', async () => {
    const lines: string[] = []
    const r = new Retrainer({
      train: async () => ({ ok: true, report: report(100), before: null, moved: null }),
      choices: () => ({ learnable: { kept: 60, binned: 40 }, trainedWith: 100 }),
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => ({}),
      saveSettings: () => undefined,
      lastRetrain: () => null,
      saveLastRetrain: () => {
        throw new Error('disk full at /Volumes/example/private')
      },
      log: (l) => void lines.push(l),
      defer: () => undefined
    })
    expect((await r.retrain('manual')).ok).toBe(true)
    expect(lines).toEqual(['[sorter] the last retrain could not be saved: Error'])
  })
})

describe('retrainAfterChange: a training that starts after the change always runs', () => {
  it('none running: one training, as retrain()', async () => {
    const t = rig()
    expect((await t.r.retrainAfterChange('manual')).ok).toBe(true)
    expect(t.w.trains).toBe(1)
  })

  it('one running: not joined; one more starts when it ends, however many ask meanwhile', async () => {
    const t = rig({ settings: { enabled: false } })
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    t.w.next = async () => {
      if (t.w.trains === 1) await gate
      return { ok: true }
    }
    const first = t.r.retrain('auto')
    await new Promise((res) => setTimeout(res, 0))
    expect(t.w.trains).toBe(1)
    const a = t.r.retrainAfterChange('manual')
    const b = t.r.retrainAfterChange('manual')
    expect(a).toBe(b)
    expect(t.r.retrain('manual')).toBe(first) // a plain request still joins the running one
    release()
    await first
    await a
    await t.settle()
    expect(t.w.trains).toBe(2)
    expect(t.status().retraining).toBeNull()
  })
})

describe('retrainAfterChange: a busy sorter never loses the owed training', () => {
  const BUSY = { ok: false, error: 'the sorter is already running', busy: true } as const

  it('the sorter says idle while the attempt is being refused: tried again at once, not left waiting', async () => {
    const t = rig({ settings: { enabled: false } })
    let refuse!: () => void
    const gate = new Promise<void>((res) => (refuse = res))
    t.w.next = async () => {
      if (t.w.trains === 1) {
        await gate
        return BUSY
      }
      return { ok: true }
    }
    const owed = t.r.retrainAfterChange('manual')
    await new Promise((res) => setTimeout(res, 0))
    expect(t.w.trains).toBe(1) // the attempt is in flight
    t.r.sorterStatus('idle') // the sort ends before the refusal comes back
    refuse()
    expect((await owed).ok).toBe(true)
    expect(t.w.trains).toBe(2)
  })

  it('the status push as the refusal ends says idle: started from that push', async () => {
    const t = rig({ settings: { enabled: false } })
    let sorterIdle = false
    t.w.next = async () => {
      if (t.w.trains === 1) {
        sorterIdle = true // the sort ended while the attempt was being refused
        return BUSY
      }
      return { ok: true }
    }
    t.w.onPush = () => t.r.sorterStatus(sorterIdle ? 'idle' : 'sorting') // as index.ts
    expect((await t.r.retrainAfterChange('manual')).ok).toBe(true)
    expect(t.w.trains).toBe(2)
  })

  it('refused with no idle meanwhile: waits, and starts on the next idle', async () => {
    const t = rig({ settings: { enabled: false } })
    t.w.next = () => (t.w.trains === 1 ? BUSY : { ok: true })
    const owed = t.r.retrainAfterChange('manual')
    let settled = false
    void owed.then(() => (settled = true))
    await t.settle()
    expect(t.w.trains).toBe(1)
    expect(settled).toBe(false)
    t.r.sorterStatus('sorting')
    await t.settle()
    expect(t.w.trains).toBe(1)
    t.r.sorterStatus('idle')
    expect((await owed).ok).toBe(true)
    expect(t.w.trains).toBe(2)
  })

  it('a change while the owed attempt trains is owed one more training after it', async () => {
    const t = rig({ settings: { enabled: false } })
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    t.w.next = async () => {
      if (t.w.trains === 1) await gate
      return { ok: true }
    }
    const first = t.r.retrainAfterChange('manual')
    await new Promise((res) => setTimeout(res, 0))
    const second = t.r.retrainAfterChange('manual')
    expect(second).not.toBe(first)
    release()
    await first
    await second
    expect(t.w.trains).toBe(2)
  })
})

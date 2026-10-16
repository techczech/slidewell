import { describe, it, expect, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerReviewIpc } = await import('../src/main/review/ipc')
const { ReviewService } = await import('../src/main/review/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { putTriageDecision, setTriageDecision, resetReviewAnswers } = await import('../src/main/triage')
const { Retrainer } = await import('../src/main/sorter/retrain')
const { addShots, seedProposals, teachWell } = await import('./sorter-teach-fixture')

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})

const SINCE = '2026-10-13T00:00:00'
const NOW = Date.parse('2026-10-14T10:00:00Z')

/** Screenshots with a picture file each (sorter-teach-fixture); those named in `gone` then lose their file. */
function well(names: string[], gone: string[]): string {
  const w = teachWell(0, 0, names.map((hash) => ({ hash, takenAt: '2026-10-12T09:00:00', app: 'Invented App' })))
  wells.push(w)
  new SorterStore(w).close()
  seedProposals(w, names.map((hash) => ({ hash, proposal: 'doubtful' as const, pKeep: 0.5, sorterVersion: SORTER_VERSION })))
  for (const g of gone) rmSync(join(w, 'source', `${g}.png`))
  return w
}

/** A Review service on this well; Keep imports only the hashes in `imports` (stub: records included + a well id). */
function service(w: string, opts: { imports?: string[]; retrain?: () => unknown; now?: () => number } = {}): InstanceType<typeof ReviewService> {
  const imports = new Set(opts.imports ?? [])
  return new ReviewService({
    wellRoot: () => w,
    archiveRoot: () => join(w, 'archive'),
    sourceRoot: () => null,
    thumbUrl: (abs) => (abs ? `swthumb://t${abs}` : null),
    now: opts.now ?? (() => NOW),
    retrain: opts.retrain,
    promote: async (hashes) => {
      const imported = []
      for (const h of hashes.filter((x) => imports.has(x))) {
        await putTriageDecision(w, h, { state: 'included', decidedAt: new Date(NOW + 1000).toISOString(), wellId: `well-${h}` })
        imported.push({ hash: h, wellId: `well-${h}`, relPath: `${h}.png`, created: true })
      }
      return { imported, skipped: hashes.length - imported.length, gated: 0 }
    }
  })
}


function rowsOf(w: string): Map<string, { state: string | null; well_id: string | null; answer: string | null; answered_at: string | null }> {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT p.hash AS hash, d.state AS state, d.well_id AS well_id, p.answer AS answer, p.answered_at AS answered_at FROM sorter_proposals p LEFT JOIN triage_decisions d ON d.hash = p.hash').all() as Array<{ hash: string; state: string | null; well_id: string | null; answer: string | null; answered_at: string | null }>
    return new Map(rows.map((r) => [r.hash, r]))
  } finally {
    db.close()
  }
}

describe('Look again: answersSince', () => {
  const names = ['a1', 'a2', 'a3', 'a4', 'a5']
  /** A service whose clock moves a minute on each read of it, so every answer has its own time. */
  function ticking(w: string): InstanceType<typeof ReviewService> {
    let t = NOW
    return service(w, { now: () => (t += 60_000) })
  }

  it('lists the answers still standing, newest first, with counts, excluding Triage, overridden, emptied and older ones', async () => {
    const w = well([...names, 'old', 'triaged', 'emptied'], [])
    await service(w, { now: () => Date.parse('2026-10-10T10:00:00Z') }).act('old', 'throwaway')
    const svc = ticking(w)
    await svc.act('a1', 'keep')
    await svc.act('a2', 'throwaway')
    await svc.act('a3', 'throwaway')
    await svc.act('emptied', 'throwaway')
    await setTriageDecision('', w, '', 'triaged', 'exclude')
    await setTriageDecision('', w, '', 'a3', 'select') // a hand decision over his answer
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("UPDATE triage_decisions SET state = 'emptied', decided_at = ? WHERE hash = 'emptied'").run(new Date(NOW + 3_600_000).toISOString())
    db.close()
    const r = await svc.answersSince(SINCE)
    expect(r).toMatchObject({ total: 2, kept: 1, thrownAway: 1, next: null })
    expect(r.items.map((c) => [c.hash, c.answer])).toEqual([['a2', 'throwaway'], ['a1', 'keep']])
    expect(r.items[0]).toMatchObject({ picture: 'ok', filename: expect.any(String) })
    expect(r.items[0].answeredAt > r.items[1].answeredAt).toBe(true)
  })

  it('flipping an answer keeps it in the list under its new answer; writes nothing itself', async () => {
    const w = well(['a1'], [])
    const svc = ticking(w)
    await svc.act('a1', 'keep')
    const before = rowsOf(w)
    await svc.answersSince(SINCE)
    expect(rowsOf(w)).toEqual(before)
    await svc.act('a1', 'throwaway')
    expect(await svc.answersSince(SINCE)).toMatchObject({ total: 1, kept: 0, thrownAway: 1, items: [{ hash: 'a1', answer: 'throwaway' }] })
    await svc.undo()
    expect(await svc.answersSince(SINCE)).toMatchObject({ kept: 1, thrownAway: 0 })
  })

  it('pages stably by cursor', async () => {
    const w = well(names, [])
    const svc = ticking(w)
    for (const h of names) await svc.act(h, 'throwaway')
    const p1 = await svc.answersSince(SINCE, null, 2)
    const p2 = await svc.answersSince(SINCE, p1.next, 2)
    const p3 = await svc.answersSince(SINCE, p2.next, 2)
    expect([...p1.items, ...p2.items, ...p3.items].map((c) => c.hash)).toEqual(['a5', 'a4', 'a3', 'a2', 'a1'])
    expect([p1.total, p2.total, p3.total, p3.next]).toEqual([5, 5, 5, null])
    expect(p1.next).not.toBeNull()
  })

  it('IPC: refuses a bad since, cursor or limit', async () => {
    ipc.clear()
    const w = well(['a1'], [])
    const svc = ticking(w)
    await svc.act('a1', 'keep')
    const sender = { id: 1 }
    registerReviewIpc(svc, (s) => s === sender)
    const call = (...args: unknown[]): unknown => ipc.get('review:answers-since')!({ sender }, ...args)
    for (const bad of [[], [42], ['yesterday'], [undefined], [SINCE, 7], [SINCE, null, 0], [SINCE, null, 201], [SINCE, null, 1.5], [SINCE, null, 5, 1], [SINCE, 'x'.repeat(400)]]) expect(() => call(...bad), JSON.stringify(bad)).toThrow(/bad arguments/)
    expect(() => ipc.get('review:answers-since')!({ sender: { id: 2 } }, SINCE)).toThrow(/not allowed/)
    expect(await call(SINCE, null, 200)).toMatchObject({ total: 1, kept: 1 })
    expect(await call(SINCE)).toMatchObject({ total: 1 })
  })
})

describe('Look again: Done asks for a training after every answer (retrainAfterAnswers)', () => {
  function retrainerWith(train: () => Promise<{ ok: boolean; busy?: true }>, settings = { enabled: false }) {
    const status: { push?: (phase: string) => void } = {}
    const r = new Retrainer({
      train,
      choices: () => ({ learnable: null, trainedWith: null }),
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => settings,
      saveSettings: () => undefined,
      lastRetrain: () => null,
      saveLastRetrain: () => undefined,
      defer: () => undefined
    })
    status.push = (phase) => r.sorterStatus(phase)
    return { r, status }
  }
  const tick = async (n = 5): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise((res) => setTimeout(res, 0))
  }

  it('a training already running is not joined: one more starts after it, with the answer written', async () => {
    const w = well(['a1'], [])
    let trainings = 0
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const { r } = retrainerWith(async () => {
      trainings++
      if (trainings === 1) await gate
      return { ok: true }
    })
    const svc = service(w, { retrain: () => r.retrainAfterChange('manual') })
    const older = r.retrain('manual') // a Retrain now from before: it read his choices before the flip
    await tick()
    await svc.act('a1', 'throwaway')
    const asked = await svc.retrainAfterAnswers()
    expect(asked).toEqual({ ok: true, retrain: 1 })
    release()
    await older
    expect(await svc.rescueRetrain(1)).toEqual({ ok: true })
    expect(trainings).toBe(2)
  })

  it('a busy sorter and auto-retrain off: still owed, and it runs once the sorter is idle', async () => {
    const w = well(['a1'], [])
    let busy = true
    let trainings = 0
    const { r, status } = retrainerWith(async () => (busy ? { ok: false, busy: true } : (trainings++, { ok: true })))
    const svc = service(w, { retrain: () => r.retrainAfterChange('manual') })
    await svc.act('a1', 'keep')
    expect(await svc.retrainAfterAnswers()).toMatchObject({ ok: true })
    await tick()
    expect(trainings).toBe(0)
    busy = false
    status.push!('idle')
    await tick()
    expect(trainings).toBe(1)
    expect(await svc.rescueRetrain(1)).toEqual({ ok: true })
  })

  it('waits for an answer still being written: the training is asked for after it', async () => {
    const w = well(['a1'], [])
    const order: string[] = []
    const svc = service(w, { retrain: () => (order.push('retrain'), Promise.resolve({ ok: true })) })
    const act = svc.act('a1', 'throwaway').then(() => order.push('answer'))
    const asked = svc.retrainAfterAnswers()
    await Promise.all([act, asked])
    expect(order).toEqual(['answer', 'retrain'])
  })

  it('with no retrain to ask, says so and nothing is accepted', async () => {
    const w = well(['a1'], [])
    expect(await service(w).retrainAfterAnswers()).toEqual({ ok: false, error: 'The sorter could not retrain just now.' })
  })

  it('IPC: takes no argument', async () => {
    ipc.clear()
    const w = well(['a1'], [])
    const svc = service(w, { retrain: async () => ({ ok: true }) })
    const sender = { id: 1 }
    registerReviewIpc(svc, (s) => s === sender)
    const call = (...args: unknown[]): unknown => ipc.get('review:retrain-after-answers')!({ sender }, ...args)
    expect(() => call('manual')).toThrow(/bad arguments/)
    expect(() => ipc.get('review:retrain-after-answers')!({ sender: { id: 2 } })).toThrow(/not allowed/)
    expect(await call()).toEqual({ ok: true, retrain: 1 })
  })
})

describe('undo ids: every act ⌘Z can take back has its own id, and undo names the one it took back', () => {
  it('two acts on one screenshot get different ids; undo answers them last first', async () => {
    const w = well(['a1', 'a2'], [])
    const svc = service(w)
    const first = await svc.act('a1', 'keep')
    const second = await svc.act('a1', 'throwaway')
    const third = await svc.act('a2', 'keep')
    const ids = [first.undoId, second.undoId, third.undoId]
    expect(ids.every((x) => typeof x === 'number')).toBe(true)
    expect(new Set(ids).size).toBe(3)
    expect((await svc.undo()).undoId).toBe(third.undoId)
    expect(await svc.undo()).toMatchObject({ ok: true, hash: 'a1', undoId: second.undoId })
    expect(await svc.undo()).toMatchObject({ ok: true, hash: 'a1', undoId: first.undoId })
  })

  it('an act that wrote nothing has no id', async () => {
    const w = well(['a1'], [])
    const svc = service(w)
    await svc.act('a1', 'keep')
    const again = await svc.act('a1', 'keep')
    expect(again.undoId).toBeUndefined()
  })
})

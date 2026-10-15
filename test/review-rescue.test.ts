import { describe, it, expect, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerReviewIpc } = await import('../src/main/review/ipc')
const { ReviewService } = await import('../src/main/review/service')
const { blindRescue } = await import('../src/main/review/rescue')
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

describe('putting back blind Review answers (review/rescue.ts)', () => {
  it('finds a throwaway given on a missing file and puts it back to undecided, clearing the answer and asking for one retrain', async () => {
    const w = well(['lost', 'here'], ['lost'])
    const retrain = vi.fn()
    const svc = service(w, { retrain })
    await svc.act('lost', 'throwaway')
    await svc.act('here', 'throwaway')
    const found = await svc.blindAnswers(SINCE)
    expect(found).toMatchObject({ thrownAway: 1, kept: 0, keptImported: 0, keptNotImported: 0, emptied: 0 })
    const r = await svc.rescueBlind(found.token, SINCE)
    expect(r).toEqual({ ok: true, reset: 1, retrain: 1 })
    const rows = rowsOf(w)
    expect(rows.get('lost')).toMatchObject({ state: null, answer: null, answered_at: null })
    expect(rows.get('here')).toMatchObject({ state: 'excluded', answer: 'throwaway' }) // a real picture: left as he answered it
    expect(retrain).toHaveBeenCalledTimes(1)
    // it is back in the teaching queue, and undo cannot bring the blind answer back
    expect((await svc.teachQueue()).items.map((c) => c.hash)).toContain('lost')
    await svc.undo() // undoes 'here' (the last answer still standing), never 'lost'
    expect(rowsOf(w).get('lost')!.state).toBeNull()
    expect((await svc.blindAnswers(SINCE)).thrownAway).toBe(0)
  })

  it('does not find a throwaway on a file that is on this Mac', async () => {
    const w = well(['here'], [])
    const svc = service(w)
    await svc.act('here', 'throwaway')
    expect(await svc.blindAnswers(SINCE)).toMatchObject({ thrownAway: 0, kept: 0, emptied: 0 })
  })

  it('leaves a Triage decision alone: one made in Triage, and a Review answer later changed by hand in Triage', async () => {
    const w = well(['triaged', 'overridden'], ['triaged', 'overridden'])
    const svc = service(w)
    await setTriageDecision('', w, '', 'triaged', 'exclude')
    await svc.act('overridden', 'throwaway')
    await setTriageDecision('', w, '', 'overridden', 'exclude') // the same state, decided again by hand
    const found = await svc.blindAnswers(SINCE)
    expect(found).toMatchObject({ thrownAway: 0, kept: 0 })
    expect(await svc.rescueBlind(found.token, SINCE)).toEqual({ ok: true, reset: 0 })
    expect(rowsOf(w).get('triaged')!.state).toBe('excluded')
    expect(rowsOf(w).get('overridden')!.state).toBe('excluded')
  })

  it('counts a kept-and-imported answer but never puts it back; a kept-not-imported one goes back', async () => {
    const w = well(['imported', 'staged'], ['imported', 'staged']) // the well copy (stub) is not its picture here
    const retrain = vi.fn()
    const svc = service(w, { imports: ['imported'], retrain })
    await svc.act('imported', 'keep')
    await svc.act('staged', 'keep')
    const found = await svc.blindAnswers(SINCE)
    expect(found).toMatchObject({ thrownAway: 0, kept: 2, keptImported: 1, keptNotImported: 1 })
    expect(await svc.rescueBlind(found.token, SINCE)).toEqual({ ok: true, reset: 1, retrain: 1 })
    expect(rowsOf(w).get('imported')).toMatchObject({ state: 'included', well_id: 'well-imported', answer: 'keep' })
    expect(rowsOf(w).get('staged')).toMatchObject({ state: null, answer: null })
    expect(retrain).toHaveBeenCalledTimes(1)
  })

  it('refuses a stale token and writes nothing', async () => {
    const w = well(['a', 'b'], ['a', 'b'])
    const retrain = vi.fn()
    const svc = service(w, { retrain })
    await svc.act('a', 'throwaway')
    const { token } = await svc.blindAnswers(SINCE)
    await svc.act('b', 'throwaway') // the set changed after he looked
    const before = rowsOf(w)
    const r = await svc.rescueBlind(token, SINCE)
    expect(r.ok).toBe(false)
    expect(r.reset).toBe(0)
    expect(r.error).toBe('Something changed since you looked; check the list again.')
    expect(rowsOf(w)).toEqual(before)
    expect(retrain).not.toHaveBeenCalled()
    expect(await svc.rescueBlind('not-a-token', SINCE)).toMatchObject({ ok: false, reset: 0 })
  })

  it('ignores answers from before `since`, and counts but never touches an emptied one', async () => {
    const w = well(['old', 'emptied'], ['old', 'emptied'])
    await service(w, { now: () => Date.parse('2026-10-10T10:00:00Z') }).act('old', 'throwaway')
    await service(w).act('emptied', 'throwaway')
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("UPDATE triage_decisions SET state = 'emptied', decided_at = ? WHERE hash = 'emptied'").run(new Date(NOW + 60_000).toISOString())
    db.close()
    const svc = service(w)
    const found = await svc.blindAnswers(SINCE)
    expect(found).toMatchObject({ thrownAway: 0, kept: 0, emptied: 1 })
    expect((await svc.blindAnswers('2026-10-01T00:00:00')).thrownAway).toBe(1)
    expect(await svc.rescueBlind(found.token, SINCE)).toEqual({ ok: true, reset: 0 })
    expect(rowsOf(w).get('emptied')!.state).toBe('emptied')
  })

  it('writes all or nothing: an answer changed between the read and the write leaves every row as it was', async () => {
    const w = well(['a', 'b'], ['a', 'b'])
    const svc = service(w)
    await svc.act('a', 'throwaway')
    await svc.act('b', 'throwaway')
    const rescuer = blindRescue({ wellRoot: () => w, sourceRoot: () => null })
    const { token } = rescuer.findBlind(SINCE)
    // the token still matches (same set), but b's answer mark moves under it: the writer's own check refuses
    const { resetReviewAnswers } = await import('../src/main/triage')
    const rows = rowsOf(w)
    const snap = ['a', 'b'].map((h) => ({ hash: h, decision: { state: 'excluded', decidedAt: rows.get(h)!.answered_at, wellId: null }, answer: { answer: 'throwaway', answeredAt: h === 'b' ? 'something else' : rows.get(h)!.answered_at! }, reset: true }))
    expect(resetReviewAnswers(w, snap)).toEqual({ reset: [], changed: ['b'] })
    expect(rowsOf(w)).toEqual(rows)
    expect(rescuer.rescue(token, SINCE)).toMatchObject({ ok: true, reset: 2 })
  })

  it('IPC: refuses a bad since or token and passes good ones through', async () => {
    ipc.clear()
    const w = well(['lost'], ['lost'])
    const svc = service(w)
    await svc.act('lost', 'throwaway')
    const sender = { id: 1 }
    registerReviewIpc(svc, (s) => s === sender)
    const call = (channel: string, ...args: unknown[]): unknown => ipc.get(channel)!({ sender }, ...args)
    for (const bad of [[42], ['yesterday'], ['2026-10-13', 'x'], [{}]]) expect(() => call('review:blind-answers', ...bad), JSON.stringify(bad)).toThrow(/bad arguments/)
    for (const bad of [[], [7], ['t', 'nope'], ['t', SINCE, 1], ['x'.repeat(101)]]) expect(() => call('review:rescue-blind', ...bad), JSON.stringify(bad)).toThrow(/bad arguments/)
    expect(() => ipc.get('review:blind-answers')!({ sender: { id: 2 } })).toThrow(/not allowed/)
    const found = (await call('review:blind-answers', SINCE)) as { thrownAway: number; token: string }
    expect(found.thrownAway).toBe(1)
    expect(Object.keys(found).sort()).toEqual(['emptied', 'items', 'kept', 'keptImported', 'keptNotImported', 'thrownAway', 'token'])
    expect(await call('review:rescue-blind', found.token, SINCE)).toEqual({ ok: true, reset: 1 })
  })

  it('lists every answer found with its file name, answer and why there was no picture, from the same read as the counts', async () => {
    const w = well(['lost', 'cloud', 'kept'], ['lost', 'kept'])
    // 'cloud' is only a cloud placeholder here: its row is marked offline (the file stays, as iCloud leaves it)
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("UPDATE triage_fts SET offline = '1' WHERE hash = 'cloud'").run()
    db.close()
    const svc = service(w, { imports: [] })
    await svc.act('lost', 'throwaway')
    await svc.act('cloud', 'throwaway')
    await svc.act('kept', 'keep')
    const found = await svc.blindAnswers(SINCE)
    expect(found).toMatchObject({ thrownAway: 2, kept: 1, keptNotImported: 1 })
    const byHash = new Map(found.items.map((i) => [i.hash, i]))
    expect(found.items).toHaveLength(3)
    expect(byHash.get('lost')).toEqual({ hash: 'lost', filename: 'lost.png', answer: 'throwaway', picture: 'missing', recorded: true, putBack: true })
    expect(byHash.get('cloud')).toMatchObject({ answer: 'throwaway', picture: 'not-downloaded', putBack: true })
    expect(byHash.get('kept')).toMatchObject({ answer: 'keep', picture: 'missing', putBack: true })
  })

  it('judges by the picture recorded when he answered; only older answers without one are judged by now', async () => {
    const w = well(['seen', 'blind', 'old'], ['blind'])
    const svc = service(w)
    await svc.act('seen', 'throwaway') // a picture was there: recorded ok
    await svc.act('blind', 'throwaway') // none was: recorded missing
    await svc.act('old', 'throwaway')
    const pic = (h: string): string | null => {
      const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
      try {
        return (db.prepare('SELECT answered_picture AS p FROM sorter_proposals WHERE hash = ?').get(h) as { p: string | null }).p
      } finally {
        db.close()
      }
    }
    expect([pic('seen'), pic('blind'), pic('old')]).toEqual(['ok', 'missing', 'ok'])
    // 'old' stands for an answer from before the record: no picture state stored
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("UPDATE sorter_proposals SET answered_picture = NULL WHERE hash = 'old'").run()
    db.close()
    rmSync(join(w, 'source', 'seen.png')) // gone since: he saw it, so not blind
    rmSync(join(w, 'source', 'old.png')) // gone since, nothing recorded: judged by now, so blind
    writeFileSync(join(w, 'source', 'blind.png'), Buffer.alloc(8, 1)) // back since: he still answered blind
    const found = await svc.blindAnswers(SINCE)
    expect(found.items.map((i) => i.hash).sort()).toEqual(['blind', 'old'])
    expect(found.items.find((i) => i.hash === 'blind')).toMatchObject({ picture: 'missing', recorded: true })
    expect(found.items.find((i) => i.hash === 'old')).toMatchObject({ picture: 'missing', recorded: false }) // judged now
    expect(await svc.rescueBlind(found.token, SINCE)).toEqual({ ok: true, reset: 2 })
    expect(pic('blind')).toBeNull() // cleared with the answer
  })

  it('undo restores the picture recorded with the answer it brings back', async () => {
    const w = well(['x'], ['x'])
    const svc = service(w)
    await svc.act('x', 'throwaway') // no picture: recorded missing
    writeFileSync(join(w, 'source', 'x.png'), Buffer.alloc(8, 1))
    await svc.act('x', 'keep') // now with a picture: recorded ok
    const pic = (): string | null => {
      const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
      try {
        return (db.prepare("SELECT answered_picture AS p FROM sorter_proposals WHERE hash = 'x'").get() as { p: string | null }).p
      } finally {
        db.close()
      }
    }
    expect(pic()).toBe('ok')
    await svc.undo()
    expect(pic()).toBe('missing')
    expect(rowsOf(w).get('x')).toMatchObject({ state: 'excluded', answer: 'throwaway' })
    await svc.undo()
    expect(pic()).toBeNull()
  })

  it('refuses a token from before a re-answer of the same kind, and writes nothing', async () => {
    let now = NOW
    const w = well(['a'], ['a'])
    const svc = service(w, { now: () => now })
    await svc.act('a', 'throwaway')
    const { token } = await svc.blindAnswers(SINCE)
    await svc.undo()
    now += 60_000
    await svc.act('a', 'throwaway') // the same kind again, a minute later
    const before = rowsOf(w)
    expect(await svc.rescueBlind(token, SINCE)).toEqual({ ok: false, reset: 0, error: 'Something changed since you looked; check the list again.' })
    expect(rowsOf(w)).toEqual(before)
    const again = await svc.blindAnswers(SINCE)
    expect(again.token).not.toBe(token)
    expect(await svc.rescueBlind(again.token, SINCE)).toEqual({ ok: true, reset: 1 })
  })

  it('the transaction checks the whole confirmed set: the counted ones too, and never writes them', () => {
    const w = well(['back', 'imported', 'emptied'], [])
    const db = new DatabaseSync(join(w, 'triage.db'))
    const at = '2026-10-14T10:00:00.000Z'
    const put = (h: string, state: string, wellId: string | null, answer: string): void => {
      db.prepare('INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)').run(h, state, at, wellId)
      db.prepare('UPDATE sorter_proposals SET answer = ?, answered_at = ? WHERE hash = ?').run(answer, at, h)
    }
    put('back', 'excluded', null, 'throwaway')
    put('imported', 'included', 'well-1', 'keep')
    put('emptied', 'emptied', null, 'throwaway')
    db.close()
    const snap = (h: string, state: string, wellId: string | null, answer: string, reset: boolean) => ({ hash: h, decision: { state, decidedAt: at, wellId }, answer: { answer, answeredAt: at }, reset })
    const set = [snap('back', 'excluded', null, 'throwaway', true), snap('imported', 'included', 'well-1', 'keep', false), snap('emptied', 'emptied', null, 'throwaway', false)]
    const rows = rowsOf(w)
    // a counted item whose well id moved under the snapshot: nothing is written
    const moved = set.map((s) => (s.hash === 'imported' ? { ...s, decision: { ...s.decision, wellId: 'well-2' } } : s))
    expect(resetReviewAnswers(w, moved)).toEqual({ reset: [], changed: ['imported'] })
    expect(rowsOf(w)).toEqual(rows)
    // a counted emptied item whose decided_at moved: nothing is written
    const later = set.map((s) => (s.hash === 'emptied' ? { ...s, decision: { ...s.decision, decidedAt: '2026-10-14T11:00:00.000Z' } } : s))
    expect(resetReviewAnswers(w, later)).toEqual({ reset: [], changed: ['emptied'] })
    expect(rowsOf(w)).toEqual(rows)
    // all as seen: only the one marked reset goes back; the counted ones are left exactly as they were
    expect(resetReviewAnswers(w, set)).toEqual({ reset: ['back'], changed: [] })
    const after = rowsOf(w)
    expect(after.get('back')).toMatchObject({ state: null, answer: null, answered_at: null })
    expect(after.get('imported')).toEqual(rows.get('imported'))
    expect(after.get('emptied')).toEqual(rows.get('emptied'))
  })

  it('a rescue while a training runs with the old answers leads to a second training without them', async () => {
    const w = well(['lost', 'here'], ['lost'])
    const labelled = (): string[] => {
      const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
      try {
        return (db.prepare("SELECT hash FROM triage_decisions WHERE state IN ('excluded', 'selected', 'included') ORDER BY hash").all() as Array<{ hash: string }>).map((r) => r.hash)
      } finally {
        db.close()
      }
    }
    const seen: string[][] = []
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const retrainer = new Retrainer({
      train: async () => {
        seen.push(labelled()) // what this training learns from, read as it starts
        if (seen.length === 1) await gate
        return { ok: true }
      },
      choices: () => ({ learnable: null, trainedWith: null }),
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => ({ enabled: false }),
      saveSettings: () => undefined,
      lastRetrain: () => null,
      saveLastRetrain: () => undefined,
      defer: () => undefined
    })
    const svc = service(w, { retrain: () => retrainer.retrainAfterChange('manual') })
    await svc.act('lost', 'throwaway')
    await svc.act('here', 'throwaway')
    const first = retrainer.retrain('auto')
    await new Promise((res) => setTimeout(res, 0))
    expect(seen).toEqual([['here', 'lost']]) // running, with the blind answer
    const found = await svc.blindAnswers(SINCE)
    expect(await svc.rescueBlind(found.token, SINCE)).toEqual({ ok: true, reset: 1, retrain: 1 })
    release()
    await first
    for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0))
    expect(seen).toEqual([['here', 'lost'], ['here']])
  })

  it('records the worse of the picture main found and the one the card was shown with', async () => {
    const w = well(['broken', 'gone', 'plain', 'odd'], ['gone'])
    const svc = service(w)
    await svc.act('broken', 'throwaway', 'missing') // the file is there but would not load: he saw the missing panel
    await svc.act('gone', 'throwaway', 'ok') // the renderer cannot make a missing file seen
    await svc.act('plain', 'throwaway') // nothing sent: main's own check
    await svc.act('odd', 'throwaway', 'bogus' as never) // not a state: main's own check
    const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
    const pics = Object.fromEntries((db.prepare('SELECT hash, answered_picture AS p FROM sorter_proposals').all() as Array<{ hash: string; p: string }>).map((r) => [r.hash, r.p]))
    db.close()
    expect(pics).toEqual({ broken: 'missing', gone: 'missing', plain: 'ok', odd: 'ok' })
    const found = await svc.blindAnswers(SINCE)
    expect(found.items.map((i) => i.hash).sort()).toEqual(['broken', 'gone'])
  })

  it('IPC: review:act passes a shown picture state through and refuses anything else', async () => {
    ipc.clear()
    const w = well(['a', 'b'], [])
    const svc = service(w)
    const sender = { id: 1 }
    registerReviewIpc(svc, (s) => s === sender)
    const call = (...args: unknown[]): unknown => ipc.get('review:act')!({ sender }, ...args)
    for (const bad of ['bogus', 3, null, 'OK']) expect(() => call('a', 'throwaway', bad), String(bad)).toThrow(/bad arguments/)
    expect(await call('a', 'throwaway', 'not-downloaded')).toMatchObject({ ok: true })
    expect(await call('b', 'throwaway')).toMatchObject({ ok: true })
    const found = await svc.blindAnswers(SINCE)
    expect(found.items).toEqual([expect.objectContaining({ hash: 'a', picture: 'not-downloaded', recorded: true })])
  })

  it('a rescue while the sorter is busy with a sort, automatic retraining off: exactly one training once the sort ends, without the reset answers', async () => {
    const w = well(['lost', 'here'], ['lost'])
    const labelled = (): string[] => {
      const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
      try {
        return (db.prepare("SELECT hash FROM triage_decisions WHERE state IN ('excluded', 'selected', 'included') ORDER BY hash").all() as Array<{ hash: string }>).map((r) => r.hash)
      } finally {
        db.close()
      }
    }
    let sorting = true
    let asked = 0
    const trained: string[][] = []
    const retrainer = new Retrainer({
      train: async () => {
        asked++
        if (sorting) return { ok: false, busy: true as const, error: 'the sorter is busy' } // as SorterService.trainAndTest answers mid-sort
        trained.push(labelled())
        return { ok: true }
      },
      choices: () => ({ learnable: null, trainedWith: null }),
      changed: () => undefined,
      power: { onBattery: () => false, onAc: () => undefined },
      settings: () => ({ enabled: false }),
      saveSettings: () => undefined,
      lastRetrain: () => null,
      saveLastRetrain: () => undefined,
      defer: () => undefined
    })
    const svc = service(w, { retrain: () => retrainer.retrainAfterChange('manual') })
    await svc.act('lost', 'throwaway')
    await svc.act('here', 'throwaway')
    const found = await svc.blindAnswers(SINCE)
    expect(await svc.rescueBlind(found.token, SINCE)).toEqual({ ok: true, reset: 1, retrain: 1 })
    const tick = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0))
    }
    await tick()
    expect(asked).toBe(1) // tried, refused: the sort is running
    expect(trained).toEqual([])
    retrainer.sorterStatus('sorting') // still busy: nothing
    await tick()
    expect(asked).toBe(1)
    sorting = false
    retrainer.sorterStatus('idle') // the sort ended
    await tick()
    retrainer.sorterStatus('idle') // later idle pushes start nothing more
    await tick()
    expect(trained).toEqual([['here']])
  })
})

describe('after a put-back: how its retrain ended (review.rescueRetrain), and the queue the rescue runs in', () => {
  it('a retrain that fails: its reason, also when it ended before the renderer asked', async () => {
    const w = well(['lost'], ['lost'])
    const svc = service(w, { retrain: async () => ({ ok: false, error: 'download the picture search model first (Settings › Picture search)' }) })
    await svc.act('lost', 'throwaway')
    const r = await svc.rescueBlind((await svc.blindAnswers(SINCE)).token, SINCE)
    expect(r).toEqual({ ok: true, reset: 1, retrain: 1 })
    for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0)) // the training is over before anyone asks
    expect(await svc.rescueRetrain(r.retrain!)).toEqual({ ok: false, error: 'download the picture search model first (Settings › Picture search)' })
  })

  it('a retrain that throws: the plain words; one that runs: ok; an unknown id: null', async () => {
    const w = well(['a', 'b'], ['a', 'b'])
    let fail = true
    const svc = service(w, { retrain: async () => {
      if (fail) throw new Error('worker stopped at /some/path')
      return { ok: true }
    } })
    await svc.act('a', 'throwaway')
    const r1 = await svc.rescueBlind((await svc.blindAnswers(SINCE)).token, SINCE)
    expect(await svc.rescueRetrain(r1.retrain!)).toEqual({ ok: false, error: 'The sorter could not retrain just now.' })
    fail = false
    await svc.act('b', 'throwaway')
    const r2 = await svc.rescueBlind((await svc.blindAnswers(SINCE)).token, SINCE)
    expect(r2.retrain).toBe(2)
    expect(await svc.rescueRetrain(2)).toEqual({ ok: true })
    expect(await svc.rescueRetrain(1)).toBeNull() // only the last put-back's retrain is held
  })

  it('waits for a retrain still running and answers when it ends', async () => {
    const w = well(['lost'], ['lost'])
    let finish!: (o: { ok: boolean; error?: string }) => void
    const svc = service(w, { retrain: () => new Promise((res) => (finish = res)) })
    await svc.act('lost', 'throwaway')
    const r = await svc.rescueBlind((await svc.blindAnswers(SINCE)).token, SINCE)
    let end: unknown = 'pending'
    void svc.rescueRetrain(r.retrain!).then((e) => (end = e))
    await new Promise((res) => setTimeout(res, 0))
    expect(end).toBe('pending')
    finish({ ok: false, error: 'cancelled' })
    await new Promise((res) => setTimeout(res, 0))
    expect(end).toEqual({ ok: false, error: 'cancelled' })
  })

  it('IPC: review:rescue-retrain takes a whole id from 1 and nothing else', async () => {
    ipc.clear()
    const w = well(['lost'], ['lost'])
    const svc = service(w, { retrain: async () => ({ ok: true }) })
    await svc.act('lost', 'throwaway')
    const sender = { id: 1 }
    registerReviewIpc(svc, (s) => s === sender)
    const call = (channel: string, ...args: unknown[]): unknown => ipc.get(channel)!({ sender }, ...args)
    for (const bad of [[], ['1'], [0], [1.5], [-1], [Number.MAX_SAFE_INTEGER + 1]]) expect(() => call('review:rescue-retrain', ...bad), JSON.stringify(bad)).toThrow(/bad arguments/)
    const r = (await call('review:rescue-blind', (await svc.blindAnswers(SINCE)).token, SINCE)) as { retrain: number }
    expect(await call('review:rescue-retrain', r.retrain)).toEqual({ ok: true })
  })

  it('the rescue refuses to run outside the service queue (its set check depends on it); rescueBlind runs inside it', async () => {
    const w = well(['lost'], ['lost'])
    const svc = service(w)
    await svc.act('lost', 'throwaway')
    const token = (await svc.blindAnswers(SINCE)).token
    const direct = (svc as unknown as { rescuer: () => ReturnType<typeof blindRescue> }).rescuer()
    expect(() => direct.rescue(token, SINCE)).toThrow(/inside the service queue/)
    expect(rowsOf(w).get('lost')).toMatchObject({ state: 'excluded', answer: 'throwaway' }) // nothing written
    expect(await svc.rescueBlind(token, SINCE)).toEqual({ ok: true, reset: 1 })
  })
})

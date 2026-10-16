import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { SorterService, storedLocalRun } = await import('../src/main/sorter/service')
const { loadUndecided } = await import('../src/main/sorter/store')
const { fakePictures, teachWell } = await import('./sorter-teach-fixture')
type Deps = ConstructorParameters<typeof SorterService>[0]
type Summary = Parameters<NonNullable<Deps['saveLastRun']>>[0]

// Review's "leave screenshots that are not on this Mac out of Review and sorting": a sort run skips undecided screenshots
// whose file is a cloud placeholder and counts them. `cloud` is the stub's idea of which files are placeholders.
const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})
function setUp(skip: boolean): { svc: InstanceType<typeof SorterService>; saved: Summary[]; cloud: Set<string>; w: string } {
  const w = teachWell(70, 30, [{ hash: 'new0' }, { hash: 'new1' }, { hash: 'new2' }])
  wells.push(w)
  const cloud = new Set([join(w, 'source', 'new1.png')])
  const saved: Summary[] = []
  const svc = new SorterService({
    wellRoot: () => w,
    pictures: fakePictures(),
    broadcast: () => undefined,
    saveLastRun: (r) => void saved.push(r),
    skipNotOnMac: () => skip,
    dataless: (abs) => cloud.has(abs)
  })
  return { svc, saved, cloud, w }
}

describe('a sort run and screenshots that are not on this Mac', () => {
  it('marks an undecided screenshot whose file is a placeholder', () => {
    const { w, cloud } = setUp(true)
    const shots = loadUndecided(w, (abs) => cloud.has(abs))
    expect(shots.filter((s) => s.notOnMac).map((s) => s.hash)).toEqual(['new1'])
  })

  it('with the switch on, skips them and says how many in the run summary', async () => {
    const { svc, saved } = setUp(true)
    expect((await svc.trainAndTest()).ok).toBe(true)
    const r = await svc.sortUndecided()
    expect(r).toMatchObject({ ok: true, sorted: 2, notOnMacSkipped: 1 })
    expect(saved.at(-1)).toMatchObject({ lookedAt: 2, notOnMacSkipped: 1 })
    expect(svc.status({ count: true }).undecided?.all).toBe(2) // the number a sort would look at
  })

  it('with the switch off, sorts them as before and the summary carries no count', async () => {
    const { svc, saved } = setUp(false)
    await svc.trainAndTest()
    const r = await svc.sortUndecided()
    expect(r).toMatchObject({ ok: true, sorted: 3 })
    expect(r.notOnMacSkipped).toBeUndefined()
    expect(saved.at(-1)!.notOnMacSkipped).toBeUndefined()
  })

  it('a stored summary keeps a whole-number count and drops anything else', () => {
    const base = { at: '2026-10-13T10:00:00.000Z', period: 'all', lookedAt: 2, confident: 1, needLook: 1 }
    expect(storedLocalRun({ ...base, notOnMacSkipped: 4 })).toMatchObject({ notOnMacSkipped: 4 })
    expect(storedLocalRun({ ...base, notOnMacSkipped: -1 })).not.toHaveProperty('notOnMacSkipped')
    expect(storedLocalRun({ ...base, notOnMacSkipped: 'x' })).not.toHaveProperty('notOnMacSkipped')
    expect(storedLocalRun({ ...base, notOnMacSkipped: 0 })).not.toHaveProperty('notOnMacSkipped')
  })
})

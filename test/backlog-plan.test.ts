import { describe, it, expect } from 'vitest'
import { planBacklogImport, parseLedger, copyStateKey, alternativeName, foldersOverlap, isMovedFolderName, type PlanInput, type LedgerEntry } from '../src/main/backlog-plan'
import { compileNameTemplate } from '../src/main/screenshot-name'

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  watchedFolder: '/W/Shots',
  desktopDir: '/H/Desktop',
  cleanshotDir: '/H/CS/media',
  desktop: [],
  cleanshot: [],
  watchedNames: [],
  ledger: [],
  date: '2026-10-09',
  ...over
})
const f = (rel: string, size = 100, mtimeMs = 1): { rel: string; size: number; mtimeMs: number } => ({ rel, size, mtimeMs })
const entry = (from: string, dest = '/W/Shots/a.png', watched = '/W/Shots'): LedgerEntry => ({ step: 'copied', hash: 'h', watched, source: 'cleanshot', from, size: 100, mtimeMs: 1, dest, at: '' })

describe('planBacklogImport (copy only)', () => {
  it('takes only screenshot-named media from the Desktop top level; plans copies, never moves', () => {
    const plan = planBacklogImport(
      base({
        desktop: [
          f('CleanShot 2026-10-08 at 0801 from Google Chrome.png'),
          f('Screenshot 2026-10-08 at 10.05.01.png'),
          f('Invoice.pdf'),
          f('holiday.png'),
          f('CleanShot 2026-10-08 at 0801.txt'),
          f('.Screenshot 2026-10-08 at 10.05.01.png'),
          f('sub/Screenshot 2026-10-08 at 10.05.01.png')
        ]
      })
    )
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items.map((i) => i.name)).toEqual(['CleanShot 2026-10-08 at 0801 from Google Chrome.png', 'Screenshot 2026-10-08 at 10.05.01.png'])
    expect(plan.items[0].copyTo).toBe('/W/Shots/CleanShot 2026-10-08 at 0801 from Google Chrome.png')
    expect(Object.keys(plan.items[0])).not.toContain('moveTo')
  })

  it('copies CleanShot history captures and skips project files and bundles', () => {
    const plan = planBacklogImport(
      base({ cleanshot: [f('media_a/CleanShot 2026-10-01 at 0900.png'), f('media_b/CleanShot 2026-10-01 at 0901.cleanshot'), f('media_c/x.cleanshotvideo/…', 0), f('media_d/clip.mp4'), f('loose.png')] })
    )
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items.map((i) => i.name)).toEqual(['CleanShot 2026-10-01 at 0900.png', 'clip.mp4'])
    expect(plan.summary.skipped).toEqual({ cleanshotProjects: 1, cleanshotOther: 2, empty: 0, notRegular: 0 })
  })

  it('summarises counts, bytes and up to five example names per source', () => {
    const desktop = Array.from({ length: 7 }, (_, i) => f(`Screenshot 2026-10-0${i + 1} at 10.05.01.png`, 1000))
    const plan = planBacklogImport(base({ desktop, cleanshot: [f('m1/a.png', 50)] }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.summary.desktop).toMatchObject({ count: 7, bytes: 7000 })
    expect(plan.summary.desktop.examples).toHaveLength(5)
    expect(plan.summary.cleanshot).toEqual({ count: 1, bytes: 50, examples: ['a.png'] })
    expect(plan.summary.totalBytes).toBe(7050)
  })

  it('flags names already in the watched folder or used earlier in the plan (case-insensitive)', () => {
    const plan = planBacklogImport(
      base({
        watchedNames: ['screenshot 2026-10-08 at 10.05.01.png'],
        desktop: [f('Screenshot 2026-10-08 at 10.05.01.png'), f('CleanShot 2026-10-08 at 0801.png')],
        cleanshot: [f('m1/CleanShot 2026-10-08 at 0801.png')]
      })
    )
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items.map((i) => i.nameTaken)).toEqual([false, true, true])
  })

  it('an item is done only when its recorded copy checks out; missing or changed copies are planned again', () => {
    const ledger = [entry('/H/CS/media/m1/a.png', '/W/Shots/a.png'), entry('/H/CS/media/m2/b.png', '/W/Shots/b.png'), entry('/H/CS/media/m3/c.png', '/W/Shots/c.png'), entry('/H/CS/media/m4/d.png', '/W/Shots/d.png', '/Other')]
    const plan = planBacklogImport(
      base({
        cleanshot: [f('m1/a.png'), f('m2/b.png'), f('m3/c.png'), f('m4/d.png')],
        ledger,
        copyStates: { [copyStateKey('/W/Shots/a.png', 'h')]: 'ok', [copyStateKey('/W/Shots/b.png', 'h')]: 'missing-or-changed' } // c: not checked → treated as missing
      })
    )
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items.map((i) => [i.name, i.recopy])).toEqual([
      ['b.png', true],
      ['c.png', true],
      ['d.png', false]
    ])
    expect(plan.summary).toMatchObject({ done: 1, recopy: 2, cleanshot: { count: 3 } })
  })

  it('a recorded copy that is online-only is counted as unverified: neither done nor copied again', () => {
    const plan = planBacklogImport(base({ cleanshot: [f('m1/a.png')], ledger: [entry('/H/CS/media/m1/a.png')], copyStates: { [copyStateKey('/W/Shots/a.png', 'h')]: 'online-only' } }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items).toHaveLength(0)
    expect(plan.summary).toMatchObject({ done: 0, unverifiedOnlineOnly: 1 })
  })

  it('plans online-only sources flagged for download; leaves out empty and non-regular files', () => {
    const plan = planBacklogImport(base({ cleanshot: [{ ...f('m1/a.png'), size: 3_000_000, onlineOnly: true }, f('m2/b.png'), f('m3/c.png', 0), { ...f('m4/d.png'), notRegular: true }] }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items.map((i) => [i.name, i.onlineOnly])).toEqual([
      ['a.png', true],
      ['b.png', false]
    ])
    expect(plan.summary.needDownloading).toEqual({ count: 1, bytes: 3_000_000 })
    expect(plan.summary.skipped).toMatchObject({ empty: 1, notRegular: 1 })
  })

  it('recognises Desktop names with CleanShot\'s own template', () => {
    const tpl = compileNameTemplate(['CleanShot ', '%y', '-', '%m', '-', '%d', ' at ', '%H', '%M', 'from ', '%a', ' with ', '%t'])
    const mine = 'CleanShot 2026-10-10 at 1147from TalkWeaver with TalkWeaver.png'
    const plan = planBacklogImport(base({ desktop: [f(mine), f('notes.png')], nameTemplate: tpl }))
    expect(plan.ok && plan.items.map((i) => i.name)).toEqual([mine])
  })

  it('counts staged files left by an interrupted run', () => {
    const plan = planBacklogImport(base({ stagingNames: ['a.png.0123abcd', '.DS_Store'] }))
    expect(plan.ok && plan.summary.leftoverStaged).toBe(1)
  })

  it('refuses without a watched folder or when folders overlap', () => {
    expect(planBacklogImport(base({ watchedFolder: null }))).toMatchObject({ ok: false, reason: 'no-watched-folder' })
    expect(planBacklogImport(base({ watchedFolder: '/H/Desktop/Shots' }))).toMatchObject({ ok: false, reason: 'watched-folder-overlaps' })
    expect(planBacklogImport(base({ watchedFolder: '/H' }))).toMatchObject({ ok: false, reason: 'watched-folder-overlaps' })
  })
})

describe('helpers', () => {
  it('alternativeName keeps the extension', () => {
    expect(alternativeName('a b.png', 2)).toBe('a b (2).png')
    expect(alternativeName('noext', 3)).toBe('noext (3)')
  })
  it('foldersOverlap', () => {
    expect(foldersOverlap('/a/b', '/a/b/')).toBe(true)
    expect(foldersOverlap('/a/b', '/a/bc')).toBe(false)
  })
  it('isMovedFolderName', () => {
    expect(isMovedFolderName('Moved by SlideWell 2026-10-09')).toBe(true)
    expect(isMovedFolderName('Moved by SlideWell notes')).toBe(false)
  })
  it('a placing intent alone is not a "copied before" (no recopy flag) and its key includes the hash', () => {
    const intent: LedgerEntry = { ...entry('/H/CS/media/m1/a.png'), step: 'placing' }
    const plan = planBacklogImport(base({ cleanshot: [f('m1/a.png')], ledger: [intent], copyStates: { [copyStateKey('/W/Shots/a.png', 'other')]: 'ok' } }))
    expect(plan.ok && plan.items.map((i) => i.recopy)).toEqual([false])
  })
  it('an online-only path vouched for only by an intent is planned, not "unverified"', () => {
    const intent: LedgerEntry = { ...entry('/H/CS/media/m1/a.png'), step: 'placing' }
    const plan = planBacklogImport(base({ cleanshot: [f('m1/a.png')], ledger: [intent], copyStates: { [copyStateKey('/W/Shots/a.png', 'h')]: 'online-only' } }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items).toHaveLength(1)
    expect(plan.summary.unverifiedOnlineOnly).toBe(0)
  })
  it('parseLedger skips a torn line and old move records', () => {
    const good = JSON.stringify({ step: 'copied', hash: 'h', watched: '/W', source: 'desktop', from: '/x', size: 1, mtimeMs: 1, dest: '/W/x', at: '' })
    const moved = JSON.stringify({ step: 'moved', hash: 'h', watched: '/W', source: 'desktop', from: '/x', size: 1, mtimeMs: 1, dest: '/W/m/x', at: '' })
    expect(parseLedger(`${good}\n${moved}\n{"step":"cop`)).toHaveLength(1)
  })
})

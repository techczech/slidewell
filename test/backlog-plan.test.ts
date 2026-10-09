import { describe, it, expect } from 'vitest'
import { planBacklogImport, parseLedger, alternativeName, foldersOverlap, type PlanInput, type LedgerEntry } from '../src/main/backlog-plan'

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

describe('planBacklogImport', () => {
  it('takes only screenshot-named media from the Desktop top level', () => {
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
    expect(plan.items.every((i) => i.source === 'desktop' && i.moveTo?.startsWith('/W/Shots/Moved by SlideWell 2026-10-09/'))).toBe(true)
    expect(plan.items[0].copyTo).toBe('/W/Shots/CleanShot 2026-10-08 at 0801 from Google Chrome.png')
  })

  it('copies CleanShot history captures, never moves them, and skips project files and bundles', () => {
    const plan = planBacklogImport(
      base({ cleanshot: [f('media_a/CleanShot 2026-10-01 at 0900.png'), f('media_b/CleanShot 2026-10-01 at 0901.cleanshot'), f('media_c/x.cleanshotvideo/…', 0), f('media_d/clip.mp4'), f('loose.png')] })
    )
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items.map((i) => [i.name, i.moveTo])).toEqual([
      ['CleanShot 2026-10-01 at 0900.png', null],
      ['clip.mp4', null]
    ])
    expect(plan.summary.skipped).toEqual({ cleanshotProjects: 1, cleanshotOther: 2, empty: 0 })
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
    expect(plan.summary.nameTaken).toBe(2)
  })

  it('marks items the ledger already holds (same path, size, mtime, same watched folder) as likely done', () => {
    const e = (from: string, watched = '/W/Shots'): LedgerEntry => ({ step: 'copied', hash: 'h', watched, source: 'cleanshot', from, size: 100, mtimeMs: 1, dest: '/W/Shots/a.png', at: '' })
    const plan = planBacklogImport(base({ cleanshot: [f('m1/a.png'), f('m2/b.png'), f('m3/c.png')], ledger: [e('/H/CS/media/m1/a.png'), e('/H/CS/media/m2/b.png', '/Other')] }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.items.map((i) => i.likelyDone)).toEqual([true, false, false])
    expect(plan.summary.cleanshot.count).toBe(2)
    expect(plan.summary.likelyDone).toBe(1)
  })

  it('counts leftover partial copies and does not treat them as taken names', () => {
    const plan = planBacklogImport(base({ watchedNames: ['.a.png.1-ab.slidewell-partial', 'x.png'], cleanshot: [f('m1/a.png')] }))
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.summary.leftoverPartials).toBe(1)
    expect(plan.items[0].nameTaken).toBe(false)
  })

  it('skips empty files', () => {
    const plan = planBacklogImport(base({ cleanshot: [f('m1/a.png', 0)] }))
    expect(plan.ok && plan.items.length === 0 && plan.summary.skipped.empty === 1).toBe(true)
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
  it('parseLedger skips a torn last line', () => {
    const good = JSON.stringify({ step: 'copied', hash: 'h', watched: '/W', source: 'desktop', from: '/x', size: 1, mtimeMs: 1, dest: '/W/x', at: '' })
    expect(parseLedger(`${good}\n{"step":"cop`)).toHaveLength(1)
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotOnMacCache, TTL_MS, BATCH } from '../src/main/review/not-on-mac-cache'
import { pictureChooser, type PictureChoice } from '../src/main/review/picture'
import type { ReviewFile } from '../src/main/review/store'

// Which screenshots are not on this Mac, per hash for 60 s, checked in batches that hand the event loop a turn.
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const file = (relPath: string, offline = false): ReviewFile => ({ source: '/invented/source', relPath, filename: relPath, app: '', windowTitle: '', takenAt: '', kind: 'image', offline, posterRel: '', mtime: 0 })
const items = (n: number, offline = (_i: number): boolean => false): Array<{ hash: string; copies: ReviewFile[] }> =>
  Array.from({ length: n }, (_, i) => ({ hash: `h${i}`, copies: [file(`s${i}.png`, offline(i))] }))
// a chooser stub: every third hash is a placeholder; counts the hashes it is asked about
function stub(): { choose: (hash: string) => PictureChoice; asked: string[] } {
  const asked: string[] = []
  const choose = (hash: string): PictureChoice => {
    asked.push(hash)
    const away = Number(hash.slice(1)) % 3 === 0
    return { state: away ? 'not-downloaded' : 'ok', abs: null, originalAbs: null, expectedDir: null }
  }
  return { choose, asked }
}

describe('NotOnMacCache', () => {
  it('answers from the cache for 60 s, then checks again', async () => {
    let t = 1_000
    const c = new NotOnMacCache({ now: () => t, yieldNow: async () => undefined })
    const s = stub()
    const list = items(9)
    expect([...(await c.notHere(list, s.choose))].sort()).toEqual(['h0', 'h3', 'h6'])
    expect(s.asked).toHaveLength(9)
    t += TTL_MS - 1
    await c.notHere(list, s.choose)
    expect(s.asked).toHaveLength(9) // nothing looked at on disk again
    t += 1
    await c.notHere(list, s.choose)
    expect(s.asked).toHaveLength(18)
  })

  it('a scan or a download (invalidate) and a changed row (its copies) are checked again at once', async () => {
    const c = new NotOnMacCache({ now: () => 5, yieldNow: async () => undefined })
    const s = stub()
    await c.notHere(items(4), s.choose)
    c.invalidate()
    await c.notHere(items(4), s.choose)
    expect(s.asked).toHaveLength(8)
    await c.notHere(items(4, (i) => i === 2), s.choose) // the scan flagged one row as offline
    expect(s.asked.slice(8)).toEqual(['h2'])
  })

  it('hands the event loop a turn every BATCH checks, and only for checks it had to make', async () => {
    let turns = 0
    const c = new NotOnMacCache({ now: () => 0, yieldNow: async () => void turns++ })
    const s = stub()
    await c.notHere(items(BATCH * 5), s.choose)
    expect(turns).toBe(4)
    turns = 0
    await c.notHere(items(BATCH * 5), s.choose)
    expect(turns).toBe(0)
  })

  it('a check that a scan overtook does not store what it found', async () => {
    let c!: NotOnMacCache
    let first = true
    c = new NotOnMacCache({
      now: () => 0,
      yieldNow: async () => {
        if (first) c.invalidate() // the scan lands while the check is under way
        first = false
      }
    })
    const s = stub()
    await c.notHere(items(BATCH + 10), s.choose)
    await c.notHere(items(BATCH + 10), s.choose)
    expect(s.asked.length).toBe((BATCH + 10) * 2)
  })

  it('with the real chooser over 2,000 files no batch holds the main process long, and a cached read is quick', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sw-nom-'))
    dirs.push(src)
    const list = Array.from({ length: 2000 }, (_, i) => {
      writeFileSync(join(src, `s${i}.png`), Buffer.alloc(16, 1))
      return { hash: `h${i}`, copies: [{ ...file(`s${i}.png`), source: src }] }
    })
    const choose = pictureChooser({ wellRoot: () => src, sourceRoot: () => null, allowedRoots: () => [src] })
    let last = performance.now()
    let longest = 0
    const c = new NotOnMacCache({
      yieldNow: async () => {
        const t = performance.now()
        longest = Math.max(longest, t - last)
        await new Promise((r) => setImmediate(r))
        last = performance.now()
      }
    })
    const away = await c.notHere(list, choose)
    expect(away.size).toBe(0)
    expect(longest).toBeLessThan(250)
    const t0 = performance.now()
    await c.notHere(list, pictureChooser({ wellRoot: () => src, sourceRoot: () => null, allowedRoots: () => [src] }))
    expect(performance.now() - t0).toBeLessThan(100)
  })
})

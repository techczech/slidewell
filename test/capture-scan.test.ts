// Capture-watcher scan with online-only files (ticket 15), on scratch folders only
// (~/Library/Caches/slidewell-dev-15/…). "Online-only" = a sparse file (size > 0, no blocks on disk);
// the injected downloader "downloads" it by writing its bytes. No real iCloud or OneDrive is involved.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

vi.mock('../src/main/well', () => ({
  ocrImage: async () => '',
  ingestScreenshot: async () => null,
  ingestVideo: async () => null,
  makePoster: async () => false,
  recordWellSource: async () => undefined
}))
const { scanTriageSource } = await import('../src/main/triage')
const { query } = await import('../src/main/sqlite')

const SCRATCH = join(homedir(), 'Library', 'Caches', 'slidewell-dev-15', 'vitest-scan')
let n = 0
let dir = ''
let src = ''
let well = ''

beforeEach(() => {
  dir = join(SCRATCH, `${process.pid}-${n++}`)
  rmSync(dir, { recursive: true, force: true })
  src = join(dir, 'Shots')
  well = join(dir, 'well')
  mkdirSync(src, { recursive: true })
  mkdirSync(well, { recursive: true })
  src = realpathSync(src)
})
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

/** A sparse "online-only" file; `age` minutes old (newest are tried first). */
function placeholder(name: string, age: number): string {
  const p = join(src, name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '')
  truncateSync(p, 16384)
  const t = Date.now() / 1000 - age * 60
  utimesSync(p, t, t)
  expect(statSync(p).blocks).toBe(0)
  return p
}
/** The fake download: writes real bytes into the file, keeping its size and times. */
function arrive(p: string): void {
  const st = statSync(p)
  const fd = openSync(p, 'r+')
  writeSync(fd, Buffer.alloc(16384, p.length))
  closeSync(fd)
  utimesSync(p, st.atime, st.mtime)
}
const rows = async (): Promise<Record<string, string>> =>
  Object.fromEntries((await query<{ rel_path: string; offline: string }>(join(well, 'triage.db'), 'SELECT rel_path, offline FROM triage_fts', [])).map((r) => [r.rel_path, r.offline]))

describe('capture scan: online-only files', () => {
  it('without download authority nothing is downloaded or read', async () => {
    placeholder('a.png', 1)
    const asked: string[] = []
    await scanTriageSource('/nonexistent', well, src, undefined, { download: async (p) => void asked.push(p) })
    expect(asked).toEqual([])
    expect(await rows()).toEqual({ 'a.png': '1' })
  })

  it('a failed file does not stop later files; each is downloaded inside the root', async () => {
    placeholder('bad.png', 1)
    placeholder('good.png', 2)
    const asked: Array<[string, string]> = []
    await scanTriageSource('/nonexistent', well, src, undefined, {
      downloadRoot: src,
      download: async (p, o) => {
        asked.push([p.slice(src.length + 1), o.root])
        if (p.endsWith('bad.png')) throw Object.assign(new Error('offline'), { code: 'EDOWNLOAD' })
        arrive(p)
      }
    })
    expect(asked).toEqual([
      ['bad.png', src],
      ['good.png', src]
    ])
    expect(await rows()).toEqual({ 'bad.png': '1', 'good.png': '0' })
  })

  it('after N failures in a row the scan stops downloading, so being offline cannot stall it', async () => {
    for (let i = 1; i <= 4; i++) placeholder(`bad${i}.png`, i)
    placeholder('good.png', 9)
    let calls = 0
    await scanTriageSource('/nonexistent', well, src, undefined, {
      downloadRoot: src,
      downloadFailLimit: 3,
      download: async () => {
        calls++
        throw Object.assign(new Error('offline'), { code: 'EDOWNLOAD' })
      }
    })
    expect(calls).toBe(3)
    expect(Object.values(await rows())).toEqual(['1', '1', '1', '1', '1'])
  })

  it('a later scan tries the not-downloaded files again once their backoff has passed', async () => {
    const p = placeholder('a.png', 1)
    const t = Date.now()
    let calls = 0
    await scanTriageSource('/nonexistent', well, src, undefined, { downloadRoot: src, now: () => t, download: async () => Promise.reject(new Error('offline')) })
    expect(await rows()).toEqual({ 'a.png': '1' })
    const fetch = async (): Promise<void> => {
      calls++
      arrive(p)
    }
    await scanTriageSource('/nonexistent', well, src, undefined, { downloadRoot: src, now: () => t + 60_000, download: fetch })
    expect(calls).toBe(0) // one minute later: still backing off
    await scanTriageSource('/nonexistent', well, src, undefined, { downloadRoot: src, now: () => t + 11 * 60_000, download: fetch })
    expect(calls).toBe(1)
    expect(await rows()).toEqual({ 'a.png': '0' })
  })

  it('files that never download cannot starve a healthy older one: it is downloaded within two scans', async () => {
    for (let i = 1; i <= 3; i++) placeholder(`bad${i}.png`, i)
    const good = placeholder('good.png', 9)
    const t = Date.now()
    const asked: string[][] = []
    const scan = async (at: number): Promise<void> => {
      const mine: string[] = []
      asked.push(mine)
      await scanTriageSource('/nonexistent', well, src, undefined, {
        downloadRoot: src,
        downloadFailLimit: 3,
        now: () => at,
        download: async (p) => {
          mine.push(p.slice(src.length + 1))
          if (p !== good) throw Object.assign(new Error('unavailable'), { code: 'EDOWNLOAD' })
          arrive(p)
        }
      })
    }
    await scan(t)
    await scan(t + 60_000)
    expect(asked).toEqual([['bad1.png', 'bad2.png', 'bad3.png'], ['good.png']])
    expect((await rows())['good.png']).toBe('0')
    // backoff grows: after 10 minutes the bad ones are tried again, after a second failure they wait 20
    await scan(t + 11 * 60_000)
    await scan(t + 22 * 60_000)
    expect(asked.slice(2)).toEqual([['bad1.png', 'bad2.png', 'bad3.png'], []])
  })

  it('scans a day apart: a healthy older file is downloaded on the first scan that reaches it and never starved', async () => {
    for (let i = 1; i <= 3; i++) placeholder(`never${i}.png`, i) // the three newest never download
    const healthy = placeholder('healthy.png', 30)
    const t = Date.now()
    const asked: string[][] = []
    const afterScan: string[] = []
    for (let s = 0; s < 5; s++) {
      const mine: string[] = []
      asked.push(mine)
      await scanTriageSource('/nonexistent', well, src, undefined, {
        downloadRoot: src,
        downloadFailLimit: 3,
        now: () => t + s * 25 * 3_600_000, // every backoff, even the one-day maximum, has passed
        download: async (p) => {
          mine.push(p.slice(src.length + 1))
          if (p !== healthy) throw Object.assign(new Error('unavailable'), { code: 'EDOWNLOAD' })
          arrive(p)
        }
      })
      afterScan.push((await rows())['healthy.png'])
    }
    // scan 1 spends its three failures on the newest; scan 2 reaches the never-tried file first
    expect(asked[0]).toEqual(['never1.png', 'never2.png', 'never3.png'])
    expect(asked[1][0]).toBe('healthy.png')
    expect(afterScan).toEqual(['1', '0', '0', '0', '0'])
    expect(asked.flat().filter((x) => x === 'healthy.png')).toHaveLength(1)
  })

  it('retries go to the file waiting longest: failing files take turns across scans', async () => {
    for (let i = 1; i <= 5; i++) placeholder(`never${i}.png`, i)
    const t = Date.now()
    const asked: string[][] = []
    for (let s = 0; s < 3; s++) {
      const mine: string[] = []
      asked.push(mine)
      let clock = t + s * 25 * 3_600_000
      await scanTriageSource('/nonexistent', well, src, undefined, {
        downloadRoot: src,
        downloadFailLimit: 3,
        now: () => clock++, // each attempt is recorded at a distinct moment
        download: async (p) => {
          mine.push(p.slice(src.length + 1))
          throw Object.assign(new Error('unavailable'), { code: 'EDOWNLOAD' })
        }
      })
    }
    expect(asked).toEqual([
      ['never1.png', 'never2.png', 'never3.png'],
      ['never4.png', 'never5.png', 'never1.png'], // never tried first, then the oldest attempt
      ['never2.png', 'never3.png', 'never4.png']
    ])
  })

  it('the primary Triage folder nested inside the source is neither walked nor downloaded in', async () => {
    placeholder('Triage/in-primary.png', 1)
    placeholder('Triage/deeper/also.png', 1)
    placeholder('beside.png', 2)
    const asked: string[] = []
    await scanTriageSource('/nonexistent', well, src, undefined, {
      downloadRoot: src,
      excludeDir: realpathSync(join(src, 'Triage')),
      download: async (p) => {
        asked.push(p.slice(src.length + 1))
        arrive(p)
      }
    })
    expect(asked).toEqual(['beside.png'])
    expect(await rows()).toEqual({ 'beside.png': '0' })
  })

  it('after the download the file is read only if it is still that file inside the root (symlink swap)', async () => {
    placeholder('sub/moved.png', 1)
    placeholder('swap/other.png', 2)
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(dir, 'outside', 'other.png'), 'outside bytes')
    await scanTriageSource('/nonexistent', well, src, undefined, {
      downloadRoot: src,
      download: async (p) => {
        arrive(p)
        if (p.endsWith('moved.png')) {
          // the same file, but its folder is moved out of the root and a link left in its place
          renameSync(join(src, 'sub'), join(dir, 'moved-out'))
          symlinkSync(join(dir, 'moved-out'), join(src, 'sub'))
        } else {
          // the folder becomes a link to an outside folder holding another file of the same name
          renameSync(join(src, 'swap'), join(dir, 'swap-old'))
          symlinkSync(join(dir, 'outside'), join(src, 'swap'))
        }
      }
    })
    expect(await rows()).toEqual({ 'sub/moved.png': '1', 'swap/other.png': '1' })
  })

  it('a FIFO left in the file\'s place after the download is not read and does not stall the scan', async () => {
    placeholder('pipe.png', 1)
    placeholder('fine.png', 2)
    await scanTriageSource('/nonexistent', well, src, undefined, {
      downloadRoot: src,
      download: async (p) => {
        if (p.endsWith('pipe.png')) {
          rmSync(p)
          execFileSync('mkfifo', [p])
        } else arrive(p)
      }
    })
    expect(await rows()).toEqual({ 'pipe.png': '1', 'fine.png': '0' })
  }, 5000)

  it('the scan-owned signal (app quit, backlog Stop) ends downloading at once', async () => {
    placeholder('a.png', 1)
    placeholder('b.png', 2)
    const stop = new AbortController()
    let calls = 0
    let killed = false
    await scanTriageSource('/nonexistent', well, src, undefined, {
      downloadRoot: src,
      signal: stop.signal,
      download: (_p, o) =>
        new Promise<void>(() => {
          calls++
          o.signal?.addEventListener('abort', () => (killed = true))
          setTimeout(() => stop.abort(), 20)
        })
    })
    expect(calls).toBe(1)
    expect(killed).toBe(true)
    expect(await rows()).toEqual({ 'a.png': '1', 'b.png': '1' })
  })
})

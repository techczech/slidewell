// Capture-watcher scan with online-only files (ticket 15), on scratch folders only
// (~/Library/Caches/slidewell-dev-15/…). "Online-only" = a sparse file (size > 0, no blocks on disk);
// the injected downloader "downloads" it by writing its bytes. No real iCloud or OneDrive is involved.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { closeSync, mkdirSync, openSync, realpathSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

  it('a later scan tries the not-downloaded files again', async () => {
    const p = placeholder('a.png', 1)
    await scanTriageSource('/nonexistent', well, src, undefined, { downloadRoot: src, download: async () => Promise.reject(new Error('offline')) })
    expect(await rows()).toEqual({ 'a.png': '1' })
    await scanTriageSource('/nonexistent', well, src, undefined, { downloadRoot: src, download: async () => arrive(p) })
    expect(await rows()).toEqual({ 'a.png': '0' })
  })

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

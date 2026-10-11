// Execution layer (copy only) on scratch folders only (~/Library/Caches/slidewell-dev-13/…), never
// the real Desktop, CleanShot history or watched folder.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { dryRun, runImport, ledgerPath, readHashed, defaultIsOnlineOnly, type BacklogEnv } from '../src/main/backlog-import'
import { parseLedger, STAGING_DIR } from '../src/main/backlog-plan'
import { downloadOnlineOnly, downloadWithDeadline } from '../src/main/online-only'

const SCRATCH_ROOT = join(homedir(), 'Library', 'Caches', 'slidewell-dev-13', 'vitest')
let n = 0
let root = ''
let env: BacklogEnv

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const DATE = new Date(2026, 9, 9, 12, 0, 0)
const D1 = 'Screenshot 2026-10-08 at 10.05.01.png'
const D2 = 'CleanShot 2026-10-08 at 0801 from Safari.png'
const C1 = 'CleanShot 2026-10-01 at 0900.png'
const C2 = 'CleanShot 2026-10-01 at 0901.mp4'

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out[relative(root, p)] = `${sha(readFileSync(p))}:${statSync(p).mtimeMs}`
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}
const put = (p: string, content: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}
const W = (...p: string[]): string => join(env.watchedFolder!, ...p)
const staged = (): string[] => (existsSync(W(STAGING_DIR)) ? readdirSync(W(STAGING_DIR)) : [])
const watchedHashes = (): string[] =>
  readdirSync(env.watchedFolder!, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => sha(readFileSync(W(e.name))))
const realLink = (a: string, b: string): Promise<void> => fsp.link(a, b)
const fail = (code: string): Promise<never> => Promise.reject(Object.assign(new Error(code), { code }))

beforeEach(() => {
  root = join(SCRATCH_ROOT, `${process.pid}-${n++}`)
  rmSync(root, { recursive: true, force: true })
  env = {
    desktopDir: join(root, 'Desktop'),
    cleanshotDir: join(root, 'CleanShot', 'media'),
    watchedFolder: join(root, 'Watched'),
    stateDir: join(root, 'state'),
    now: () => DATE,
    retry: { baseMs: 1 }
  }
  put(join(env.desktopDir, D1), 'desk-1')
  put(join(env.desktopDir, D2), 'desk-2')
  put(join(env.desktopDir, 'Invoice.pdf'), 'not a screenshot')
  put(join(env.desktopDir, 'holiday.png'), 'not a screenshot either')
  put(join(env.cleanshotDir!, 'media_a', C1), 'cs-1')
  put(join(env.cleanshotDir!, 'media_b', C2), 'cs-2')
  put(join(env.cleanshotDir!, 'media_c', 'CleanShot 2026-10-01 at 0902.cleanshot'), 'project')
  mkdirSync(env.watchedFolder!, { recursive: true })
})
afterAll(() => {
  execFileSync('chmod', ['-R', 'u+rwX', SCRATCH_ROOT])
  rmSync(SCRATCH_ROOT, { recursive: true, force: true })
})

describe('backlog import (copy only) on scratch folders', () => {
  it('dry run lists the plan and changes nothing anywhere', async () => {
    const before = tree(root)
    const plan = await dryRun(env)
    expect(plan.ok && plan.summary).toMatchObject({ desktop: { count: 2 }, cleanshot: { count: 2 }, skipped: { cleanshotProjects: 1 } })
    expect(tree(root)).toEqual(before)
    expect(existsSync(env.stateDir)).toBe(false)
    expect(existsSync(W(STAGING_DIR))).toBe(false)
  })

  it('copies with hash verification and leaves every original exactly where and as it was', async () => {
    const originals = { ...tree(env.desktopDir), ...tree(env.cleanshotDir!) }
    const res = await runImport(await dryRun(env), env)
    expect(res).toMatchObject({ ok: true, copied: 4, failed: 0, desktopWithCopy: 2 })
    for (const [name, body] of [
      [D1, 'desk-1'],
      [D2, 'desk-2'],
      [C1, 'cs-1'],
      [C2, 'cs-2']
    ])
      expect(readFileSync(W(name), 'utf8')).toBe(body)
    expect({ ...tree(env.desktopDir), ...tree(env.cleanshotDir!) }).toEqual(originals)
    expect(staged()).toEqual([]) // every staged file unlinked after its verified link
    expect(lstatSync(W(STAGING_DIR)).isDirectory()).toBe(true)
    expect(parseLedger(readFileSync(ledgerPath(env.stateDir), 'utf8')).filter((e) => e.step === 'copied')).toHaveLength(4)
    expect(readFileSync(res.logPath, 'utf8')).toContain('"verified":true')
  })

  it.each(['ENOTSUP', 'EPERM', 'EXDEV'])('without hard links (%s) it falls back to an exclusive copyFile', async (code) => {
    const noLinks: BacklogEnv = { ...env, ops: { link: () => fail(code) } }
    expect(await runImport(await dryRun(noLinks), noLinks)).toMatchObject({ ok: true, copied: 4 })
    expect(readFileSync(W(C1), 'utf8')).toBe('cs-1')
    expect(staged()).toEqual([])
  })

  describe('interruption and resume', () => {
    it('a failure between staging and placing keeps the staged file; a re-run copies without duplicates', async () => {
      let once = true
      const crashing: BacklogEnv = { ...env, ops: { link: (a, b) => (once && b === W(C1) ? ((once = false), fail('EIO')) : realLink(a, b)) } }
      const first = await runImport(await dryRun(crashing), crashing)
      expect(first).toMatchObject({ copied: 3, failed: 1 })
      expect(staged()).toHaveLength(1) // kept, never unlinked without a verified link
      const plan = await dryRun(env)
      expect(plan.ok && plan.summary).toMatchObject({ cleanshot: { count: 1 }, leftoverStaged: 1, done: 3 })
      expect(await runImport(plan, env)).toMatchObject({ ok: true, copied: 1 })
      expect(watchedHashes()).toHaveLength(4)
      expect(new Set(watchedHashes()).size).toBe(4)
    })

    it('a run stopped part-way resumes without duplicates', async () => {
      const ac = new AbortController()
      const first = await runImport(await dryRun(env), env, { signal: ac.signal, onProgress: (p) => p.done === 2 && ac.abort() })
      expect(first).toMatchObject({ cancelled: true, copied: 2 })
      expect((await runImport(await dryRun(env), env)).ok).toBe(true)
      expect(watchedHashes()).toHaveLength(4)
      expect(new Set(watchedHashes()).size).toBe(4)
    })

    it('a copy that landed before its ledger line is recognised by hash, not copied again', async () => {
      put(W(C1), 'cs-1')
      expect(await runImport(await dryRun(env), env)).toMatchObject({ ok: true, reused: 1, copied: 3 })
      expect(watchedHashes()).toHaveLength(4)
    })

    it('a partial final file from a crash is a collision: kept, logged as a possible incomplete copy, copy takes the next name', async () => {
      put(W(C1), 'cs') // shorter than the source: as if a copyFile fallback was cut off
      const res = await runImport(await dryRun(env), env)
      expect(res).toMatchObject({ ok: true, copied: 4 })
      expect(readFileSync(W(C1), 'utf8')).toBe('cs')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
      const log = readFileSync(res.logPath, 'utf8')
      expect(log).toContain('"event":"possible-incomplete-copy"')
      expect(log).toContain(JSON.stringify(W(C1)))
    })

    it('a torn ledger tail does not swallow the next record', async () => {
      const ac = new AbortController()
      await runImport(await dryRun(env), env, { signal: ac.signal, onProgress: (p) => p.done === 2 && ac.abort() })
      appendFileSync(ledgerPath(env.stateDir), '{"step":"copied","hash":"to') // the process died mid-append
      expect(await runImport(await dryRun(env), env)).toMatchObject({ ok: true, copied: 2 })
      expect(parseLedger(readFileSync(ledgerPath(env.stateDir), 'utf8')).filter((e) => e.step === 'copied')).toHaveLength(4)
      expect(await runImport(await dryRun(env), env)).toMatchObject({ copied: 0, reused: 0 })
      expect(watchedHashes()).toHaveLength(4)
    })

    it('item 6 (reviewer sequence): a missing or changed recorded copy is counted in Settings and copied again', async () => {
      await runImport(await dryRun(env), env)
      rmSync(W(C1)) // test setup: the recorded copy disappeared
      put(W(C2), 'altered') // and another one changed
      const plan = await dryRun(env)
      expect(plan.ok && plan.summary).toMatchObject({ recopy: 2, cleanshot: { count: 2 }, done: 2 }) // count > 0 → "Bring them in" shows
      const res = await runImport(plan, env)
      expect(res).toMatchObject({ ok: true, copied: 2 })
      expect(readFileSync(W(C1), 'utf8')).toBe('cs-1')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0901 (2).mp4'), 'utf8')).toBe('cs-2')
      expect(readFileSync(W(C2), 'utf8')).toBe('altered') // never overwritten
    })
  })

  describe('re-review P2s', () => {
    it('P2-1: verification is keyed by (destination, hash): B at the same path does not make A look verified', async () => {
      const a = join(env.cleanshotDir!, 'media_x', 'x.png')
      const b = join(env.cleanshotDir!, 'media_y', 'y.png')
      put(a, 'aaa')
      put(b, 'bbb')
      put(W('x.png'), 'bbb') // the path now holds B's content
      mkdirSync(env.stateDir, { recursive: true })
      const rec = (from: string, body: string): string =>
        JSON.stringify({ step: 'copied', hash: sha(body), watched: env.watchedFolder, source: 'cleanshot', from, size: statSync(from).size, mtimeMs: Math.round(statSync(from).mtimeMs), dest: W('x.png'), at: '' })
      writeFileSync(ledgerPath(env.stateDir), `${rec(b, 'bbb')}\n${rec(a, 'aaa')}\n`) // B verified first, then A
      const plan = await dryRun(env)
      if (!plan.ok) throw new Error('expected a plan')
      expect(plan.items.find((i) => i.from === a)).toMatchObject({ recopy: true })
      expect(plan.items.find((i) => i.from === b)).toBeUndefined()
      const res = await runImport(plan, env)
      expect(res.ok).toBe(true)
      expect(readFileSync(W('x (2).png'), 'utf8')).toBe('aaa')
      expect(readFileSync(W('x.png'), 'utf8')).toBe('bbb')
    })

    it('P2-2: a copy that landed before its done record is not duplicated when the content returns under another name', async () => {
      let crash = true
      const dying: BacklogEnv = {
        ...env,
        ops: {
          link: async (a, b) => {
            await realLink(a, b)
            if (crash && b === W(C1)) {
              crash = false
              throw Object.assign(new Error('process died after the link'), { code: 'EIO' })
            }
          }
        }
      }
      const first = await runImport(await dryRun(dying), dying)
      expect(first).toMatchObject({ failed: 1, copied: 3 })
      const entries = parseLedger(readFileSync(ledgerPath(env.stateDir), 'utf8'))
      expect(entries.some((e) => e.step === 'placing' && e.dest === W(C1))).toBe(true)
      expect(entries.some((e) => e.step === 'copied' && e.dest === W(C1))).toBe(false)
      // the same capture now sits under another name (test setup), so filename variants cannot find it
      await fsp.rename(join(env.cleanshotDir!, 'media_a', C1), join(env.cleanshotDir!, 'media_a', 'renamed.png'))
      const second = await runImport(await dryRun(env), env)
      expect(second).toMatchObject({ ok: true, copied: 0, alreadyDone: 1 })
      expect(existsSync(W('renamed.png'))).toBe(false)
      expect(watchedHashes()).toHaveLength(4)
      expect(parseLedger(readFileSync(ledgerPath(env.stateDir), 'utf8')).some((e) => e.step === 'copied' && e.dest === W(C1))).toBe(true)
      expect(readFileSync(second.logPath, 'utf8')).toContain('intent-confirmed')
    })
  })

  describe.each([false, true])('re-review P2-3: an intent-only destination that is online-only (source renamed: %s)', (renamed) => {
    it('is unresolved work: the item is planned and copied under another name, the placeholder never read', async () => {
      let crash = true
      const dying: BacklogEnv = {
        ...env,
        ops: {
          link: async (a, b) => {
            await realLink(a, b)
            if (crash && b === W(C1)) {
              crash = false
              throw Object.assign(new Error('process died after the link'), { code: 'EIO' })
            }
          }
        }
      }
      await runImport(await dryRun(dying), dying)
      const entries = parseLedger(readFileSync(ledgerPath(env.stateDir), 'utf8'))
      expect(entries.some((e) => e.step === 'placing' && e.dest === W(C1)) && !entries.some((e) => e.step === 'copied' && e.dest === W(C1))).toBe(true)
      chmodSync(W(C1), 0o000) // the placeholder: any read attempt would fail
      const src = renamed ? join(env.cleanshotDir!, 'media_a', 'renamed.png') : join(env.cleanshotDir!, 'media_a', C1)
      if (renamed) await fsp.rename(join(env.cleanshotDir!, 'media_a', C1), src)
      const fake: BacklogEnv = { ...env, ops: { isOnlineOnly: async (p) => p === W(C1) } }
      const plan = await dryRun(fake)
      expect(plan.ok && plan.summary).toMatchObject({ cleanshot: { count: 1 }, unverifiedOnlineOnly: 0 })
      const res = await runImport(plan, fake)
      expect(res).toMatchObject({ ok: true, copied: 1, unverifiedOnlineOnly: 0, onlineOnly: 0, failed: 0 })
      const dest = renamed ? W('renamed.png') : W('CleanShot 2026-10-01 at 0900 (2).png')
      expect(readFileSync(dest, 'utf8')).toBe('cs-1')
      expect(statSync(W(C1)).mode & 0o777).toBe(0) // untouched
    })
  })

  describe('online-only copies in the watched folder (never downloaded)', () => {
    it('item 7: an online-only recorded copy is unverified, not done, not copied again, not read', async () => {
      await runImport(await dryRun(env), env)
      chmodSync(W(C1), 0o000) // any read attempt would fail
      const fake: BacklogEnv = { ...env, ops: { isOnlineOnly: async (p) => p === W(C1) } }
      const plan = await dryRun(fake)
      expect(plan.ok && plan.summary).toMatchObject({ unverifiedOnlineOnly: 1, done: 3, cleanshot: { count: 0 } })
      // the same content arriving from another capture: still not copied again
      put(join(env.cleanshotDir!, 'media_e', 'again.png'), 'cs-1')
      const res = await runImport(await dryRun(fake), fake)
      expect(res).toMatchObject({ copied: 0, unverifiedOnlineOnly: 1, failed: 0 })
      expect(readdirSync(env.watchedFolder!).filter((x) => !x.startsWith('.'))).toHaveLength(4)
    })

    it('an online-only recorded copy is never downloaded to check it (the download is for sources only)', async () => {
      await runImport(await dryRun(env), env)
      const asked: string[] = []
      const fake: BacklogEnv = { ...env, ops: { isOnlineOnly: async (p) => p === W(C1), download: async (p) => void asked.push(p) } }
      await runImport(await dryRun(fake), fake)
      expect(asked).toEqual([])
    })

    it('a name taken by an online-only file is not read; the item is left out and reported', async () => {
      put(W(C1), 'cloud placeholder')
      chmodSync(W(C1), 0o000)
      const fake: BacklogEnv = { ...env, ops: { isOnlineOnly: async (p) => p === W(C1) } }
      const res = await runImport(await dryRun(fake), fake)
      expect(res).toMatchObject({ failed: 0, onlineOnly: 1, copied: 3 })
    })

    it('an ordinary file is not online-only', async () => {
      expect(await defaultIsOnlineOnly(join(env.desktopDir, D1))).toBe(false)
    })
  })

  // Ticket 15: online-only sources (iCloud Desktop, OneDrive placeholders) are downloaded one at a time.
  // The fake: a source is "dataless" (mode 000, so any read in this process would fail) until the
  // injected downloader "downloads" it (restores the mode). No real iCloud or OneDrive is involved.
  describe('online-only sources are downloaded, then copied', () => {
    const SRC = (): string => join(env.cleanshotDir!, 'media_a', C1)
    const dataless = (paths: string[], download: (p: string, o: { timeoutMs: number; signal?: AbortSignal }) => Promise<void>): BacklogEnv => {
      const offline = new Set(paths)
      for (const p of paths) chmodSync(p, 0o000)
      return {
        ...env,
        ops: {
          isOnlineOnly: async (p) => offline.has(p),
          download: async (p, o) => {
            await download(p, o)
            if (offline.delete(p)) chmodSync(p, 0o644)
          }
        }
      }
    }

    it('the dry run says how many need downloading and their size, without reading them', async () => {
      const before = tree(root)
      const fake = dataless([SRC(), join(env.desktopDir, D1)], async () => undefined)
      const plan = await dryRun(fake)
      expect(plan.ok && plan.summary).toMatchObject({ needDownloading: { count: 2, bytes: 4 + 6 }, desktop: { count: 2 }, cleanshot: { count: 2 } })
      chmodSync(SRC(), 0o644)
      chmodSync(join(env.desktopDir, D1), 0o644)
      expect(tree(root)).toEqual(before) // nothing written, nothing changed
    })

    it('downloads each online-only source, then copies and verifies it; the original stays', async () => {
      const asked: string[] = []
      const fake = dataless([SRC(), join(env.desktopDir, D1)], async (p) => void asked.push(p))
      const res = await runImport(await dryRun(fake), fake)
      expect(res).toMatchObject({ ok: true, copied: 4, downloaded: 2, onlineOnly: 0, failed: 0 })
      expect(asked).toEqual([join(env.desktopDir, D1), SRC()])
      expect(readFileSync(W(C1), 'utf8')).toBe('cs-1')
      expect(readFileSync(SRC(), 'utf8')).toBe('cs-1') // copy only: the original is still there
      expect(readFileSync(W(D1), 'utf8')).toBe('desk-1')
    })

    it('a download that does not arrive within the per-file timeout is left out, never read, and the run carries on', async () => {
      let aborted = false
      const fake = dataless([SRC()], (_p, o) => new Promise<void>(() => o.signal?.addEventListener('abort', () => (aborted = true)))) // never finishes
      const res = await runImport(await dryRun(fake), { ...fake, downloadTimeoutMs: 50 })
      expect(res).toMatchObject({ ok: true, copied: 3, downloaded: 0, onlineOnly: 1, failed: 0 })
      expect(aborted).toBe(true) // the downloader was told to stop (the real one kills its child)
      expect(existsSync(W(C1))).toBe(false)
      expect(statSync(SRC()).mode & 0o777).toBe(0) // untouched
      // the next run tries again (the file has arrived meanwhile)
      chmodSync(SRC(), 0o644)
      const again = dataless([], async () => undefined)
      expect(await runImport(await dryRun(again), again)).toMatchObject({ copied: 1, alreadyDone: 0 })
    })

    it('Stop during a download ends the run at once; nothing after it is copied', async () => {
      chmodSync(SRC(), 0o000)
      const stop = new AbortController()
      const fake = dataless([SRC()], (_p, o) => new Promise<void>((_r, reject) => {
        setTimeout(() => stop.abort(), 10)
        o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('killed'), { code: 'EDOWNLOAD' })))
      }))
      const res = await runImport(await dryRun(fake), fake, { signal: stop.signal })
      expect(res).toMatchObject({ cancelled: true, ok: false, copied: 2, downloaded: 0 })
      expect(existsSync(W(C1)) || existsSync(W(C2))).toBe(false)
    })

    it('a file still online-only after the download is left out', async () => {
      const fake = dataless([SRC()], async () => undefined)
      fake.ops!.download = async () => undefined // "finished" but the bytes never came
      expect(await runImport(await dryRun(fake), fake)).toMatchObject({ ok: true, copied: 3, onlineOnly: 1, failed: 0 })
    })

    it('the real downloader reads a local file out of process and refuses non-regular files and a stopped run', async () => {
      await downloadOnlineOnly(join(env.desktopDir, D1), { timeoutMs: 5000 })
      execFileSync('mkfifo', [join(root, 'pipe.png')])
      await expect(downloadOnlineOnly(join(root, 'pipe.png'), { timeoutMs: 5000 })).rejects.toMatchObject({ code: 'ENOTREG' })
      const stopped = new AbortController()
      stopped.abort()
      await expect(downloadOnlineOnly(join(env.desktopDir, D1), { timeoutMs: 5000, signal: stopped.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' })
      expect(readFileSync(join(env.desktopDir, D1), 'utf8')).toBe('desk-1')
    })

    it('the deadline holds even when the downloader ignores it', async () => {
      const t0 = Date.now()
      await expect(downloadWithDeadline('/x', () => new Promise<void>(() => undefined), { timeoutMs: 30 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      expect(Date.now() - t0).toBeLessThan(1000)
    })
  })

  describe('item 8: only regular files are opened', () => {
    it('a FIFO among the sources is skipped and counted, never opened', async () => {
      mkdirSync(join(env.cleanshotDir!, 'media_f'))
      execFileSync('mkfifo', [join(env.cleanshotDir!, 'media_f', 'pipe.png')])
      const plan = await dryRun(env)
      expect(plan.ok && plan.summary).toMatchObject({ skipped: { notRegular: 1 }, cleanshot: { count: 2 } })
      expect(await runImport(plan, env)).toMatchObject({ ok: true, copied: 4 })
    })

    it('a FIFO at a destination name is never opened; the copy takes the next name', async () => {
      execFileSync('mkfifo', [W(C1)])
      expect(await runImport(await dryRun(env), env)).toMatchObject({ ok: true, copied: 4 })
      expect(lstatSync(W(C1)).isFIFO()).toBe(true)
      expect(readFileSync(W('CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
    })

    it('readHashed refuses a FIFO without blocking, times out a stalled read, and stops on cancel', async () => {
      const fifo = join(root, 'stuck.fifo')
      execFileSync('mkfifo', [fifo])
      await expect(readHashed(fifo, { idleMs: 10_000 })).rejects.toMatchObject({ code: 'ENOTREG' })
      const file = join(env.desktopDir, D1)
      const never = (): Promise<void> => new Promise(() => undefined)
      await expect(readHashed(file, { idleMs: 150, onChunk: never })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 100)
      await expect(readHashed(file, { idleMs: 10_000, signal: ac.signal, onChunk: never })).rejects.toMatchObject({ code: 'ABORT_ERR' })
    })
  })

  describe('never replaces anything', () => {
    it('different file under the same name: kept; the copy takes the next name', async () => {
      put(W(C1), 'someone else, longer than the source')
      expect((await runImport(await dryRun(env), env)).ok).toBe(true)
      expect(readFileSync(W(C1), 'utf8')).toBe('someone else, longer than the source')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
    })

    it('race: a file created at the final name between check and link is kept', async () => {
      let planted = false
      const racy: BacklogEnv = {
        ...env,
        ops: {
          link: async (a, b) => {
            if (!planted && b === W(C1)) {
              planted = true
              writeFileSync(b, 'arrived during the run')
            }
            await realLink(a, b)
          }
        }
      }
      expect(await runImport(await dryRun(racy), racy)).toMatchObject({ ok: true, copied: 4 })
      expect(readFileSync(W(C1), 'utf8')).toBe('arrived during the run')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
      expect(staged()).toEqual([])
    })

    it('race in the copyFile fallback: exclusive create, the planted file is kept', async () => {
      let planted = false
      const racy: BacklogEnv = {
        ...env,
        ops: {
          link: async (_a, b) => {
            if (!planted && b === W(C1)) {
              planted = true
              writeFileSync(b, 'arrived during the run')
            }
            return fail('ENOTSUP')
          }
        }
      }
      expect(await runImport(await dryRun(racy), racy)).toMatchObject({ ok: true, copied: 4 })
      expect(readFileSync(W(C1), 'utf8')).toBe('arrived during the run')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
    })

    it('a final copy that does not verify is left in place and the staged file is kept', async () => {
      const bad: BacklogEnv = { ...env, ops: { link: () => fail('ENOTSUP'), copyFileExcl: async (_a, b) => writeFileSync(b, 'wrong', { flag: 'wx' }) } }
      const res = await runImport(await dryRun(bad), bad)
      expect(res.failed).toBe(4)
      expect(readFileSync(W(C1), 'utf8')).toBe('wrong')
      expect(staged()).toHaveLength(4)
    })

    it('an original edited while being copied: the item fails, the staged file is kept, nothing reaches the final name', async () => {
      const editing: BacklogEnv = { ...env, ops: { onSourceChunk: (from) => (from.endsWith(D1) ? appendFileSync(from, ' edited') : undefined) } }
      const res = await runImport(await dryRun(editing), editing)
      expect(res).toMatchObject({ failed: 1, copied: 3 })
      expect(existsSync(W(D1))).toBe(false)
      expect(staged()).toHaveLength(1)
    })

    it('a symlink planted at the staged path is neither followed nor removed', async () => {
      const victim = join(root, 'victim.txt')
      put(victim, 'precious')
      mkdirSync(W(STAGING_DIR))
      const trap = W(STAGING_DIR, 'trap')
      symlinkSync(victim, trap)
      const trapEnv: BacklogEnv = { ...env, ops: { stagedName: (dir, name) => (name === C1 ? trap : join(dir, `${name}.${Math.random()}`)) } }
      const res = await runImport(await dryRun(trapEnv), trapEnv)
      expect(res).toMatchObject({ failed: 1, copied: 3 })
      expect(readFileSync(victim, 'utf8')).toBe('precious')
      expect(lstatSync(trap).isSymbolicLink()).toBe(true)
    })

    it('a symlink planted at the staging folder is refused; nothing lands behind it', async () => {
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, W(STAGING_DIR))
      const res = await runImport(await dryRun(env), env)
      expect(res).toMatchObject({ copied: 0, failed: 4 })
      expect(readdirSync(elsewhere)).toEqual([])
    })
  })

  describe('folders are compared by realpath', () => {
    it('a watched folder that is a symlink to CleanShot history or the Desktop is refused', async () => {
      const toHistory = join(root, 'alias-history')
      symlinkSync(env.cleanshotDir!, toHistory)
      expect(await dryRun({ ...env, watchedFolder: toHistory })).toMatchObject({ ok: false, reason: 'watched-folder-overlaps' })
      const toHome = join(root, 'alias-home')
      symlinkSync(root, toHome)
      expect(await dryRun({ ...env, watchedFolder: join(toHome, 'Desktop') })).toMatchObject({ ok: false, reason: 'watched-folder-overlaps' })
    })

    it('a run refuses when the watched folder now resolves elsewhere than in the plan', async () => {
      const plan = await dryRun(env)
      const alias = join(root, 'alias-history')
      symlinkSync(env.cleanshotDir!, alias)
      const before = tree(join(root, 'CleanShot'))
      const res = await runImport(plan, { ...env, watchedFolder: alias })
      expect(res.ok).toBe(false)
      expect(res.errors[0]).toMatch(/changed/)
      expect(tree(join(root, 'CleanShot'))).toEqual(before)
    })
  })

  it('the same capture on the Desktop and in CleanShot history is copied once', async () => {
    put(join(env.cleanshotDir!, 'media_d', D1), 'desk-1')
    expect(await runImport(await dryRun(env), env)).toMatchObject({ ok: true, copied: 4, alreadyDone: 1 })
    expect(watchedHashes()).toHaveLength(4)
  })

  it('retries EDEADLK / EAGAIN (OneDrive) and then succeeds', async () => {
    let fails = 3
    const flaky: BacklogEnv = { ...env, ops: { link: (a, b) => (fails-- > 0 ? fail(fails % 2 ? 'EDEADLK' : 'EAGAIN') : realLink(a, b)) } }
    expect(await runImport(await dryRun(flaky), flaky)).toMatchObject({ ok: true, copied: 4 })
  })

  it('a file that vanished after the plan is reported', async () => {
    const plan = await dryRun(env)
    rmSync(join(env.desktopDir, D1)) // test setup only
    expect(await runImport(plan, env)).toMatchObject({ gone: 1, copied: 3 })
  })
})

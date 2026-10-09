// Execution layer on scratch folders only (~/Library/Caches/slidewell-dev-13/…), never the real
// Desktop, CleanShot history or watched folder.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, closeSync, constants as FS, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { dryRun, runImport, ledgerPath, readHashed, defaultIsOnlineOnly, type BacklogEnv } from '../src/main/backlog-import'
import { parseLedger } from '../src/main/backlog-plan'

const SCRATCH_ROOT = join(homedir(), 'Library', 'Caches', 'slidewell-dev-13', 'vitest')
let n = 0
let root = ''
let env: BacklogEnv

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const DATE = new Date(2026, 9, 9, 12, 0, 0)
const MOVED = 'Moved by SlideWell 2026-10-09'
const D1 = 'Screenshot 2026-10-08 at 10.05.01.png'
const D2 = 'CleanShot 2026-10-08 at 0801 from Safari.png'
const C1 = 'CleanShot 2026-10-01 at 0900.png'

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(root, p)] = `${sha(readFileSync(p))}:${statSync(p).mtimeMs}`
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
const watchedHashes = (): string[] =>
  readdirSync(env.watchedFolder!, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => sha(readFileSync(W(e.name))))
const realLink = (a: string, b: string): Promise<void> => fsp.link(a, b)

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
  put(join(env.cleanshotDir!, 'media_b', 'CleanShot 2026-10-01 at 0901.mp4'), 'cs-2')
  put(join(env.cleanshotDir!, 'media_c', 'CleanShot 2026-10-01 at 0902.cleanshot'), 'project')
  mkdirSync(env.watchedFolder!, { recursive: true })
})
afterAll(() => {
  execFileSync('chmod', ['-R', 'u+rwX', SCRATCH_ROOT])
  rmSync(SCRATCH_ROOT, { recursive: true, force: true })
})

describe('backlog import on scratch folders', () => {
  it('dry run lists the plan and changes nothing anywhere', async () => {
    const before = tree(root)
    const plan = await dryRun(env)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.summary.desktop.count).toBe(2)
    expect(plan.summary.cleanshot.count).toBe(2)
    expect(plan.summary.skipped.cleanshotProjects).toBe(1)
    expect(tree(root)).toEqual(before)
    expect(existsSync(env.stateDir)).toBe(false)
  })

  it('copies with hash verification, moves Desktop originals into the dated folder, deletes nothing', async () => {
    const csBefore = tree(env.cleanshotDir!)
    const res = await runImport(await dryRun(env), env)
    expect(res).toMatchObject({ ok: true, copied: 4, moved: 2, failed: 0 })
    for (const [name, body] of [
      [D1, 'desk-1'],
      [D2, 'desk-2'],
      [C1, 'cs-1'],
      ['CleanShot 2026-10-01 at 0901.mp4', 'cs-2']
    ])
      expect(readFileSync(W(name), 'utf8')).toBe(body)
    expect(readFileSync(W(MOVED, D1), 'utf8')).toBe('desk-1')
    expect(readdirSync(env.desktopDir).sort()).toEqual(['Invoice.pdf', 'holiday.png'])
    expect(tree(env.cleanshotDir!)).toEqual(csBefore)
    expect(readdirSync(env.watchedFolder!).some((x) => x.includes('slidewell-partial'))).toBe(false)
    expect(readFileSync(ledgerPath(env.stateDir), 'utf8').trim().split('\n')).toHaveLength(6)
    expect(readFileSync(res.logPath, 'utf8')).toContain('"verified":true')
  })

  it('works where hard links are unsupported (exclusive reservation, then rename over our own placeholder)', async () => {
    const noLinks: BacklogEnv = { ...env, ops: { link: async () => Promise.reject(Object.assign(new Error('no links'), { code: 'ENOTSUP' })) } }
    const res = await runImport(await dryRun(noLinks), noLinks)
    expect(res).toMatchObject({ ok: true, copied: 4, moved: 2 })
    expect(readFileSync(W(MOVED, D2), 'utf8')).toBe('desk-2')
  })

  describe('interruption and resume', () => {
    const crashMoves = (on: { fail: boolean }): BacklogEnv => ({
      ...env,
      ops: {
        link: async (a, b) => {
          if (on.fail && a.startsWith(env.desktopDir)) throw Object.assign(new Error('simulated crash'), { code: 'EIO' })
          await realLink(a, b)
        }
      }
    })

    it('a re-run after an interruption between copy and move produces no duplicates, and the plan offers the pending moves', async () => {
      const on = { fail: true }
      const first = await runImport(await dryRun(crashMoves(on)), crashMoves(on))
      expect(first).toMatchObject({ ok: false, copied: 4, moved: 0, failed: 2 })
      expect(readdirSync(env.desktopDir)).toHaveLength(4)
      const plan = await dryRun(env)
      expect(plan.ok && plan.summary).toMatchObject({ pendingMoves: 2, desktop: { count: 0 }, cleanshot: { count: 0 } })
      const second = await runImport(plan, env)
      expect(second).toMatchObject({ ok: true, copied: 0, moved: 2, alreadyDone: 4 })
      expect(watchedHashes()).toHaveLength(4)
      expect(new Set(watchedHashes()).size).toBe(4)
      const plan3 = await dryRun(env)
      expect(plan3.ok && plan3.summary.desktop.count + plan3.summary.cleanshot.count + plan3.summary.pendingMoves).toBe(0)
      expect(await runImport(plan3, env)).toMatchObject({ copied: 0, moved: 0 })
      expect(watchedHashes()).toHaveLength(4)
    })

    it('a run stopped part-way resumes without duplicates', async () => {
      const ac = new AbortController()
      const first = await runImport(await dryRun(env), env, { signal: ac.signal, onProgress: (p) => p.done === 2 && ac.abort() })
      expect(first.cancelled).toBe(true)
      expect(first.copied).toBe(2)
      expect((await runImport(await dryRun(env), env)).ok).toBe(true)
      expect(watchedHashes()).toHaveLength(4)
      expect(new Set(watchedHashes()).size).toBe(4)
      expect(readdirSync(W(MOVED))).toHaveLength(2)
    })

    it('a copy that landed before its ledger line is recognised by hash, not copied again', async () => {
      put(W(C1), 'cs-1')
      expect(await runImport(await dryRun(env), env)).toMatchObject({ ok: true, reused: 1, copied: 3 })
      expect(watchedHashes()).toHaveLength(4)
    })

    it('a torn ledger tail does not swallow the next record (reviewer sequence)', async () => {
      const on = { fail: true }
      await runImport(await dryRun(crashMoves(on)), crashMoves(on)) // 4 copied records
      appendFileSync(ledgerPath(env.stateDir), '{"step":"copied","hash":"to') // the process died mid-append
      on.fail = false
      const second = await runImport(await dryRun(env), env) // appends 2 moved records
      expect(second).toMatchObject({ ok: true, moved: 2 })
      const entries = parseLedger(readFileSync(ledgerPath(env.stateDir), 'utf8'))
      expect(entries.filter((e) => e.step === 'copied')).toHaveLength(4)
      expect(entries.filter((e) => e.step === 'moved')).toHaveLength(2)
      expect(await runImport(await dryRun(env), env)).toMatchObject({ copied: 0, reused: 0 })
      expect(watchedHashes()).toHaveLength(4)
    })

    it('CleanShot resume re-copies when the recorded copy is gone or altered', async () => {
      await runImport(await dryRun(env), env)
      rmSync(W(C1)) // test setup: the recorded copy disappeared
      put(W('CleanShot 2026-10-01 at 0901.mp4'), 'altered') // and another one changed
      const res = await runImport(await dryRun(env), env)
      expect(res).toMatchObject({ ok: true, copied: 2 })
      expect(readFileSync(W(C1), 'utf8')).toBe('cs-1')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0901 (2).mp4'), 'utf8')).toBe('cs-2')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0901.mp4'), 'utf8')).toBe('altered') // never overwritten
    })
  })

  describe('never replaces anything', () => {
    it('different file under the same name: a new name is picked', async () => {
      put(W(C1), 'someone else')
      expect((await runImport(await dryRun(env), env)).ok).toBe(true)
      expect(readFileSync(W(C1), 'utf8')).toBe('someone else')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
    })

    it('race: a file created at the copy destination between check and act is kept; the copy takes the next name', async () => {
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
    })

    it('race: a file created at the move destination between check and act is kept; the original takes the next name', async () => {
      let planted = false
      const racy: BacklogEnv = {
        ...env,
        ops: {
          link: async (a, b) => {
            if (!planted && b === W(MOVED, D1)) {
              planted = true
              writeFileSync(b, 'arrived during the run')
            }
            await realLink(a, b)
          }
        }
      }
      expect(await runImport(await dryRun(racy), racy)).toMatchObject({ ok: true, moved: 2 })
      expect(readFileSync(W(MOVED, D1), 'utf8')).toBe('arrived during the run')
      expect(readFileSync(W(MOVED, 'Screenshot 2026-10-08 at 10.05.01 (2).png'), 'utf8')).toBe('desk-1')
    })

    it('race with the reservation fallback too', async () => {
      let planted = false
      const racy: BacklogEnv = {
        ...env,
        ops: {
          link: async (_a, b) => {
            if (!planted && b === W(C1)) {
              planted = true
              writeFileSync(b, 'arrived during the run')
            }
            throw Object.assign(new Error('no links'), { code: 'ENOTSUP' })
          }
        }
      }
      expect(await runImport(await dryRun(racy), racy)).toMatchObject({ ok: true, copied: 4 })
      expect(readFileSync(W(C1), 'utf8')).toBe('arrived during the run')
      expect(readFileSync(W('CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
    })

    it('a symlink planted at the temp path is neither followed nor removed', async () => {
      const victim = join(root, 'victim.txt')
      put(victim, 'precious')
      const fixed = W(`.${C1}.fixed.slidewell-partial`)
      symlinkSync(victim, fixed)
      const trap: BacklogEnv = { ...env, ops: { tempName: (t) => (t === W(C1) ? fixed : join(env.watchedFolder!, `.t-${Math.random()}.slidewell-partial`)) } }
      const res = await runImport(await dryRun(trap), trap)
      expect(res.failed).toBe(1)
      expect(readFileSync(victim, 'utf8')).toBe('precious')
      expect(lstatSync(fixed).isSymbolicLink()).toBe(true)
    })
  })

  describe('the original and the copy are re-checked right before a move', () => {
    it('an original edited mid-run is left on the Desktop', async () => {
      const editing: BacklogEnv = {
        ...env,
        hooks: { beforeMoveCheck: (item) => (item.name === D1 ? appendFileSync(item.from, ' edited') : undefined) }
      }
      const res = await runImport(await dryRun(editing), editing)
      expect(res).toMatchObject({ moved: 1, moveSkipped: 1, copied: 4 })
      expect(readFileSync(join(env.desktopDir, D1), 'utf8')).toBe('desk-1 edited')
      expect(readFileSync(W(D1), 'utf8')).toBe('desk-1')
      expect(readFileSync(res.logPath, 'utf8')).toContain('move-skipped')
    })

    it('an original whose copy was removed mid-run is left on the Desktop; a re-run copies again and moves', async () => {
      const removing: BacklogEnv = { ...env, hooks: { beforeMoveCheck: (item) => (item.name === D1 ? rmSync(W(D1)) : undefined) } }
      expect(await runImport(await dryRun(removing), removing)).toMatchObject({ moved: 1, moveSkipped: 1 })
      expect(existsSync(join(env.desktopDir, D1))).toBe(true)
      expect(await runImport(await dryRun(env), env)).toMatchObject({ ok: true, copied: 1, moved: 1 })
      expect(readFileSync(W(D1), 'utf8')).toBe('desk-1')
      expect(readFileSync(W(MOVED, D1), 'utf8')).toBe('desk-1')
    })
  })

  describe('folders are compared by realpath', () => {
    it('a watched folder that is a symlink to CleanShot history or the Desktop is refused', async () => {
      const toHistory = join(root, 'alias-history')
      symlinkSync(env.cleanshotDir!, toHistory)
      expect(await dryRun({ ...env, watchedFolder: toHistory })).toMatchObject({ ok: false, reason: 'watched-folder-overlaps' })
      const toDesktop = join(root, 'alias-desktop')
      symlinkSync(join(env.desktopDir, '..'), toDesktop)
      expect(await dryRun({ ...env, watchedFolder: join(toDesktop, 'Desktop') })).toMatchObject({ ok: false, reason: 'watched-folder-overlaps' })
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

    it('a symlink planted at the moved-folder path is refused; originals stay, nothing lands behind the link', async () => {
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, W(MOVED))
      const res = await runImport(await dryRun(env), env)
      expect(res).toMatchObject({ copied: 4, moved: 0, moveSkipped: 2 })
      expect(readdirSync(elsewhere)).toEqual([])
      expect(readdirSync(env.desktopDir)).toHaveLength(4)
    })
  })

  describe('online-only placeholders and stalled reads', () => {
    it('online-only sources are counted in the dry run and never read', async () => {
      const src = join(env.cleanshotDir!, 'media_a', C1)
      const fake: BacklogEnv = { ...env, ops: { isOnlineOnly: async (p) => p === src } }
      const plan = await dryRun(fake)
      expect(plan.ok && plan.summary).toMatchObject({ onlineOnly: 1, cleanshot: { count: 1 } })
      chmodSync(src, 0o000) // any read attempt would now fail the run
      const res = await runImport(plan, fake)
      expect(res).toMatchObject({ ok: true, failed: 0, copied: 3 })
    })

    it('a name taken by an online-only file is not read; the item is left out and reported', async () => {
      put(W(C1), 'cloud placeholder')
      chmodSync(W(C1), 0o000)
      const fake: BacklogEnv = { ...env, ops: { isOnlineOnly: async (p) => p === W(C1) } }
      const res = await runImport(await dryRun(fake), fake)
      expect(res).toMatchObject({ failed: 0, onlineOnly: 1, copied: 3 })
      expect(readFileSync(res.logPath, 'utf8')).toContain('online-only')
    })

    it('a stalled read times out, and Stop interrupts it', async () => {
      const fifo = join(root, 'stuck.fifo')
      execFileSync('mkfifo', [fifo])
      const release = (): void => closeSync(openSync(fifo, FS.O_WRONLY | FS.O_NONBLOCK)) // lets the blocked open finish
      await expect(readHashed(fifo, { idleMs: 150 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      release()
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 100)
      await expect(readHashed(fifo, { idleMs: 10_000, signal: ac.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' })
      release()
    })

    it('an ordinary file is not online-only', async () => {
      expect(await defaultIsOnlineOnly(join(env.desktopDir, D1))).toBe(false)
    })
  })

  it('the same capture on the Desktop and in CleanShot history is copied once', async () => {
    put(join(env.cleanshotDir!, 'media_d', D1), 'desk-1')
    expect(await runImport(await dryRun(env), env)).toMatchObject({ ok: true, copied: 4, alreadyDone: 1 })
    expect(watchedHashes()).toHaveLength(4)
  })

  it('retries EDEADLK / EAGAIN (OneDrive) and then succeeds', async () => {
    let fails = 3
    const flaky: BacklogEnv = {
      ...env,
      ops: {
        link: async (a, b) => {
          if (fails-- > 0) throw Object.assign(new Error('Resource deadlock avoided'), { code: fails % 2 ? 'EDEADLK' : 'EAGAIN' })
          await realLink(a, b)
        }
      }
    }
    expect(await runImport(await dryRun(flaky), flaky)).toMatchObject({ ok: true, copied: 4, moved: 2 })
  })

  it('across volumes the Desktop original stays put (logged), never copy-and-delete', async () => {
    const xdev: BacklogEnv = {
      ...env,
      ops: {
        link: async (a, b) => {
          if (a.startsWith(env.desktopDir)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
          await realLink(a, b)
        }
      }
    }
    const res = await runImport(await dryRun(xdev), xdev)
    expect(res).toMatchObject({ copied: 4, moved: 0, moveSkipped: 2 })
    expect(readdirSync(env.desktopDir)).toHaveLength(4)
    expect(readdirSync(W(MOVED))).toEqual([])
  })

  it('a file that vanished after the plan is reported, not moved', async () => {
    const plan = await dryRun(env)
    rmSync(join(env.desktopDir, D1)) // test setup only
    expect(await runImport(plan, env)).toMatchObject({ gone: 1, moved: 1, copied: 3 })
  })
})

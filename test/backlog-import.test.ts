// Execution layer on scratch folders only (~/Library/Caches/slidewell-dev-13/…), never the real
// Desktop, CleanShot history or watched folder.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { dryRun, runImport, ledgerPath, type BacklogEnv } from '../src/main/backlog-import'

const SCRATCH_ROOT = join(homedir(), 'Library', 'Caches', 'slidewell-dev-13', 'vitest')
let n = 0
let root = ''
let env: BacklogEnv

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const DATE = new Date(2026, 9, 9, 12, 0, 0)
const MOVED = 'Moved by SlideWell 2026-10-09'

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
const watchedHashes = (): string[] =>
  readdirSync(env.watchedFolder!, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => sha(readFileSync(join(env.watchedFolder!, e.name))))

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
  put(join(env.desktopDir, 'Screenshot 2026-10-08 at 10.05.01.png'), 'desk-1')
  put(join(env.desktopDir, 'CleanShot 2026-10-08 at 0801 from Safari.png'), 'desk-2')
  put(join(env.desktopDir, 'Invoice.pdf'), 'not a screenshot')
  put(join(env.desktopDir, 'holiday.png'), 'not a screenshot either')
  put(join(env.cleanshotDir!, 'media_a', 'CleanShot 2026-10-01 at 0900.png'), 'cs-1')
  put(join(env.cleanshotDir!, 'media_b', 'CleanShot 2026-10-01 at 0901.mp4'), 'cs-2')
  put(join(env.cleanshotDir!, 'media_c', 'CleanShot 2026-10-01 at 0902.cleanshot'), 'project')
  mkdirSync(env.watchedFolder!, { recursive: true })
})
afterAll(() => rmSync(SCRATCH_ROOT, { recursive: true, force: true }))

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
    // copies in the watched folder, identical bytes
    for (const [name, body] of [
      ['Screenshot 2026-10-08 at 10.05.01.png', 'desk-1'],
      ['CleanShot 2026-10-08 at 0801 from Safari.png', 'desk-2'],
      ['CleanShot 2026-10-01 at 0900.png', 'cs-1'],
      ['CleanShot 2026-10-01 at 0901.mp4', 'cs-2']
    ])
      expect(readFileSync(join(env.watchedFolder!, name), 'utf8')).toBe(body)
    // Desktop originals moved (not deleted), other Desktop files untouched, CleanShot history untouched
    expect(readFileSync(join(env.watchedFolder!, MOVED, 'Screenshot 2026-10-08 at 10.05.01.png'), 'utf8')).toBe('desk-1')
    expect(readdirSync(env.desktopDir).sort()).toEqual(['Invoice.pdf', 'holiday.png'])
    expect(tree(env.cleanshotDir!)).toEqual(csBefore)
    // no temp files left; ledger + log written outside the watched folder
    expect(readdirSync(env.watchedFolder!).some((x) => x.includes('slidewell-partial'))).toBe(false)
    expect(readFileSync(ledgerPath(env.stateDir), 'utf8').trim().split('\n')).toHaveLength(6)
    const log = readFileSync(res.logPath, 'utf8')
    expect(log).toContain('"event":"copied"')
    expect(log).toContain('"verified":true')
  })

  it('a re-run after an interruption between copy and move produces no duplicates', async () => {
    // crash on the first Desktop move: the copy exists and is in the ledger, the original is still on the Desktop
    let failMoves = true
    const crashing: BacklogEnv = {
      ...env,
      ops: {
        rename: async (a, b) => {
          if (failMoves && a.startsWith(env.desktopDir)) throw Object.assign(new Error('simulated crash'), { code: 'EIO' })
          await fsp.rename(a, b)
        }
      }
    }
    const first = await runImport(await dryRun(crashing), crashing)
    expect(first).toMatchObject({ ok: false, copied: 4, moved: 0, failed: 2 })
    expect(readdirSync(env.desktopDir)).toHaveLength(4)
    failMoves = false
    const second = await runImport(await dryRun(env), env)
    expect(second).toMatchObject({ ok: true, copied: 0, moved: 2, alreadyDone: 4 })
    const hashes = watchedHashes()
    expect(hashes).toHaveLength(4)
    expect(new Set(hashes).size).toBe(4)
    // a third run finds nothing new and copies nothing
    const plan3 = await dryRun(env)
    expect(plan3.ok && plan3.summary.desktop.count + plan3.summary.cleanshot.count).toBe(0)
    const third = await runImport(plan3, env)
    expect(third).toMatchObject({ copied: 0, moved: 0 })
    expect(watchedHashes()).toHaveLength(4)
  })

  it('a run stopped part-way resumes without duplicates', async () => {
    const ac = new AbortController()
    const first = await runImport(await dryRun(env), env, { signal: ac.signal, onProgress: (p) => p.done === 2 && ac.abort() })
    expect(first.cancelled).toBe(true)
    expect(first.copied).toBe(2)
    const second = await runImport(await dryRun(env), env)
    expect(second.ok).toBe(true)
    expect(watchedHashes()).toHaveLength(4)
    expect(new Set(watchedHashes()).size).toBe(4)
    expect(readdirSync(join(env.watchedFolder!, MOVED))).toHaveLength(2)
  })

  it('a copy that landed before the ledger line was written is recognised by hash, not copied again', async () => {
    put(join(env.watchedFolder!, 'CleanShot 2026-10-01 at 0900.png'), 'cs-1') // as if the process died right after rename
    const res = await runImport(await dryRun(env), env)
    expect(res).toMatchObject({ ok: true, reused: 1, copied: 3 })
    expect(watchedHashes()).toHaveLength(4)
  })

  it('never overwrites a different file with the same name; picks a new name', async () => {
    put(join(env.watchedFolder!, 'CleanShot 2026-10-01 at 0900.png'), 'someone else')
    const res = await runImport(await dryRun(env), env)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(env.watchedFolder!, 'CleanShot 2026-10-01 at 0900.png'), 'utf8')).toBe('someone else')
    expect(readFileSync(join(env.watchedFolder!, 'CleanShot 2026-10-01 at 0900 (2).png'), 'utf8')).toBe('cs-1')
  })

  it('the same capture on the Desktop and in CleanShot history is copied once', async () => {
    put(join(env.cleanshotDir!, 'media_d', 'Screenshot 2026-10-08 at 10.05.01.png'), 'desk-1')
    const res = await runImport(await dryRun(env), env)
    expect(res).toMatchObject({ ok: true, copied: 4, alreadyDone: 1 })
    expect(watchedHashes()).toHaveLength(4)
  })

  it('retries EDEADLK / EAGAIN (OneDrive) and then succeeds', async () => {
    let fails = 3
    const flaky: BacklogEnv = {
      ...env,
      ops: {
        rename: async (a, b) => {
          if (fails-- > 0) throw Object.assign(new Error('Resource deadlock avoided'), { code: fails % 2 ? 'EDEADLK' : 'EAGAIN' })
          await fsp.rename(a, b)
        }
      }
    }
    const res = await runImport(await dryRun(flaky), flaky)
    expect(res).toMatchObject({ ok: true, copied: 4, moved: 2 })
  })

  it('across volumes the Desktop original stays put (logged), never copy-and-delete', async () => {
    const xdev: BacklogEnv = {
      ...env,
      ops: {
        rename: async (a, b) => {
          if (a.startsWith(env.desktopDir)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
          await fsp.rename(a, b)
        }
      }
    }
    const res = await runImport(await dryRun(xdev), xdev)
    expect(res).toMatchObject({ copied: 4, moved: 0, moveSkipped: 2 })
    expect(readdirSync(env.desktopDir)).toHaveLength(4)
    expect(readFileSync(res.logPath, 'utf8')).toContain('move-skipped')
  })

  it('a file that changed after the plan is not moved without a verified copy', async () => {
    const plan = await dryRun(env)
    rmSync(join(env.desktopDir, 'Screenshot 2026-10-08 at 10.05.01.png')) // test setup only: the file vanished
    const res = await runImport(plan, env)
    expect(res).toMatchObject({ gone: 1, moved: 1, copied: 3 })
  })
})

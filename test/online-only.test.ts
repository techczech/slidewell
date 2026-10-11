// The out-of-process downloader and download authority (ticket 15), on scratch folders only
// (~/Library/Caches/slidewell-dev-15/…). The child is real; no iCloud or OneDrive file is involved.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureDownloadRoot, downloadOnlineOnly, downloadWithDeadline } from '../src/main/online-only'

const SCRATCH = join(homedir(), 'Library', 'Caches', 'slidewell-dev-15', 'vitest-online')
let n = 0
let dir = ''
let root = ''
let file = ''

beforeEach(() => {
  dir = join(SCRATCH, `${process.pid}-${n++}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'Desktop'), { recursive: true })
  root = realpathSync(join(dir, 'Desktop'))
  file = join(root, 'CleanShot 2026-10-10 at 1147from Notes with Shopping list.png')
  writeFileSync(file, 'picture bytes')
})
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function gone(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return !alive(pid)
}

describe('downloadOnlineOnly (real child)', () => {
  it('reads the file in a child and leaves it as it was', async () => {
    let pid = 0
    await downloadOnlineOnly(file, { timeoutMs: 10_000, root, onSpawn: (p) => (pid = p) })
    expect(pid).toBeGreaterThan(0)
    expect(readFileSync(file, 'utf8')).toBe('picture bytes')
  })

  it('refuses a file outside its root, a link and a FIFO before any child starts', async () => {
    let spawned = 0
    const onSpawn = (): void => void spawned++
    mkdirSync(join(dir, 'Other'))
    const other = join(dir, 'Other', 'x.png')
    writeFileSync(other, 'x')
    await expect(downloadOnlineOnly(other, { timeoutMs: 5000, root, onSpawn })).rejects.toMatchObject({ code: 'EOUTSIDE' })
    symlinkSync(other, join(root, 'link.png'))
    await expect(downloadOnlineOnly(join(root, 'link.png'), { timeoutMs: 5000, root, onSpawn })).rejects.toMatchObject({ code: 'ENOTREG' })
    execFileSync('mkfifo', [join(root, 'pipe.png')])
    await expect(downloadOnlineOnly(join(root, 'pipe.png'), { timeoutMs: 5000, root, onSpawn })).rejects.toMatchObject({ code: 'ENOTREG' })
    expect(spawned).toBe(0)
  })

  it('the child reads only the file that was checked: a swap after the check is refused', async () => {
    const swapIn = (make: () => void) => () => {
      rmSync(file)
      make()
    }
    // another regular file renamed into place: different inode
    writeFileSync(join(dir, 'other.png'), 'other')
    await expect(downloadOnlineOnly(file, { timeoutMs: 10_000, root, onSpawn: () => renameSync(join(dir, 'other.png'), file) })).rejects.toMatchObject({ code: 'ECHANGED' })
    // a symlink to a file outside the root
    writeFileSync(join(dir, 'outside.png'), 'outside')
    writeFileSync(file, 'picture bytes')
    await expect(downloadOnlineOnly(file, { timeoutMs: 10_000, root, onSpawn: swapIn(() => symlinkSync(join(dir, 'outside.png'), file)) })).rejects.toMatchObject({ code: 'ENOTREG' })
    // a FIFO (the child never blocks on it)
    rmSync(file)
    writeFileSync(file, 'picture bytes')
    await expect(downloadOnlineOnly(file, { timeoutMs: 10_000, root, onSpawn: swapIn(() => execFileSync('mkfifo', [file])) })).rejects.toMatchObject({ code: 'ENOTREG' })
  })

  it('Stop during the checks: no child is started', async () => {
    let spawned = 0
    const stop = new AbortController()
    const p = downloadOnlineOnly(file, { timeoutMs: 5000, root, signal: stop.signal, onSpawn: () => void spawned++ })
    stop.abort() // while lstat/realpath are still pending
    await expect(p).rejects.toMatchObject({ code: 'ABORT_ERR' })
    expect(spawned).toBe(0)
  })

  it('Stop kills a running child', async () => {
    let pid = 0
    const stop = new AbortController()
    const p = downloadOnlineOnly(file, {
      timeoutMs: 60_000,
      root,
      signal: stop.signal,
      onSpawn: (x) => {
        pid = x
        process.kill(x, 'SIGSTOP') // a child stuck mid-download
        setTimeout(() => stop.abort(), 100)
      }
    })
    try {
      await expect(p).rejects.toMatchObject({ code: 'ABORT_ERR' })
      expect(await gone(pid)).toBe(true)
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('the timeout kills a running child', async () => {
    let pid = 0
    const p = downloadOnlineOnly(file, {
      timeoutMs: 200,
      root,
      onSpawn: (x) => {
        pid = x
        process.kill(x, 'SIGSTOP')
      }
    })
    try {
      await expect(p).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      expect(await gone(pid)).toBe(true)
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('the deadline holds even when a downloader ignores it', async () => {
    const t0 = Date.now()
    await expect(downloadWithDeadline('/x', () => new Promise<void>(() => undefined), { timeoutMs: 30, root: '/' })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('captureDownloadRoot: download authority on canonical paths', () => {
  it('the Desktop and CleanShot\'s export folder may download; any other folder may not', async () => {
    mkdirSync(join(dir, 'CleanShot'))
    mkdirSync(join(dir, 'Other'))
    const known = { desktop: join(dir, 'Desktop'), cleanshotExport: join(dir, 'CleanShot'), primary: null }
    expect(await captureDownloadRoot(join(dir, 'Desktop'), known)).toBe(root)
    expect(await captureDownloadRoot(join(dir, 'Other', '..', 'CleanShot'), known)).toBe(realpathSync(join(dir, 'CleanShot')))
    expect(await captureDownloadRoot(join(dir, 'Other'), known)).toBeNull()
    expect(await captureDownloadRoot(join(dir, 'missing'), known)).toBeNull()
  })

  it('the primary Triage folder never may, under any alias', async () => {
    mkdirSync(join(dir, 'Triage'))
    symlinkSync(join(dir, 'Triage'), join(dir, 'Alias'))
    const primary = join(dir, 'Triage')
    expect(await captureDownloadRoot(join(dir, 'Triage', '..', 'Triage'), { desktop: null, cleanshotExport: join(dir, 'Triage', '..', 'Triage'), primary })).toBeNull()
    expect(await captureDownloadRoot(join(dir, 'Alias'), { desktop: null, cleanshotExport: join(dir, 'Alias'), primary })).toBeNull()
    expect(await captureDownloadRoot(join(dir, 'Triage'), { desktop: null, cleanshotExport: join(dir, 'Triage'), primary: join(dir, 'Alias') })).toBeNull()
  })
})

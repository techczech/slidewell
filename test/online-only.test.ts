// The out-of-process downloader and download authority (ticket 15), on scratch folders only
// (~/Library/Caches/slidewell-dev-15/…). The child is real; no iCloud or OneDrive file is involved.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { closeSync, constants as fsc, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureDownloadRoot, downloadOnlineOnly, downloadWithDeadline, openDownloaded, type FileIdentity } from '../src/main/online-only'

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
    // the replacement is made beside the file first and renamed over it, so the swap is atomic: the
    // child never finds the path missing (a gap that made this test flaky under a loaded full suite)
    const swapIn = (make: (at: string) => void) => {
      const at = join(dir, 'swap-in.png')
      rmSync(at, { force: true })
      make(at)
      return () => renameSync(at, file)
    }
    // another regular file renamed into place: different inode
    writeFileSync(join(dir, 'other.png'), 'other')
    await expect(downloadOnlineOnly(file, { timeoutMs: 10_000, root, onSpawn: () => renameSync(join(dir, 'other.png'), file) })).rejects.toMatchObject({ code: 'ECHANGED' })
    // a symlink to a file outside the root
    writeFileSync(join(dir, 'outside.png'), 'outside')
    writeFileSync(file, 'picture bytes')
    await expect(downloadOnlineOnly(file, { timeoutMs: 10_000, root, onSpawn: swapIn((at) => symlinkSync(join(dir, 'outside.png'), at)) })).rejects.toMatchObject({ code: 'ENOTREG' })
    // a FIFO (the child never blocks on it)
    rmSync(file)
    writeFileSync(file, 'picture bytes')
    await expect(downloadOnlineOnly(file, { timeoutMs: 10_000, root, onSpawn: swapIn((at) => execFileSync('mkfifo', [at])) })).rejects.toMatchObject({ code: 'ENOTREG' })
  })

  it('a folder on the way swapped for a link between the checks and the read is seen where it really is: refused', async () => {
    // Shots/a.png in the root; Elsewhere/a.png outside it. The swaps run at the test seam after each of this process's
    // checks: the file's lstat sees the outside file (Shots is a link then), the folder's real path sees the real Shots,
    // and the child is started with Shots a link again. Only the child's own check, on the folder it holds, can see that.
    const shots = join(root, 'Shots')
    mkdirSync(shots)
    const inner = join(shots, 'a.png')
    writeFileSync(inner, 'mine')
    const out = join(dir, 'Elsewhere')
    mkdirSync(out)
    writeFileSync(join(out, 'a.png'), 'not in the root')
    const parked = join(root, 'Shots-real')
    const link = join(dir, 'link-to-elsewhere')
    symlinkSync(out, link)
    const toLink = (): void => (renameSync(shots, parked), renameSync(link, shots))
    const toReal = (): void => (renameSync(shots, link), renameSync(parked, shots))
    toLink()
    let spawned = 0
    const steps: string[] = []
    await expect(
      downloadOnlineOnly(inner, { timeoutMs: 10_000, root, onSpawn: () => void spawned++, onCheck: (s) => (steps.push(s), s === 'lstat' ? toReal() : toLink()) })
    ).rejects.toMatchObject({ code: 'EOUTSIDE' })
    expect(steps).toEqual(['lstat', 'realpath'])
    expect(spawned).toBe(1) // this process's checks passed; the child refused
  })

  it('the child checks containment itself: a file whose folder is inside the root still downloads', async () => {
    mkdirSync(join(root, 'Shots'))
    const inner = join(root, 'Shots', 'a.png')
    writeFileSync(inner, 'mine')
    await downloadOnlineOnly(inner, { timeoutMs: 10_000, root })
    // a link to the root's own folder resolves inside it, so the child (which sees the real folder) accepts it too
    symlinkSync(join(root, 'Shots'), join(root, 'Alias'))
    await downloadOnlineOnly(join(root, 'Alias', 'a.png'), { timeoutMs: 10_000, root })
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

  it('a folder inside the primary Triage folder never may either', async () => {
    mkdirSync(join(dir, 'Triage', 'Exports'), { recursive: true })
    const exports = join(dir, 'Triage', 'Exports')
    expect(await captureDownloadRoot(exports, { desktop: null, cleanshotExport: exports, primary: join(dir, 'Triage') })).toBeNull()
  })
})

describe('the primary Triage subtree nested inside a download root', () => {
  it('no file in it is downloaded, by any alias', async () => {
    mkdirSync(join(root, 'Triage'))
    const inPrimary = join(root, 'Triage', 'a.png')
    writeFileSync(inPrimary, 'a')
    symlinkSync(join(root, 'Triage'), join(root, 'Alias'))
    let spawned = 0
    const opts = { timeoutMs: 5000, root, exclude: realpathSync(join(root, 'Triage')), onSpawn: () => void spawned++ }
    await expect(downloadOnlineOnly(inPrimary, opts)).rejects.toMatchObject({ code: 'EOUTSIDE' })
    await expect(downloadOnlineOnly(join(root, 'Alias', 'a.png'), opts)).rejects.toMatchObject({ code: 'EOUTSIDE' })
    expect(spawned).toBe(0)
    await downloadOnlineOnly(file, opts) // a file beside it still downloads
  })
})

// After the download the file is read through one descriptor, never reopened by path (ticket 15).
describe('openDownloaded', () => {
  const idOf = (p: string): FileIdentity => {
    const st = lstatSync(p, { bigint: true })
    return { dev: st.dev, ino: st.ino }
  }

  it('hands back the descriptor of the very file that was downloaded', async () => {
    const fh = await openDownloaded(file, { identity: idOf(file), root })
    expect((await fh.readFile('utf8')).toString()).toBe('picture bytes')
    await fh.close()
  })

  it('a symlink swapped in for the file is refused, not followed', async () => {
    mkdirSync(join(dir, 'Other'))
    writeFileSync(join(dir, 'Other', 'x.png'), 'outside bytes')
    const identity = idOf(file)
    rmSync(file)
    symlinkSync(join(dir, 'Other', 'x.png'), file)
    await expect(openDownloaded(file, { identity, root })).rejects.toMatchObject({ code: 'ENOTREG' })
  })

  it('a FIFO swapped in for the file is refused at once, without blocking', async () => {
    const identity = idOf(file)
    rmSync(file)
    execFileSync('mkfifo', [file])
    try {
      const t0 = Date.now()
      await expect(openDownloaded(file, { identity, root })).rejects.toMatchObject({ code: 'ENOTREG' })
      expect(Date.now() - t0).toBeLessThan(1000)
    } finally {
      // release a reader blocked in open() if the guard ever regresses, so the worker thread is freed
      try {
        closeSync(openSync(file, fsc.O_WRONLY | fsc.O_NONBLOCK))
      } catch {
        /* no reader waiting */
      }
    }
  }, 5000)

  it('another file at the path, or the folder moved out of the root behind a link, is refused', async () => {
    const identity = idOf(file)
    renameSync(file, `${file}.old`)
    writeFileSync(file, 'other bytes')
    await expect(openDownloaded(file, { identity, root })).rejects.toMatchObject({ code: 'ECHANGED' })
    // same file, but its folder now lives outside the root and the old path reaches it through a link
    mkdirSync(join(root, 'sub'))
    const inSub = join(root, 'sub', 'a.png')
    writeFileSync(inSub, 'a')
    const subId = idOf(inSub)
    renameSync(join(root, 'sub'), join(dir, 'moved-out'))
    symlinkSync(join(dir, 'moved-out'), join(root, 'sub'))
    await expect(openDownloaded(inSub, { identity: subId, root })).rejects.toMatchObject({ code: 'EOUTSIDE' })
  })

  it('a file inside the excluded primary subtree is refused', async () => {
    mkdirSync(join(root, 'Triage'))
    const p = join(root, 'Triage', 'a.png')
    writeFileSync(p, 'a')
    await expect(openDownloaded(p, { identity: idOf(p), root, exclude: realpathSync(join(root, 'Triage')) })).rejects.toMatchObject({ code: 'EOUTSIDE' })
  })
})

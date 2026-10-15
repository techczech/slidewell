import { describe, it, expect, afterEach, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchFromR2 } from '../src/main/storage'

// writeSync passes through to the real one unless a test sets `shortWrite`: then the first call writes only half
// the bytes asked for and every later call writes nothing (a disk that fills up mid-file)
let shortWrite = false
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  let calls = 0
  const writeSync = ((fd: number, buf: Buffer, offset?: number, length?: number, position?: number | null) => {
    if (!shortWrite) return (fs.writeSync as (...a: unknown[]) => number)(fd, buf, offset, length, position)
    calls++
    if (calls > 1) return 0
    const off = offset ?? 0
    const len = Math.floor((length ?? buf.length - off) / 2)
    return fs.writeSync(fd, buf, off, len)
  }) as typeof fs.writeSync
  return { ...fs, default: { ...fs, writeSync }, writeSync }
})

const dirs: string[] = []
afterEach(() => {
  shortWrite = false
  vi.unstubAllGlobals()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sw-r2write-'))
  dirs.push(d)
  return d
}

const cfg = { accountId: 'invented', bucket: 'b', prefix: 'slidewell' }
const creds = { accessKeyId: 'AKIDINVENTED', secretAccessKey: 'invented-secret' }

/** Stubs the network: the R2 GET answers 200, and `during` runs while the body is still downloading. */
function stubDownload(bytes: Buffer, during: () => void = () => {}): void {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      during()
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
  }))
}

describe('fetchFromR2 writes the cache file without following a link planted during the download', () => {
  it('a normal fetch lands the bytes at the destination, folders made, no temporary file left', async () => {
    const root = scratch()
    const dest = join(root, '2026', '10', 'a shot.png')
    stubDownload(Buffer.alloc(16, 7))
    expect(await fetchFromR2(cfg, creds, 'slidewell/well/2026/10/a shot.png', dest, [root])).toBe(true)
    expect(readFileSync(dest)).toEqual(Buffer.alloc(16, 7))
    expect(readdirSync(join(root, '2026', '10'))).toEqual(['a shot.png'])
  })

  it('a link planted at the destination mid-download: the outside file is unchanged', async () => {
    const root = scratch()
    const outside = scratch()
    const secret = join(outside, 'private.txt')
    writeFileSync(secret, 'keep me')
    const dest = join(root, 'a shot.png')
    stubDownload(Buffer.alloc(16, 7), () => symlinkSync(secret, dest))
    await fetchFromR2(cfg, creds, 'slidewell/well/a shot.png', dest, [root])
    expect(readFileSync(secret, 'utf8')).toBe('keep me')
    // whatever is at dest now is not the link's target written through
    expect(readdirSync(outside)).toEqual(['private.txt'])
  })

  it('the folder swapped for a link out of the roots mid-download: nothing written, no temporary file left', async () => {
    const root = scratch()
    const outside = scratch()
    const sub = join(root, 'sub')
    mkdirSync(sub)
    const dest = join(sub, 'a shot.png')
    stubDownload(Buffer.alloc(16, 7), () => {
      rmSync(sub, { recursive: true })
      symlinkSync(outside, sub)
    })
    expect(await fetchFromR2(cfg, creds, 'slidewell/well/sub/a shot.png', dest, [root])).toBe(false)
    expect(readdirSync(outside)).toEqual([])
    expect(lstatSync(sub).isSymbolicLink()).toBe(true)
  })

  it('a destination name of 240 characters fetches fine (the temporary name does not grow with it)', async () => {
    const root = scratch()
    const name = 'a'.repeat(236) + '.png'
    const dest = join(root, name)
    stubDownload(Buffer.alloc(16, 7))
    expect(await fetchFromR2(cfg, creds, `slidewell/well/${name}`, dest, [root])).toBe(true)
    expect(readFileSync(dest)).toEqual(Buffer.alloc(16, 7))
    expect(readdirSync(root)).toEqual([name])
  })

  it('a short write (disk full) is a failed fetch: nothing at the destination, no temporary file left', async () => {
    const root = scratch()
    const dest = join(root, 'a shot.png')
    stubDownload(Buffer.alloc(64 * 1024, 7))
    shortWrite = true
    expect(await fetchFromR2(cfg, creds, 'slidewell/well/a shot.png', dest, [root])).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('a link out of the roots planted where folders are still to be made: no folder is made outside', async () => {
    const root = scratch()
    const outside = scratch()
    const dest = join(root, 'linked', '2026', '10', 'a shot.png')
    stubDownload(Buffer.alloc(16, 7), () => symlinkSync(outside, join(root, 'linked')))
    expect(await fetchFromR2(cfg, creds, 'slidewell/well/linked/2026/10/a shot.png', dest, [root])).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  })

  it("a destination with a '..' after a link out of the roots: refused, nothing made outside; relative too", async () => {
    const root = scratch()
    const outer = scratch()
    const inner = join(outer, 'inner')
    mkdirSync(inner)
    symlinkSync(inner, join(root, 'link')) // link/.. on disk is `outer`, lexically it is `root`
    stubDownload(Buffer.alloc(16, 7))
    expect(await fetchFromR2(cfg, creds, 'slidewell/well/new/a.png', join(root, 'link') + '/../new/a.png', [root])).toBe(false)
    expect(readdirSync(outer)).toEqual(['inner'])
    expect(readdirSync(inner)).toEqual([])
    expect(readdirSync(root)).toEqual(['link'])
    expect(await fetchFromR2(cfg, creds, 'slidewell/well/a.png', 'new/a.png', [root])).toBe(false)
  })

  it('a nested destination three folders down still fetches into place', async () => {
    const root = scratch()
    mkdirSync(join(root, 'images'))
    const dest = join(root, 'images', '2026', '10', '15', 'shot.webp')
    stubDownload(Buffer.alloc(32, 3))
    expect(await fetchFromR2(cfg, creds, 'slidewell/well/images/2026/10/15/shot.webp', dest, [root])).toBe(true)
    expect(readFileSync(dest)).toEqual(Buffer.alloc(32, 3))
  })
})

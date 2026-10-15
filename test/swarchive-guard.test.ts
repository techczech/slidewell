import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decodeSwUrlPath, makeableUnderRoots, realUnderRoots, resolveSwUrlReal, servableUnderRoots, serveSwFile, swUrlOf, writableUnderRoots } from '../src/main/swarchive-guard'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sw-guard-'))
  dirs.push(d)
  return d
}

describe('swarchive guard (serving, clipboard copies, reveal)', () => {
  it('a normal file under a root: decoded, served, copied and revealed as before', () => {
    const root = scratch()
    mkdirSync(join(root, 'sub'))
    const f = join(root, 'sub', 'a shot.png')
    writeFileSync(f, Buffer.alloc(8, 1))
    const url = swUrlOf(f)!
    expect(decodeSwUrlPath(url, [root])).toBe(f)
    expect(realUnderRoots(f, [root])).toBe(true)
    expect(resolveSwUrlReal(url, [root])).toBe(f)
    // a root given through a link still serves its own files
    const alias = join(scratch(), 'alias')
    symlinkSync(root, alias)
    expect(resolveSwUrlReal(swUrlOf(join(alias, 'sub', 'a shot.png'))!, [alias])).toBe(join(alias, 'sub', 'a shot.png'))
  })

  it('a link inside a root that leads outside every root is neither served, copied nor revealed', () => {
    const root = scratch()
    const outside = scratch()
    writeFileSync(join(outside, 'private.png'), Buffer.alloc(8, 1))
    symlinkSync(join(outside, 'private.png'), join(root, 'link.png'))
    symlinkSync(outside, join(root, 'dirlink'))
    for (const p of [join(root, 'link.png'), join(root, 'dirlink', 'private.png')]) {
      const url = swUrlOf(p)!
      expect(decodeSwUrlPath(url, [root])).toBe(p) // written under the root: the lexical check alone lets it through
      expect(realUnderRoots(p, [root])).toBe(false) // the protocol handler refuses it
      expect(resolveSwUrlReal(url, [root])).toBeNull() // copy and reveal refuse it
    }
  })

  it('servableUnderRoots: an alias outside the roots that links into one is refused, the file under the root is not', () => {
    const root = scratch()
    writeFileSync(join(root, 'a shot.png'), Buffer.alloc(8, 1))
    const alias = join(scratch(), 'alias')
    symlinkSync(root, alias)
    expect(realUnderRoots(join(alias, 'a shot.png'), [root])).toBe(true) // the real-path check alone lets it through
    expect(servableUnderRoots(join(alias, 'a shot.png'), [root])).toBe(false)
    expect(servableUnderRoots(join(root, 'a shot.png'), [root])).toBe(true)
    expect(servableUnderRoots(join(root, 'none.png'), [root])).toBe(false)
  })

  it("makeable/writable refuse a path that is relative or has a '..' segment, whatever it resolves to", () => {
    const root = scratch()
    const inner = join(scratch(), 'inner')
    mkdirSync(inner)
    symlinkSync(inner, join(root, 'link'))
    expect(makeableUnderRoots(join(root, 'link') + '/../new', [root])).toBe(false)
    expect(writableUnderRoots(join(root, 'link') + '/../new/a.png', [root])).toBe(false)
    expect(writableUnderRoots(root + '/sub/../a.png', [root])).toBe(false)
    expect(makeableUnderRoots('new', [root])).toBe(false)
    expect(writableUnderRoots('new/a.png', [root])).toBe(false)
    expect(makeableUnderRoots(join(root, 'new', 'deeper'), [root])).toBe(true)
    expect(writableUnderRoots(join(root, 'new', 'a.png'), [root])).toBe(true)
  })

  it('outside the roots or not there: refused', () => {
    const root = scratch()
    expect(decodeSwUrlPath(swUrlOf('/etc/hosts')!, [root])).toBeNull()
    expect(resolveSwUrlReal(swUrlOf(join(root, 'none.png'))!, [root])).toBeNull()
    expect(decodeSwUrlPath('not a url', [root])).toBeNull()
  })
})

describe('swarchive guard: an R2 fetch writes only inside an allowed root', () => {
  /** A stand-in for fetchFromR2: makes the folders and writes the file, as the real one does. */
  const fetcher = () => {
    const calls: string[] = []
    const fetchInto = async (dest: string): Promise<boolean> => {
      calls.push(dest)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, Buffer.alloc(8, 2))
      return true
    }
    return { calls, fetchInto }
  }

  it('a file not here under a plain folder of the root: fetched into place and served', async () => {
    const root = scratch()
    const dest = join(root, '2026', '10', 'a shot.png')
    const f = fetcher()
    expect(writableUnderRoots(dest, [root])).toBe(true)
    expect(await serveSwFile(dest, [root], f.fetchInto)).toBe(dest)
    expect(f.calls).toEqual([dest])
  })

  it('a folder link inside the root that leads outside: refused before the fetch, nothing written outside', async () => {
    const root = scratch()
    const outside = scratch()
    symlinkSync(outside, join(root, 'linked'))
    const dest = join(root, 'linked', 'new', 'a shot.png')
    expect(decodeSwUrlPath(swUrlOf(dest)!, [root])).toBe(dest) // lexically fine: only the real-path check stops it
    const f = fetcher()
    expect(writableUnderRoots(dest, [root])).toBe(false)
    expect(await serveSwFile(dest, [root], f.fetchInto)).toBeNull()
    expect(f.calls).toEqual([])
    expect(readdirSync(outside)).toEqual([])
  })

  it('a dangling file link at the path: never written through', async () => {
    const root = scratch()
    const outside = scratch()
    const dest = join(root, 'a shot.png')
    symlinkSync(join(outside, 'target.png'), dest)
    const f = fetcher()
    expect(await serveSwFile(dest, [root], f.fetchInto)).toBeNull()
    expect(f.calls).toEqual([])
    expect(existsSync(join(outside, 'target.png'))).toBe(false)
  })

  it('a dangling folder link on the way: refused', async () => {
    const root = scratch()
    symlinkSync(join(scratch(), 'gone'), join(root, 'linked'))
    expect(writableUnderRoots(join(root, 'linked', 'x', 'a shot.png'), [root])).toBe(false)
  })

  it('no fetcher (local store, or no credentials): a file not here is not served', async () => {
    const root = scratch()
    expect(await serveSwFile(join(root, 'a shot.png'), [root], null)).toBeNull()
  })

  it('a local file that is a link leading outside: not served (the existing check stays)', async () => {
    const root = scratch()
    const outside = scratch()
    writeFileSync(join(outside, 'secret.png'), Buffer.alloc(8, 1))
    symlinkSync(join(outside, 'secret.png'), join(root, 'a shot.png'))
    const f = fetcher()
    expect(await serveSwFile(join(root, 'a shot.png'), [root], f.fetchInto)).toBeNull()
    expect(f.calls).toEqual([])
  })
})

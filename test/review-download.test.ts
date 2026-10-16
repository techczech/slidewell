import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadTargets, type DownloadTarget } from '../src/main/review/download'

// The download loop with a stubbed provider: real files in a temp folder stand in for the cloud folder, and `cloud`
// (the stub's idea of which are placeholders) decides what is "not downloaded". No real placeholder is made or read.
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function folder(names: string[]): { src: string; targets: DownloadTarget[]; cloud: Set<string> } {
  const src = mkdtempSync(join(tmpdir(), 'sw-dl-'))
  dirs.push(src)
  const cloud = new Set<string>()
  const targets = names.map((n) => {
    const abs = join(src, n)
    writeFileSync(abs, Buffer.alloc(16, 1))
    cloud.add(abs)
    return { hash: n.replace('.png', ''), abs, source: src, relPath: n, rowSource: src }
  })
  return { src, targets, cloud }
}

describe('Download them: the loop', () => {
  it('asks for each in turn, records each file as it is afterwards, and reports progress', async () => {
    const { src, targets, cloud } = folder(['a.png', 'b.png', 'c.png'])
    const flags: Array<[string, boolean]> = []
    const progress: number[] = []
    const r = await downloadTargets(
      targets,
      {
        allowedRoots: () => [src],
        dataless: (abs) => cloud.has(abs),
        download: async (abs, opts) => {
          expect(opts.identity).toBeTruthy() // the file checked is the file read
          if (!abs.endsWith('b.png')) cloud.delete(abs)
          else throw Object.assign(new Error('offline'), { code: 'EDOWNLOAD' })
        },
        setOffline: (t, offline) => flags.push([t.relPath, offline])
      },
      { onProgress: (p) => progress.push(p.current) }
    )
    expect(r).toEqual({ total: 3, done: 2, failed: 1, refused: 0, cancelled: false })
    expect(flags).toEqual([['a.png', false], ['b.png', true], ['c.png', false]])
    expect(progress).toEqual([1, 2, 3, 0])
  })

  it('gives up on a file after the timeout and goes on to the next', async () => {
    const { src, targets, cloud } = folder(['slow.png', 'fast.png'])
    const flags: Array<[string, boolean]> = []
    let aborted = false
    const t0 = Date.now()
    const r = await downloadTargets(targets, {
      allowedRoots: () => [src],
      dataless: (abs) => cloud.has(abs),
      timeoutMs: 60,
      download: (abs, opts) =>
        abs.endsWith('slow.png')
          ? new Promise<void>((_res, rej) => opts.signal?.addEventListener('abort', () => ((aborted = true), rej(new Error('killed')))))
          : Promise.resolve(void cloud.delete(abs)),
      setOffline: (t, offline) => flags.push([t.relPath, offline])
    })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(aborted).toBe(true) // the stalled read was told to stop (the real one kills its child)
    expect(r).toMatchObject({ done: 1, failed: 1, cancelled: false })
    expect(flags).toEqual([['slow.png', true], ['fast.png', false]])
  })

  it('Cancel stops the file being fetched and asks for no more', async () => {
    const { src, targets, cloud } = folder(['a.png', 'b.png', 'c.png'])
    const ctl = new AbortController()
    const asked: string[] = []
    const r = await downloadTargets(
      targets,
      {
        allowedRoots: () => [src],
        dataless: (abs) => cloud.has(abs),
        download: (abs, opts) => {
          asked.push(abs.split('/').pop()!)
          if (abs.endsWith('a.png')) return Promise.resolve(void cloud.delete(abs))
          ctl.abort() // he presses Cancel while b is coming down
          return new Promise<void>((_res, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('killed'))))
        },
        setOffline: () => undefined
      },
      { signal: ctl.signal }
    )
    expect(asked).toEqual(['a.png', 'b.png'])
    expect(r).toEqual({ total: 3, done: 1, failed: 0, refused: 0, cancelled: true })
  })

  it('refuses, without reading or recording, a path outside the allowed roots or one that leads out of its folder', async () => {
    const { src, targets, cloud } = folder(['in.png'])
    const elsewhere = mkdtempSync(join(tmpdir(), 'sw-dl-out-'))
    dirs.push(elsewhere)
    writeFileSync(join(elsewhere, 'out.png'), Buffer.alloc(16, 1))
    mkdirSync(join(src, 'sub'))
    symlinkSync(join(elsewhere, 'out.png'), join(src, 'sub', 'link.png'))
    const outside: DownloadTarget = { hash: 'out', abs: join(elsewhere, 'out.png'), source: elsewhere, relPath: 'out.png', rowSource: elsewhere }
    const linked: DownloadTarget = { hash: 'link', abs: join(src, 'sub', 'link.png'), source: src, relPath: 'sub/link.png', rowSource: src }
    cloud.add(outside.abs)
    cloud.add(linked.abs)
    const asked: string[] = []
    const flags: string[] = []
    const r = await downloadTargets([outside, linked, ...targets], {
      allowedRoots: () => [src],
      dataless: (abs) => cloud.has(abs),
      download: async (abs) => {
        asked.push(abs)
        cloud.delete(abs)
      },
      setOffline: (t) => flags.push(t.relPath)
    })
    expect(asked).toEqual([targets[0].abs])
    expect(flags).toEqual(['in.png'])
    expect(r).toEqual({ total: 3, done: 1, failed: 2, refused: 2, cancelled: false })
  })

  it('does not ask for a file that is already here, and still records it as here', async () => {
    const { src, targets } = folder(['here.png'])
    const flags: Array<[string, boolean]> = []
    let asked = 0
    const r = await downloadTargets(targets, {
      allowedRoots: () => [src],
      dataless: () => false,
      download: async () => void asked++,
      setOffline: (t, offline) => flags.push([t.relPath, offline])
    })
    expect(asked).toBe(0)
    expect(flags).toEqual([['here.png', false]])
    expect(r.done).toBe(1)
  })

  it('counts a file as downloaded only on positive evidence: one gone, unstatable or empty after the read failed, flag untouched', async () => {
    const { src, targets, cloud } = folder(['gone.png', 'empty.png', 'ok.png'])
    const flags: Array<[string, boolean]> = []
    const r = await downloadTargets(targets, {
      allowedRoots: () => [src],
      dataless: (abs) => cloud.has(abs),
      download: async (abs) => {
        cloud.delete(abs) // no longer a placeholder by the metadata test, whatever happened to it
        if (abs.endsWith('gone.png')) unlinkSync(abs) // removed while it was fetched: stat fails
        if (abs.endsWith('empty.png')) writeFileSync(abs, '') // came back with nothing in it
      },
      setOffline: (t, offline) => flags.push([t.relPath, offline])
    })
    expect(r).toEqual({ total: 3, done: 1, failed: 2, refused: 0, cancelled: false })
    expect(flags).toEqual([['ok.png', false]])
  })

  it('an empty file before it is asked for is a failure, not "already here", and is not asked for', async () => {
    const { src, targets } = folder(['empty.png'])
    writeFileSync(targets[0].abs, '')
    const flags: string[] = []
    let asked = 0
    const r = await downloadTargets(targets, {
      allowedRoots: () => [src],
      dataless: () => false, // the placeholder test says "not a placeholder" for an empty file
      download: async () => void asked++,
      setOffline: (t) => flags.push(t.relPath)
    })
    expect(asked).toBe(0)
    expect(flags).toEqual([])
    expect(r).toMatchObject({ done: 0, failed: 1 })
  })

  it('a flag that will not write does not stop the run', async () => {
    const { src, targets, cloud } = folder(['a.png', 'b.png'])
    const r = await downloadTargets(targets, {
      allowedRoots: () => [src],
      dataless: (abs) => cloud.has(abs),
      download: async (abs) => void cloud.delete(abs),
      setOffline: () => {
        throw new Error('database is locked')
      }
    })
    expect(r).toMatchObject({ done: 2, failed: 0 })
  })
})

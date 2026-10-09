import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { isVaultChangeRelevant } from '../src/main/talk-usage'
import { join } from 'node:path'
import { createSourceWatcher } from '../src/main/source-watcher'

const dir = realpathSync(mkdtempSync(join(__dirname, '.scratch-watch-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('createSourceWatcher', () => {
  it('ignores events the accept filter rejects', async () => {
    mkdirSync(join(dir, 'cache'), { recursive: true })
    let fired = 0
    const w = createSourceWatcher(() => { fired++ }, 150)
    w.setSources([{ path: dir, recursive: true, accept: (rel) => rel.endsWith('-outline.md') }])
    await sleep(200)
    writeFileSync(join(dir, 'cache', 'busy.json'), '1')
    writeFileSync(join(dir, 'notes.md'), '1')
    await sleep(600)
    expect(fired).toBe(0)
    writeFileSync(join(dir, 'a-outline.md'), '1')
    await sleep(700)
    expect(fired).toBe(1)
    w.close()
  })

  it('fires within maxWait even when events never stop', async () => {
    let fired = 0
    const w = createSourceWatcher(() => { fired++ }, 400, 900)
    w.setSources([{ path: dir, recursive: true, accept: (rel) => rel.endsWith('-outline.md') }])
    await sleep(200)
    const t0 = Date.now()
    while (Date.now() - t0 < 1500) { writeFileSync(join(dir, 'b-outline.md'), String(Date.now())); await sleep(100) }
    expect(fired).toBeGreaterThanOrEqual(1)
    w.close()
  })

  it('with the vault filter: a pool image added or removed triggers, a pool subfolder does not', async () => {
    const vault = join(dir, 'vault')
    mkdirSync(join(vault, '_assets', 'sub'), { recursive: true })
    let fired = 0
    const w = createSourceWatcher(() => { fired++ }, 150, 2000)
    w.setSources([{ path: vault, recursive: true, accept: isVaultChangeRelevant }])
    // the folders were just made: under load FSEvents can still report that (as the root's own name)
    await sleep(600)
    fired = 0
    writeFileSync(join(vault, '_assets', 'sub', 'img-1234567.webp'), '1')
    writeFileSync(join(vault, '_assets', 'notes.txt'), '1')
    await sleep(600)
    expect(fired).toBe(0)
    writeFileSync(join(vault, '_assets', 'img-aaaaaaa.webp'), '1')
    await sleep(700)
    expect(fired).toBe(1)
    rmSync(join(vault, '_assets', 'img-aaaaaaa.webp'))
    await sleep(700)
    expect(fired).toBe(2)
    w.close()
  })

  it('with the vault filter: re-pointing a symlinked pool triggers', async () => {
    const vault = join(dir, 'vault-link')
    mkdirSync(join(dir, 'pool-1'), { recursive: true })
    mkdirSync(join(dir, 'pool-2'), { recursive: true })
    mkdirSync(vault, { recursive: true })
    symlinkSync(join(dir, 'pool-1'), join(vault, '_assets'))
    let fired = 0
    const w = createSourceWatcher(() => { fired++ }, 150, 2000)
    w.setSources([{ path: vault, recursive: true, accept: isVaultChangeRelevant }])
    await sleep(600)
    fired = 0
    rmSync(join(vault, '_assets'))
    symlinkSync(join(dir, 'pool-2'), join(vault, '_assets'))
    await sleep(700)
    expect(fired).toBe(1)
    w.close()
  })
})

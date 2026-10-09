import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
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
})

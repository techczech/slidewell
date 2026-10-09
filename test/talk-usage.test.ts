import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { findTalkFiles, scanTalkUsage, loadUsage, groupUsage } from '../src/main/talk-usage'

const vault = join(__dirname, 'fixtures', 'talk-vault')
const scratch = mkdtempSync(join(__dirname, '.scratch-usage-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function fingerprint(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else h.update(p).update(readFileSync(p)).update(String(statSync(p).mtimeMs))
    }
  }
  walk(dir)
  return h.digest('hex')
}

describe('findTalkFiles', () => {
  it('finds outline files at any depth and ignores other markdown', () => {
    expect(findTalkFiles(vault)).toEqual([
      join('garden-talk', 'garden-talk-outline.md'),
      join('garden-talk', 'nested', 'hidden-outline.md'),
      join('robots-talk', 'robots-talk-outline.md')
    ])
  })
})

describe('groupUsage', () => {
  it('keeps one entry per talk with its earliest slide, talks in title order', () => {
    const m = groupUsage([
      { image_id: 'a', talk_rel_path: 'z.md', talk_title: 'Zeta', slide: '5' },
      { image_id: 'a', talk_rel_path: 'b.md', talk_title: 'Beta', slide: 9 },
      { image_id: 'a', talk_rel_path: 'b.md', talk_title: 'Beta', slide: 2 }
    ])
    expect(m.get('a')).toEqual([{ title: 'Beta', relPath: 'b.md', slide: 2 }, { title: 'Zeta', relPath: 'z.md', slide: 5 }])
  })
})

describe('scanTalkUsage', () => {
  it('records the fixture talks, reloads them, replaces on rescan, and never writes to the vault', async () => {
    const before = fingerprint(vault)
    const summary = await scanTalkUsage(scratch, vault)
    expect(summary).toEqual({ talks: 3, references: 7, images: 6 })
    const usage = await loadUsage(scratch)
    expect(usage.get('aaaaaaa')).toEqual([
      { title: 'Garden Notes', relPath: join('garden-talk', 'garden-talk-outline.md'), slide: 1 },
      { title: 'Robots in the Classroom', relPath: join('robots-talk', 'robots-talk-outline.md'), slide: 4 }
    ])
    expect(usage.get('ddddddd')?.[0].slide).toBe(2)
    expect(usage.get('ccccccc')?.length).toBe(1)
    expect(usage.has('1111111')).toBe(false)
    await scanTalkUsage(scratch, vault)
    expect((await loadUsage(scratch)).get('aaaaaaa')?.length).toBe(2)
    expect(fingerprint(vault)).toBe(before)
  })
})

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, symlinkSync, cpSync, renameSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { findTalkFiles, scanTalkUsage, loadUsage, groupUsage, talkAbsPath, wellInsideVault, isTalkOutlinePath, isVaultChangeRelevant, createScanQueue } from '../src/main/talk-usage'
import { query, run } from '../src/main/sqlite'

const fixture = join(__dirname, 'fixtures', 'talk-vault')
const scratch = realpathSync(mkdtempSync(join(__dirname, '.scratch-usage-')))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fresh = (name: string): string => { const d = join(scratch, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d }
/** A copy of the fixture vault to mutate. */
function vaultCopy(): string { const v = fresh('vault'); cpSync(fixture, v, { recursive: true }); return v }

function fingerprint(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else h.update(p).update(readFileSync(p)).update(String(statSync(p).mtimeMs))
    }
  }
  walk(dir)
  return h.digest('hex')
}

describe('findTalkFiles', () => {
  it('finds outline files at any depth and ignores other markdown', () => {
    expect(findTalkFiles(fixture)).toEqual({
      ok: true,
      files: [join('garden-talk', 'garden-talk-outline.md'), join('garden-talk', 'nested', 'hidden-outline.md'), join('robots-talk', 'robots-talk-outline.md')]
    })
  })
  it('reports failure when the vault is missing', () => {
    expect(findTalkFiles(join(scratch, 'nope')).ok).toBe(false)
  })
})

describe('path rules', () => {
  it('recognises talk outlines outside excluded folders', () => {
    expect(isTalkOutlinePath('a/b-outline.md')).toBe(true)
    for (const bad of ['a/readme.md', '_assets/x-outline.md', 'node_modules/p/x-outline.md', 'cache/x-outline.md', '../x-outline.md', '.hidden/x-outline.md', '']) expect(isTalkOutlinePath(bad)).toBe(false)
  })
  it('watches outlines and folders, not caches, the pool or other files', () => {
    expect(isVaultChangeRelevant('a/b-outline.md')).toBe(true)
    expect(isVaultChangeRelevant('some-folder')).toBe(true)
    for (const no of ['cache/x', 'cache', '_assets/img-aaaaaaa.webp', '_assets', 'node_modules/x/y.js', 'a/notes.md', '.git/index']) expect(isVaultChangeRelevant(no)).toBe(false)
  })
})

describe('groupUsage', () => {
  it('keeps one entry per talk with its earliest slide, talks in title order; 0 is unknown', () => {
    const m = groupUsage([
      { image_id: 'a', talk_rel_path: 'z.md', talk_title: 'Zeta', slide: '5' },
      { image_id: 'a', talk_rel_path: 'b.md', talk_title: 'Beta', slide: 9 },
      { image_id: 'a', talk_rel_path: 'b.md', talk_title: 'Beta', slide: 2 },
      { image_id: 'q', talk_rel_path: 'b.md', talk_title: 'Beta', slide: 0 }
    ])
    expect(m.get('a')).toEqual([{ title: 'Beta', relPath: 'b.md', slide: 2 }, { title: 'Zeta', relPath: 'z.md', slide: 5 }])
    expect(m.get('q')?.[0].slide).toBeNull()
  })
})

describe('scanTalkUsage', () => {
  it('records the fixture talks, tags the snapshot with the vault, replaces on rescan, never writes to the vault', async () => {
    const well = fresh('well')
    const before = fingerprint(fixture)
    const out = await scanTalkUsage(well, fixture)
    expect(out).toEqual({ status: 'ok', summary: { talks: 3, references: 7, images: 6 } })
    const usage = await loadUsage(well, fixture)
    expect(usage.get('aaaaaaa')).toEqual([
      { title: 'Garden Notes', relPath: join('garden-talk', 'garden-talk-outline.md'), slide: 1 },
      { title: 'Robots in the Classroom', relPath: join('robots-talk', 'robots-talk-outline.md'), slide: 3 }
    ])
    expect(usage.get('ddddddd')?.[0].slide).toBe(2)
    expect(usage.get('ccccccc')?.[0].slide).toBe(4)
    expect(usage.get('fffffff')?.[0].slide).toBe(2)
    // everything the compiler would not count is absent
    for (const no of ['9999999', '8888888', '7777777', '6666666', '5555555', '4444444', '3333333', '2222222', '1111111']) expect(usage.has(no)).toBe(false)
    const meta = await query<{ key: string; value: string }>(join(well, 'well.db'), 'SELECT key, value FROM talk_usage_meta')
    expect(meta.find((m) => m.key === 'vault_root')?.value).toBe(realpathSync(fixture))
    await scanTalkUsage(well, fixture)
    expect((await loadUsage(well, fixture)).get('aaaaaaa')?.length).toBe(2)
    expect(fingerprint(fixture)).toBe(before)
  })

  it('a snapshot of one vault is not served for another vault', async () => {
    const well = fresh('well')
    await scanTalkUsage(well, fixture)
    const other = fresh('other-vault')
    expect((await loadUsage(well, other)).size).toBe(0)
    expect((await loadUsage(well, fixture)).size).toBeGreaterThan(0)
  })

  it('keeps the previous snapshot when the vault is missing or renamed', async () => {
    const vault = vaultCopy()
    const well = fresh('well')
    expect((await scanTalkUsage(well, vault)).status).toBe('ok')
    const moved = vault + '-moved'
    renameSync(vault, moved)
    expect(await scanTalkUsage(well, vault)).toEqual({ status: 'kept', reason: 'vault-unavailable' })
    renameSync(moved, vault)
    expect((await loadUsage(well, vault)).size).toBe(6)
  })

  it('keeps the previous snapshot when a folder cannot be read', async () => {
    const vault = vaultCopy()
    const well = fresh('well')
    await scanTalkUsage(well, vault)
    const { chmodSync } = await import('node:fs')
    chmodSync(join(vault, 'robots-talk'), 0o000)
    try {
      const out = await scanTalkUsage(well, vault)
      expect(out).toMatchObject({ status: 'kept', reason: 'read-failed' })
      expect((await loadUsage(well, vault)).size).toBe(6)
    } finally { chmodSync(join(vault, 'robots-talk'), 0o755) }
  })

  it('drops a scan whose vault is no longer current', async () => {
    const well = fresh('well')
    expect(await scanTalkUsage(well, fixture, () => false)).toEqual({ status: 'kept', reason: 'superseded' })
    expect((await loadUsage(well, fixture)).size).toBe(0)
  })

  it('writes nothing when the well folder is inside the vault, directly or through a symlink', async () => {
    const vault = vaultCopy()
    const before = fingerprint(vault)
    expect(await scanTalkUsage(join(vault, 'well'), vault)).toMatchObject({ status: 'kept', reason: 'db-inside-vault' })
    const outside = fresh('outside')
    symlinkSync(vault, join(outside, 'link-to-vault'))
    expect(wellInsideVault(join(outside, 'link-to-vault', 'well'), vault)).toBe(true)
    expect(await scanTalkUsage(join(outside, 'link-to-vault'), vault)).toMatchObject({ reason: 'db-inside-vault' })
    expect(await scanTalkUsage(join(vault, 'sub', 'deeper', 'well'), vault)).toMatchObject({ reason: 'db-inside-vault' })
    expect(fingerprint(vault)).toBe(before)
    expect(wellInsideVault(fresh('elsewhere'), vault)).toBe(false)
  })

  it('a stored snapshot is replaced in one step: rows and meta always agree', async () => {
    const vault = vaultCopy()
    const well = fresh('well')
    await scanTalkUsage(well, vault)
    const talk = join(vault, 'robots-talk', 'robots-talk-outline.md')
    writeFileSync(talk, readFileSync(talk, 'utf8') + '\n### More\n![](img-1010101)\n')
    await Promise.all([scanTalkUsage(well, vault), scanTalkUsage(well, vault), scanTalkUsage(well, vault)])
    const [{ c }] = await query<{ c: number }>(join(well, 'well.db'), 'SELECT count(*) AS c FROM talk_image_use')
    const refs = await query<{ value: string }>(join(well, 'well.db'), "SELECT value FROM talk_usage_meta WHERE key = 'refs'")
    expect(Number(refs[0].value)).toBe(c)
    expect((await loadUsage(well, vault)).has('1010101')).toBe(true)
  })
})

describe('the replacement script', () => {
  it('rolls back everything when a statement in the transaction fails (.bail on)', async () => {
    const well = fresh('well')
    await scanTalkUsage(well, fixture)
    const db = join(well, 'well.db')
    await expect(run(db, ".bail on\nBEGIN IMMEDIATE;\nDELETE FROM talk_image_use;\nINSERT INTO no_such_table VALUES (1);\nCOMMIT;")).rejects.toThrow()
    expect((await loadUsage(well, fixture)).size).toBe(6)
  })
})

describe('talkAbsPath (reveal)', () => {
  it('resolves an outline inside the vault', () => {
    expect(talkAbsPath(fixture, join('robots-talk', 'robots-talk-outline.md'))).toBe(join(realpathSync(fixture), 'robots-talk', 'robots-talk-outline.md'))
  })
  it('refuses traversal, non-outlines, missing files and excluded folders', () => {
    for (const bad of ['../x-outline.md', 'garden-talk/readme.md', 'nope/x-outline.md', '_assets/img-aaaaaaa.webp', '/etc/hosts']) expect(talkAbsPath(fixture, bad)).toBeNull()
  })
  it('refuses a symlinked folder or file that leaves the vault', () => {
    const vault = vaultCopy()
    const outside = fresh('outside')
    writeFileSync(join(outside, 'secret-outline.md'), '# secret')
    symlinkSync(outside, join(vault, 'escape'))
    symlinkSync(join(outside, 'secret-outline.md'), join(vault, 'garden-talk', 'link-outline.md'))
    expect(talkAbsPath(vault, join('escape', 'secret-outline.md'))).toBeNull()
    expect(talkAbsPath(vault, join('garden-talk', 'link-outline.md'))).toBeNull()
    expect(talkAbsPath(vault, join('garden-talk', 'garden-talk-outline.md'))).not.toBeNull()
  })
})

describe('createScanQueue', () => {
  it('runs one at a time and lets a newer request replace a waiting one', async () => {
    const ran: string[] = []
    let active = 0
    let maxActive = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const q = createScanQueue<string>(async (arg) => {
      active++; maxActive = Math.max(maxActive, active)
      if (arg === 'first') await gate
      ran.push(arg)
      active--
    })
    const p1 = q.request('first')
    const p2 = q.request('second')
    const p3 = q.request('third')
    release()
    await Promise.all([p1, p2, p3])
    expect(ran).toEqual(['first', 'third'])
    expect(maxActive).toBe(1)
    await q.request('again')
    expect(ran).toEqual(['first', 'third', 'again'])
  })
})

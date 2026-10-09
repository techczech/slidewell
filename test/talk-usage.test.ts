import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, lstatSync, symlinkSync, cpSync, renameSync, writeFileSync, realpathSync, existsSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { findTalkFiles, scanTalkUsage, loadUsage, groupUsage, talkAbsPath, checkWellDb, readPool, isTalkOutlinePath, isVaultChangeRelevant } from '../src/main/talk-usage'
import { query, runScript } from '../src/main/sqlite'

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
      if (lstatSync(p).isSymbolicLink()) h.update(p).update('link')
      else if (statSync(p).isDirectory()) walk(p)
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
  it('watches outlines and folders, not caches or other files', () => {
    expect(isVaultChangeRelevant('a/b-outline.md')).toBe(true)
    expect(isVaultChangeRelevant('some-folder')).toBe(true)
    for (const no of ['cache/x', 'cache', 'node_modules/x/y.js', 'a/notes.md', '.git/index']) expect(isVaultChangeRelevant(no, 'rename')).toBe(false)
  })
  it('watches top-level pool images appearing or going, not rewrites, subfolders or other pool churn', () => {
    expect(isVaultChangeRelevant('_assets/img-aaaaaaa.webp', 'rename')).toBe(true)
    expect(isVaultChangeRelevant('_assets/img-aaaaaaa.webp', 'change')).toBe(false)
    expect(isVaultChangeRelevant('_assets', 'rename')).toBe(true) // the pool entry replaced or re-pointed
    for (const no of ['_assets/sub/img-aaaaaaa.webp', '_assets/thumbs/img-aaaaaaa.webp', '_assets/other.png', '_assets/.img-aaaaaaa.webp', 'x/_assets/img-aaaaaaa.webp']) expect(isVaultChangeRelevant(no, 'rename')).toBe(false)
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
    expect(out).toEqual({ status: 'ok', summary: { talks: 3, references: 8, images: 7 } })
    const usage = await loadUsage(well, fixture)
    expect(usage.get('aaaaaaa')).toEqual([
      { title: 'Garden Notes', relPath: join('garden-talk', 'garden-talk-outline.md'), slide: 1 },
      { title: 'Robots in the Classroom', relPath: join('robots-talk', 'robots-talk-outline.md'), slide: 3 }
    ])
    expect(usage.get('ddddddd')?.[0].slide).toBe(2)
    expect(usage.get('ccccccc')?.[0].slide).toBe(4)
    expect(usage.get('fffffff')?.[0].slide).toBe(2)
    // everything the compiler would not count is absent
    expect(usage.get('7777777')?.[0].slide).toBe(1) // a talk-local copy of a pool image counts as the pool image
    for (const no of ['0000000', '9999999', '8888888', '6666666', '5555555', '4444444', '3333333', '2222222', '1111111']) expect(usage.has(no)).toBe(false)
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
    expect((await loadUsage(well, vault)).size).toBe(7)
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
      expect((await loadUsage(well, vault)).size).toBe(7)
    } finally { chmodSync(join(vault, 'robots-talk'), 0o755) }
  })

  it('drops a scan whose vault is no longer current', async () => {
    const well = fresh('well')
    expect(await scanTalkUsage(well, fixture, () => false)).toEqual({ status: 'kept', reason: 'superseded' })
    expect((await loadUsage(well, fixture)).size).toBe(0)
  })

  it('writes nothing when the well folder is inside the vault, equal to it, or reached through a symlink', async () => {
    const vault = vaultCopy()
    mkdirSync(join(vault, 'well'))
    mkdirSync(join(vault, 'sub', 'deeper', 'well'), { recursive: true })
    const before = fingerprint(vault)
    expect(await scanTalkUsage(join(vault, 'well'), vault)).toMatchObject({ status: 'kept', reason: 'db-refused' })
    expect(await scanTalkUsage(vault, vault)).toMatchObject({ reason: 'db-refused' })
    expect(await scanTalkUsage(join(vault, 'sub', 'deeper', 'well'), vault)).toMatchObject({ reason: 'db-refused' })
    const outside = fresh('outside')
    symlinkSync(vault, join(outside, 'link-to-vault'))
    expect(checkWellDb(join(outside, 'link-to-vault'), vault)).toMatchObject({ ok: false })
    expect(await scanTalkUsage(join(outside, 'link-to-vault'), vault)).toMatchObject({ reason: 'db-refused' })
    expect(fingerprint(vault)).toBe(before)
    expect(checkWellDb(fresh('elsewhere'), vault)).toMatchObject({ ok: true })
  })

  it('refuses a symlinked well.db, dangling or not, and never creates its target', async () => {
    const vault = vaultCopy()
    const before = fingerprint(vault)
    // dangling: points at a not-yet-existing well.db inside the vault
    const well = fresh('well')
    symlinkSync(join(vault, 'well.db'), join(well, 'well.db'))
    expect(checkWellDb(well, vault)).toEqual({ ok: false, reason: 'well.db is a symbolic link' })
    expect(await scanTalkUsage(well, vault)).toMatchObject({ status: 'kept', reason: 'db-refused' })
    expect(existsSync(join(vault, 'well.db'))).toBe(false)
    // live: points at a database outside the vault; still refused
    const other = fresh('other')
    expect((await scanTalkUsage(other, vault)).status).toBe('ok')
    const well2 = fresh('well')
    symlinkSync(join(other, 'well.db'), join(well2, 'well.db'))
    expect(await scanTalkUsage(well2, vault)).toMatchObject({ reason: 'db-refused' })
    expect(fingerprint(vault)).toBe(before)
  })

  it('refuses a hard-linked well.db, whose data could also be a file inside the vault', async () => {
    const vault = vaultCopy()
    const inVault = join(vault, 'linked.db')
    writeFileSync(inVault, '')
    const before = fingerprint(vault)
    const well = fresh('well')
    linkSync(inVault, join(well, 'well.db'))
    expect(checkWellDb(well, vault)).toEqual({ ok: false, reason: 'well.db has more than one hard link' })
    expect(await scanTalkUsage(well, vault)).toMatchObject({ status: 'kept', reason: 'db-refused' })
    expect(readFileSync(inVault, 'utf8')).toBe('')
    expect(fingerprint(vault)).toBe(before)
  })

  it('a stale snapshot for vault A is ignored while vault B is current, and served again for A', async () => {
    const A = vaultCopy()
    const B = vaultCopy()
    const well = fresh('well')
    expect((await scanTalkUsage(well, A)).status).toBe('ok') // e.g. a superseded scan that still committed
    expect((await loadUsage(well, B)).size).toBe(0)
    expect((await loadUsage(well, A)).size).toBe(7)
    // the tag is the real path: A reached through a symlink is still A
    const alias = join(fresh('alias'), 'a')
    symlinkSync(A, alias)
    expect((await loadUsage(well, alias)).size).toBe(7)
  })

  it('refuses when the vault or the well folder cannot be resolved', () => {
    expect(checkWellDb(fresh('well'), join(scratch, 'no-vault'))).toMatchObject({ ok: false })
    expect(checkWellDb(join(scratch, 'no-well'), fixture)).toMatchObject({ ok: false })
  })

  it("titles and paths with ?, ', ; and newlines round-trip", async () => {
    const vault = fresh('vault')
    mkdirSync(join(vault, '_assets'))
    writeFileSync(join(vault, '_assets', 'img-aaaaaaa.webp'), 'x')
    const titles = ['What? Why?', "Dominik's talk", 'A; DROP TABLE talk_image_use; --', "?' ; ?"]
    titles.forEach((t, i) => {
      mkdirSync(join(vault, `t${i}`))
      writeFileSync(join(vault, `t${i}`, `t${i}-outline.md`), `---\ntitle: ${t}\n---\n## S\n![](img-aaaaaaa)\n`)
    })
    // a newline cannot be in a title line, but it can be in a folder name
    const odd = 'odd\n.bail off\n?'
    mkdirSync(join(vault, odd))
    writeFileSync(join(vault, odd, 'x-outline.md'), '# Multi\n## S\n![](img-aaaaaaa)\n')
    const well = fresh('well')
    expect(await scanTalkUsage(well, vault)).toEqual({ status: 'ok', summary: { talks: 5, references: 5, images: 1 } })
    const uses = (await loadUsage(well, vault)).get('aaaaaaa') ?? []
    expect(uses.map((u) => u.title).sort()).toEqual([...titles, 'Multi'].sort())
    expect(uses.find((u) => u.title === 'Multi')?.relPath).toBe(join(odd, 'x-outline.md'))
  })

  it('a NUL or lone surrogate cannot break a literal: the title round-trips as data, the table intact', async () => {
    const vault = fresh('vault')
    mkdirSync(join(vault, '_assets'))
    writeFileSync(join(vault, '_assets', 'img-aaaaaaa.webp'), 'x')
    mkdirSync(join(vault, 'n'))
    mkdirSync(join(vault, 'm'))
    writeFileSync(join(vault, 'n', 'n-outline.md'), "# A\u0000'); DROP TABLE talk_image_use; --\n## S\n![](img-aaaaaaa)\n")
    const ctl = Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join('')
    writeFileSync(join(vault, 'm', 'm-outline.md'), `# B${ctl.replace(/\n|\r/g, '')}\ud800'; --\n## S\n![](img-aaaaaaa)\n`)
    const well = fresh('well')
    expect(await scanTalkUsage(well, vault)).toEqual({ status: 'ok', summary: { talks: 2, references: 2, images: 1 } })
    const titles = ((await loadUsage(well, vault)).get('aaaaaaa') ?? []).map((u) => u.title).sort()
    expect(titles[0]).toBe("A'); DROP TABLE talk_image_use; --")
    expect(titles[1].startsWith('B\u0001')).toBe(true)
    expect(titles[1].endsWith("'; --")).toBe(true)
    const [{ c }] = await query<{ c: number }>(join(well, 'well.db'), 'SELECT count(*) AS c FROM talk_image_use')
    expect(c).toBe(2)
  })

  it('an absent pool is empty; an unavailable one keeps the previous snapshot', async () => {
    const vault = vaultCopy()
    const well = fresh('well')
    expect((await scanTalkUsage(well, vault)).status).toBe('ok')
    const parked = join(scratch, `pool-${++n}`)
    renameSync(join(vault, '_assets'), parked)
    // a symlink whose target is gone
    symlinkSync(join(scratch, 'gone'), join(vault, '_assets'))
    expect(readPool(vault)).toBeNull()
    expect(await scanTalkUsage(well, vault)).toMatchObject({ status: 'kept', reason: 'read-failed' })
    expect((await loadUsage(well, vault)).get('7777777')).toBeDefined()
    // `_assets` is a file: also unreadable, also kept
    rmSync(join(vault, '_assets'))
    writeFileSync(join(vault, '_assets'), 'not a folder')
    expect(await scanTalkUsage(well, vault)).toMatchObject({ status: 'kept', reason: 'read-failed' })
    // genuinely absent: an empty pool, so the talk-local copy no longer counts
    rmSync(join(vault, '_assets'))
    expect(readPool(vault)).toEqual(new Set())
    expect((await scanTalkUsage(well, vault)).status).toBe('ok')
    expect((await loadUsage(well, vault)).has('7777777')).toBe(false)
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
  it('rolls back everything when a statement in the transaction fails (-bail)', async () => {
    const well = fresh('well')
    await scanTalkUsage(well, fixture)
    const db = join(well, 'well.db')
    await expect(runScript(db, "BEGIN IMMEDIATE;\nDELETE FROM talk_image_use;\nINSERT INTO no_such_table VALUES (1);\nCOMMIT;")).rejects.toThrow()
    expect((await loadUsage(well, fixture)).size).toBe(7)
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

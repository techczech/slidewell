import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewService } from '../src/main/review/service'
import { realInside, realRoot } from '../src/main/review/picture'
import { SorterStore } from '../src/main/sorter/store'
import { SORTER_VERSION } from '../src/main/sorter/decide'
import { openTriage, seedProposals, teachWell } from './sorter-teach-fixture'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Copy = { hash: string; rel: string; source: string; offline?: boolean; make?: boolean }

/** A well whose triage rows are exactly `copies` (the same hash may appear more than once), each file made or not. */
function well(copies: Copy[]): string {
  const w = teachWell(0, 0, [])
  dirs.push(w)
  new SorterStore(w).close()
  const t = openTriage(w)
  try {
    const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', ?, '', ?, '2026-10-12T09:00:00', 'Invented App', '')")
    for (const c of copies) {
      mkdirSync(c.source, { recursive: true })
      if (c.make) writeFileSync(join(c.source, c.rel), Buffer.alloc(8, 1))
      row.run(c.hash, c.rel, c.rel, c.offline ? '1' : '0', c.source)
    }
  } finally {
    t.close()
  }
  seedProposals(w, [...new Set(copies.map((c) => c.hash))].map((hash) => ({ hash, proposal: 'doubtful' as const, pKeep: 0.5, sorterVersion: SORTER_VERSION })))
  return w
}

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sw-pic-'))
  dirs.push(d)
  return d
}

const service = (w: string, roots: string[] | undefined): ReviewService =>
  new ReviewService({ wellRoot: () => w, archiveRoot: () => join(w, 'archive'), sourceRoot: () => null, thumbUrl: (abs) => (abs ? `swthumb://t${abs}` : null), allowedRoots: roots ? () => roots : undefined, now: () => Date.parse('2026-10-13T10:00:00Z') })

describe('review picture choice', () => {
  it('skips a copy that is gone and shows the duplicate that exists', async () => {
    const gone = scratch()
    const here = scratch()
    const w = well([
      { hash: 'dup', rel: 'a.png', source: gone },
      { hash: 'dup', rel: 'b.png', source: here, make: true }
    ])
    const [c] = await service(w, [gone, here]).cards(['dup'])
    expect(c.picture).toBe('ok')
    expect(c.thumbUrl).toBe(`swthumb://t${join(here, 'b.png')}`)
    expect(c.revealUrl).toBe(c.thumbUrl)
  })

  it('skips a copy under a folder that is no longer allowed', async () => {
    const out = scratch()
    const inn = scratch()
    const w = well([
      { hash: 'dup', rel: 'a.png', source: out, make: true },
      { hash: 'dup', rel: 'b.png', source: inn, make: true }
    ])
    const [c] = await service(w, [inn]).cards(['dup'])
    expect(c).toMatchObject({ picture: 'ok', thumbUrl: `swthumb://t${join(inn, 'b.png')}` })
  })

  it('prefers a downloaded copy to an existing cloud placeholder, and says not-downloaded when only that exists', async () => {
    const a = scratch()
    const b = scratch()
    const w = well([
      { hash: 'cloud', rel: 'a.png', source: a, offline: true, make: true },
      { hash: 'both', rel: 'a.png', source: a, offline: true, make: true },
      { hash: 'both', rel: 'b.png', source: b, make: true }
    ])
    const cards = await service(w, [a, b]).cards(['cloud', 'both'])
    expect(cards[0]).toMatchObject({ picture: 'not-downloaded', thumbUrl: null, revealUrl: `swthumb://t${join(a, 'a.png')}`, offline: true })
    expect(cards[1]).toMatchObject({ picture: 'ok', thumbUrl: `swthumb://t${join(b, 'b.png')}` })
  })

  it('says missing, with the folder it was expected in, when no copy exists', async () => {
    const a = scratch()
    const w = well([
      { hash: 'lost', rel: 'a.png', source: a },
      { hash: 'lost', rel: 'b.png', source: a }
    ])
    const [c] = await service(w, [a]).cards(['lost'])
    expect(c).toMatchObject({ picture: 'missing', thumbUrl: null, revealUrl: null, expectedDir: a })
  })

  it('says missing when the only copy is outside the allowed folders', async () => {
    const a = scratch()
    const w = well([{ hash: 'far', rel: 'a.png', source: a, make: true }])
    const [c] = await service(w, [join(a, 'elsewhere')]).cards(['far'])
    expect(c.picture).toBe('missing')
    expect(c.thumbUrl).toBeNull()
  })

  it('says none for a hash with no file record', async () => {
    const w = well([{ hash: 'x', rel: 'a.png', source: scratch(), make: true }])
    seedProposals(w, [{ hash: 'norow', proposal: 'doubtful', pKeep: 0.5, sorterVersion: SORTER_VERSION }])
    const [c] = await service(w, undefined).cards(['norow'])
    expect(c).toMatchObject({ picture: 'none', thumbUrl: null })
  })

  it('treats a copy that is a link to a file outside every allowed folder as missing, with nothing to reveal', async () => {
    const root = scratch()
    const outside = scratch()
    writeFileSync(join(outside, 'secret.png'), Buffer.alloc(8, 1))
    const w = well([{ hash: 'link', rel: 'shot.png', source: root }])
    symlinkSync(join(outside, 'secret.png'), join(root, 'shot.png'))
    const [c] = await service(w, [root]).cards(['link'])
    expect(c).toMatchObject({ picture: 'missing', thumbUrl: null, revealUrl: null })
    // the same file reached through a folder outside the roots that links into an allowed folder: swarchive://
    // refuses it (not under a root as written), so it is not a picture either
    const viaLink = join(scratch(), 'alias')
    symlinkSync(outside, viaLink)
    const w2 = well([{ hash: 'real', rel: 'secret.png', source: viaLink }])
    const [alias] = await service(w2, [outside]).cards(['real'])
    expect(alias).toMatchObject({ picture: 'missing', thumbUrl: null, revealUrl: null })
    // given as an allowed root itself, the link folder serves its files (real paths on both sides)
    const [ok] = await service(w2, [viaLink]).cards(['real'])
    expect(ok.picture).toBe('ok')
    expect(ok.revealUrl).toBe(`swthumb://t${join(viaLink, 'secret.png')}`)
  })

  it('passes over an alias outside the roots that links into a root, and shows the real file under the root', async () => {
    const root = scratch()
    const alias = join(scratch(), 'alias') // outside every root as written; its real path is the root
    symlinkSync(root, alias)
    const w = well([
      { hash: 'dup', rel: 'b.png', source: alias },
      { hash: 'dup', rel: 'b.png', source: root, make: true }
    ])
    const [c] = await service(w, [root]).cards(['dup'])
    // swarchive:// refuses the alias (not under a root as written), so the chooser must not pick it
    expect(c).toMatchObject({ picture: 'ok', thumbUrl: `swthumb://t${join(root, 'b.png')}`, revealUrl: `swthumb://t${join(root, 'b.png')}` })
  })

  it('realInside (the reveal check): real path of the file against the real paths of the roots', () => {
    const root = scratch()
    const outside = scratch()
    writeFileSync(join(outside, 'x.png'), Buffer.alloc(8, 1))
    writeFileSync(join(root, 'y.png'), Buffer.alloc(8, 1))
    symlinkSync(join(outside, 'x.png'), join(root, 'out.png'))
    const roots = [root].map(realRoot)
    expect(realInside(roots, join(root, 'y.png'))).toBe(true)
    expect(realInside(roots, join(root, 'out.png'))).toBe(false)
    expect(realInside(roots, join(root, 'nothing.png'))).toBe(false)
    expect(realInside(roots, root)).toBe(false)
    // a root given through a link still contains its own files
    const rootLink = join(scratch(), 'r')
    symlinkSync(root, rootLink)
    expect(realInside([realRoot(rootLink)], join(root, 'y.png'))).toBe(true)
  })
})

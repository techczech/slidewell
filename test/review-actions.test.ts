import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { ReviewService } from '../src/main/review/service'
import { removeOwnedCopy } from '../src/main/review/owned-copy'
import { SorterStore, loadUndecided } from '../src/main/sorter/store'
import { listTriage, triageCounts } from '../src/main/triage'

const DAY = 86_400_000
const T0 = Date.parse('2026-10-09T08:00:00Z')

let work: string
let well: string
let src: string
let archive: string
let clock: number
let svc: ReviewService

const ORIGINALS = ['doubt1.png', 'doubt2.png', 'keep1.png', 'toss1.png', 'toss2.png', 'clip.mov']

async function png(path: string, r: number, g: number, b: number): Promise<void> {
  writeFileSync(path, await sharp({ create: { width: 24, height: 16, channels: 3, background: { r, g, b } } }).png().toBuffer())
}

/** Every file under the source folder: content hash, size, mtime, inode. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(src)) {
    const p = join(src, f)
    const st = statSync(p)
    out[f] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.size}:${st.mtimeMs}:${st.ino}`
  }
  return out
}

const decision = (hash: string): { state: string; decided_at: string | null; well_id: string | null } | undefined => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return db.prepare('SELECT state, decided_at, well_id FROM triage_decisions WHERE hash = ?').get(hash) as never
  } finally {
    db.close()
  }
}
const proposal = (hash: string): { answer: string | null; answered_at: string | null } | undefined => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return db.prepare('SELECT answer, answered_at FROM sorter_proposals WHERE hash = ?').get(hash) as never
  } finally {
    db.close()
  }
}
const wellRows = (): Array<{ id: string; rel_path: string }> => {
  if (!existsSync(join(well, 'well.db'))) return []
  const db = new DatabaseSync(join(well, 'well.db'), { readOnly: true })
  try {
    return db.prepare('SELECT id, rel_path FROM well_fts').all() as never
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'sw-review-'))
  well = join(work, 'well')
  src = join(work, 'originals')
  archive = join(work, 'archive')
  mkdirSync(join(well, '_triage-posters'), { recursive: true })
  mkdirSync(src, { recursive: true })
  // a stand-in for the macOS Vision OCR helper, so Keep runs the real ingest path offline
  mkdirSync(join(archive, 'tools', 'ocr'), { recursive: true })
  writeFileSync(join(archive, 'tools', 'ocr', 'vision_ocr'), '#!/bin/sh\necho \'{"text":"scratch ocr"}\'\n')
  chmodSync(join(archive, 'tools', 'ocr', 'vision_ocr'), 0o755)
  await png(join(src, 'doubt1.png'), 200, 10, 10)
  await png(join(src, 'doubt2.png'), 10, 200, 10)
  await png(join(src, 'keep1.png'), 10, 10, 200)
  await png(join(src, 'toss1.png'), 120, 120, 10)
  await png(join(src, 'toss2.png'), 10, 120, 120)
  writeFileSync(join(src, 'clip.mov'), Buffer.alloc(256, 7))
  writeFileSync(join(well, '_triage-posters', 'hclip.jpg'), Buffer.alloc(64, 3)) // SlideWell's poster copy
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);`)
  const row = t.prepare(
    "INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, offline, ocr_text, scanned_at, source, taken_at, app, window_title) VALUES (?, ?, ?, ?, 'png', '1', '0', ?, '0', '', '', ?, ?, ?, ?)"
  )
  row.run('hd1', 'image', 'doubt1.png', 'doubt1.png', '', src, '2026-10-08T07:42:00', 'Google Chrome', 'ChatGPT')
  row.run('hd2', 'image', 'doubt2.png', 'doubt2.png', '', src, '2026-10-08T09:00:00', 'Slack', '#sidequest-apps')
  row.run('hk1', 'image', 'keep1.png', 'keep1.png', '', src, '2026-10-07T10:00:00', 'Claude', 'New chat')
  row.run('ht1', 'image', 'toss1.png', 'toss1.png', '', src, '2026-10-06T10:00:00', 'Terminal', 'zsh')
  row.run('ht2', 'image', 'toss2.png', 'toss2.png', '', src, '2026-10-05T10:00:00', 'Finder', 'Downloads')
  row.run('hclip', 'video', 'clip.mov', 'clip.mov', '_triage-posters/hclip.jpg', src, '', '', '')
  t.close()
  const store = new SorterStore(well)
  const p = (hash: string, proposal: 'keep' | 'throwaway' | 'doubtful') => ({ hash, proposal, confidence: 0.6, pKeep: 0.5, reason: `reason for ${hash}`, rule: null })
  store.writeProposals([p('hd1', 'doubtful'), p('hd2', 'doubtful'), p('hk1', 'keep'), p('ht1', 'throwaway'), p('ht2', 'throwaway'), p('hclip', 'throwaway')], 'test', null)
  store.close()
  // proposals were written "now"; put them at T0 so the injected clock drives the 30 days
  const db = new DatabaseSync(join(well, 'triage.db'))
  db.prepare('UPDATE sorter_proposals SET proposed_at = ?, throwaway_since = CASE WHEN proposal = ? THEN ? END').run(new Date(T0).toISOString(), 'throwaway', new Date(T0).toISOString())
  db.close()
  clock = T0
  svc = new ReviewService({ wellRoot: () => well, archiveRoot: () => archive, sourceRoot: () => src, thumbUrl: (p) => p, now: () => clock })
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('review action layer: his choices', () => {
  it('opens on the doubtful queue, newest first; sorted confidently = proposals he has not overridden', async () => {
    const o = await svc.overview()
    expect(o.needALook).toBe(2)
    expect(o.queue.map((c) => c.hash)).toEqual(['hd2', 'hd1'])
    expect(o.queue[1]).toMatchObject({ filename: 'doubt1.png', app: 'Google Chrome', windowTitle: 'ChatGPT', reason: 'reason for hd1', pile: 'doubtful' })
    expect(o.confident).toEqual({ kept: 1, throwaway: 3 })
  })

  it('Keep writes his decision, promotes into the well through the ingest path and marks the proposal answered', async () => {
    const r = await svc.act('hd1', 'keep')
    expect(r).toMatchObject({ ok: true, pile: 'kept' })
    const d = decision('hd1')!
    expect(d.state).toBe('included')
    expect(d.well_id).toBeTruthy()
    expect(wellRows().map((w) => w.id)).toEqual([d.well_id])
    expect(existsSync(join(well, wellRows()[0].rel_path))).toBe(true)
    expect(proposal('hd1')).toMatchObject({ answer: 'keep', answered_at: new Date(T0).toISOString() })
    const o = await svc.overview()
    expect(o.needALook).toBe(1)
    expect(o.confident).toEqual({ kept: 1, throwaway: 3 }) // his answer is not counted as the sorter's
  })

  it('Throwaway is a record: his decision with the clock from now; bin in 30 days, then the Bin after 30 days', async () => {
    await svc.act('hd2', 'throwaway')
    expect(decision('hd2')).toMatchObject({ state: 'excluded', decided_at: new Date(T0).toISOString(), well_id: null })
    expect(proposal('hd2')?.answer).toBe('throwaway')
    let piles = await svc.piles()
    expect(piles.throwaway.items.find((c) => c.hash === 'hd2')).toMatchObject({ by: 'you', binInDays: 30 })
    clock = T0 + 29 * DAY
    piles = await svc.piles()
    expect(piles.throwaway.items.find((c) => c.hash === 'hd2')?.binInDays).toBe(1)
    clock = T0 + 30 * DAY
    piles = await svc.piles()
    expect(piles.bin.items.map((c) => c.hash).sort()).toEqual(['hclip', 'hd2', 'ht1', 'ht2'])
    expect(piles.throwaway.total).toBe(0)
  })

  it('Rescue from Throwaway and from the Bin keeps the item', async () => {
    const r1 = await svc.act('ht1', 'rescue')
    expect(r1).toMatchObject({ ok: true, pile: 'kept' })
    expect(decision('ht1')?.state).toBe('included')
    clock = T0 + 31 * DAY
    const r2 = await svc.act('ht2', 'rescue')
    expect(r2).toMatchObject({ ok: true, pile: 'kept' })
    const piles = await svc.piles()
    expect(piles.kept.items.filter((c) => c.by === 'you').map((c) => c.hash).sort()).toEqual(['ht1', 'ht2'])
    expect(piles.bin.items.map((c) => c.hash)).toEqual(['hclip'])
    expect((await svc.act('hd1', 'rescue')).ok).toBe(false) // not in Throwaway or the Bin
  })

  it('Undo restores the exact earlier decision and answer, and removes only the well copy that Keep created', async () => {
    await svc.act('hd1', 'keep')
    const copy = join(well, wellRows()[0].rel_path)
    expect(existsSync(copy)).toBe(true)
    await svc.act('hd2', 'throwaway')
    expect((await svc.undo()).hash).toBe('hd2')
    expect(decision('hd2')).toBeUndefined()
    expect(proposal('hd2')).toMatchObject({ answer: null, answered_at: null })
    expect((await svc.undo()).hash).toBe('hd1')
    expect(decision('hd1')).toBeUndefined()
    expect(existsSync(copy)).toBe(false)
    expect(wellRows()).toEqual([])
    expect((await svc.overview()).needALook).toBe(2)
    expect((await svc.undo()).ok).toBe(false)
  })

  it('Undo of a Keep leaves a well copy that existed before it', async () => {
    await svc.act('hd1', 'keep') // creates the well copy
    const rel = wellRows()[0].rel_path
    await svc.act('hd1', 'throwaway') // his throwaway carries the well id
    expect(decision('hd1')).toMatchObject({ state: 'excluded', well_id: wellRows()[0].id })
    await svc.act('hd1', 'rescue') // the copy already exists: this Keep created nothing
    await svc.undo()
    expect(existsSync(join(well, rel))).toBe(true)
    expect(decision('hd1')).toMatchObject({ state: 'excluded', well_id: wellRows()[0].id })
  })
})

describe('review action layer: no original is ever deleted or moved', () => {
  it('keep, throwaway, rescue, undo, the 30-day move and Empty Bin leave every original byte-identical in place', async () => {
    const before = snapshot()
    expect(Object.keys(before).sort()).toEqual([...ORIGINALS].sort())
    await svc.act('hd1', 'keep')
    await svc.act('hd2', 'throwaway')
    await svc.act('hk1', 'throwaway') // the sorter's keep, overridden
    await svc.undo()
    await svc.act('hk1', 'keep')
    await svc.act('hk1', 'throwaway') // kept into the well, then thrown away: its well copy is SlideWell's
    await svc.act('ht1', 'rescue')
    clock = T0 + 45 * DAY
    const piles = await svc.piles()
    expect(piles.bin.items.map((c) => c.hash).sort()).toEqual(['hclip', 'hd2', 'hk1', 'ht2'])
    const hk1Copy = join(well, wellRows().find((w) => w.id === decision('hk1')!.well_id)!.rel_path)
    expect(existsSync(hk1Copy)).toBe(true)
    const res = await svc.emptyBin(piles.bin.token)
    expect(res).toMatchObject({ ok: true, emptied: 4, copiesRefused: 0 })
    expect(res.copiesRemoved).toBeGreaterThanOrEqual(3) // hk1's well copy + sidecar, hclip's poster
    expect(existsSync(hk1Copy)).toBe(false)
    expect(existsSync(join(well, '_triage-posters', 'hclip.jpg'))).toBe(false)
    expect(snapshot()).toEqual(before)
  })
})

describe('review action layer: Empty Bin', () => {
  it('needs the token of the Bin he confirmed; refuses when the Bin changed', async () => {
    clock = T0 + 30 * DAY
    const piles = await svc.piles()
    expect(piles.bin.total).toBe(3)
    expect(await svc.emptyBin('')).toMatchObject({ ok: false, emptied: 0 })
    await svc.act('ht1', 'rescue') // the Bin changes after he looked
    expect(await svc.emptyBin(piles.bin.token)).toMatchObject({ ok: false, emptied: 0 })
    expect(decision('ht2')).toBeUndefined()
  })

  it('removes SlideWell records only: proposal gone, hash-only emptied marker, never proposed again, out of every pile', async () => {
    clock = T0 + 30 * DAY
    const piles = await svc.piles()
    await svc.emptyBin(piles.bin.token)
    for (const h of ['ht1', 'ht2', 'hclip']) {
      expect(decision(h)).toMatchObject({ state: 'emptied', well_id: null })
      expect(proposal(h)).toBeUndefined()
    }
    expect(loadUndecided(well).map((s) => s.hash)).not.toContain('ht1')
    const after = await svc.piles()
    expect(after.bin.total + after.throwaway.total).toBe(0)
    expect(after.kept.items.map((c) => c.hash)).toEqual(['hk1'])
    expect((await svc.act('ht1', 'rescue')).ok).toBe(false)
    expect(existsSync(join(src, 'toss1.png'))).toBe(true)
  })

  it('a well record that points outside the copy folders is not followed: the original stays', async () => {
    const t = new DatabaseSync(join(well, 'triage.db'))
    t.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES ('ht1', 'excluded', ?, 'evil1')").run(new Date(T0).toISOString())
    t.close()
    const w = new DatabaseSync(join(well, 'well.db'))
    w.exec('CREATE VIRTUAL TABLE well_fts USING fts5(id UNINDEXED, slug UNINDEXED, ext UNINDEXED, rel_path UNINDEXED, root UNINDEXED, source UNINDEXED, tags, notes, ocr_text, added_at UNINDEXED)')
    w.prepare("INSERT INTO well_fts (id, rel_path, root, source) VALUES ('evil1', ?, 'well', 'screenshot')").run(join('..', 'originals', 'toss1.png'))
    w.close()
    const before = snapshot()
    clock = T0 + 30 * DAY
    const res = await svc.emptyBin((await svc.piles()).bin.token)
    expect(res.ok).toBe(true)
    expect(res.copiesRefused).toBeGreaterThanOrEqual(1)
    expect(snapshot()).toEqual(before)
  })
})

describe('Triage list: throwaways stay findable until binned', () => {
  it('lists young throwaways with their proposal, hides binned and emptied items', async () => {
    await svc.act('hd2', 'throwaway')
    let hashes = (await listTriage(well, '', 'all', 'scanned', 50, 0, T0 + DAY)).map((r) => r.hash)
    expect(hashes).toEqual(expect.arrayContaining(['hd2', 'ht1', 'ht2', 'hclip']))
    const row = (await listTriage(well, '', 'all', 'scanned', 50, 0, T0 + DAY)).find((r) => r.hash === 'ht1')!
    expect(row).toMatchObject({ proposal: 'throwaway', throwaway_since: new Date(T0).toISOString() })
    hashes = (await listTriage(well, '', 'all', 'scanned', 50, 0, T0 + 31 * DAY)).map((r) => r.hash)
    expect(hashes.sort()).toEqual(['hd1', 'hk1'])
    clock = T0 + 31 * DAY
    await svc.emptyBin((await svc.piles()).bin.token)
    hashes = (await listTriage(well, '', 'all', 'scanned', 50, 0, T0 + 31 * DAY)).map((r) => r.hash)
    expect(hashes.sort()).toEqual(['hd1', 'hk1'])
    expect((await triageCounts(well)).total).toBe(2)
  })
})

describe('removeOwnedCopy: the only file deletion in review', () => {
  it('deletes a regular file inside a copy folder', () => {
    mkdirSync(join(well, 'images'), { recursive: true })
    writeFileSync(join(well, 'images', 'a--1.webp'), 'x')
    expect(removeOwnedCopy(join(well, 'images', 'a--1.webp'), [join(well, 'images')])).toMatchObject({ removed: true })
  })

  it('refuses a symlink to an original, a hard link to an original, a path escaping with .., a folder, and anything outside', () => {
    const images = join(well, 'images')
    mkdirSync(images, { recursive: true })
    const before = snapshot()
    symlinkSync(join(src, 'keep1.png'), join(images, 'link.png'))
    linkSync(join(src, 'doubt1.png'), join(images, 'hard.png'))
    mkdirSync(join(images, 'sub'))
    expect(removeOwnedCopy(join(images, 'link.png'), [images])).toMatchObject({ removed: false, reason: 'symlink' })
    expect(removeOwnedCopy(join(images, 'hard.png'), [images])).toMatchObject({ removed: false, reason: 'linked' })
    expect(removeOwnedCopy(join(images, '..', '..', 'originals', 'toss1.png'), [images])).toMatchObject({ removed: false, reason: 'outside' })
    expect(removeOwnedCopy(join(src, 'toss2.png'), [images])).toMatchObject({ removed: false, reason: 'outside' })
    expect(removeOwnedCopy(join(images, 'sub'), [images])).toMatchObject({ removed: false, reason: 'not-a-file' })
    expect(removeOwnedCopy(images, [images])).toMatchObject({ removed: false })
    expect(snapshot()).toEqual(before)
  })

  it('refuses a file reached through a symlinked folder that resolves outside the copy folder', () => {
    const images = join(well, 'images')
    mkdirSync(images, { recursive: true })
    symlinkSync(src, join(images, 'dir'))
    const before = snapshot()
    expect(removeOwnedCopy(join(images, 'dir', 'toss1.png'), [images])).toMatchObject({ removed: false, reason: 'outside' })
    expect(snapshot()).toEqual(before)
  })
})

describe('the sorter cannot write his decisions', () => {
  it('no sorter source writes triage_decisions', () => {
    const dir = join(__dirname, '..', 'src', 'main', 'sorter')
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8')
      expect(text, f).not.toMatch(/(INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+triage_decisions/i)
      expect(text, f).not.toMatch(/putTriageDecision|setTriageDecision|promoteTriageHashes|importSelectedTriage/)
    }
  })
})

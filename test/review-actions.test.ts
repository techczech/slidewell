import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { ReviewService } from '../src/main/review/service'
import { guardedHandle } from '../src/main/ipc-guard'
import { wellByIds, searchWell } from '../src/main/well'
import { SorterStore, loadUndecided } from '../src/main/sorter/store'
import { listTriage, triageCounts, putTriageDecision, setTriageDecision, writeEmptiedMarkers, promoteTriageHashes } from '../src/main/triage'

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

/** Every file under the scratch folder (originals, the well, posters): nothing may disappear or change. */
function treeSnapshot(dir = work, out: Record<string, string> = {}): Record<string, string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const st = statSync(p)
    if (st.isDirectory()) treeSnapshot(p, out)
    else if (!/\.db(-journal)?$/.test(f)) out[p] = `${st.size}:${st.mtimeMs}:${st.ino}`
  }
  return out
}

/** n more items the sorter called throwaway long enough ago to be in the Bin. */
function addBinItems(n: number): string[] {
  const db = new DatabaseSync(join(well, 'triage.db'))
  const put = db.prepare("INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, sorter_version, proposed_at, throwaway_since) VALUES (?, 'throwaway', 0.95, 0.05, 'old', 'test', ?, ?)")
  const old = new Date(T0 - 40 * DAY).toISOString()
  const hashes: string[] = []
  db.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    const h = `hb${String(i).padStart(4, '0')}`
    put.run(h, old, old)
    hashes.push(h)
  }
  db.exec('COMMIT')
  db.close()
  return hashes
}

const contentHash = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)

/** A doubtful screenshot scanned the way triage scans: its decision key is the file's content hash. */
async function addScannedItem(name: string, rgb: [number, number, number]): Promise<string> {
  await png(join(src, name), ...rgb)
  const hash = contentHash(join(src, name))
  const db = new DatabaseSync(join(well, 'triage.db'))
  db.prepare(
    "INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, offline, ocr_text, scanned_at, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', '1', '0', '', '0', '', '', ?, '2026-10-01T10:00:00', 'Preview', ?)"
  ).run(hash, name, name, src, name)
  db.prepare("INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, sorter_version, proposed_at) VALUES (?, 'doubtful', 0.5, 0.5, 'unsure', 'test', ?)").run(hash, new Date(T0).toISOString())
  db.close()
  return hash
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
    const h = await addScannedItem('scanned.png', [140, 140, 20]) // keyed by its content hash, as triage keys it
    const r = await svc.act(h, 'keep')
    expect(r).toMatchObject({ ok: true, pile: 'kept' })
    const d = decision(h)!
    expect(d.state).toBe('included')
    expect(d.well_id).toBeTruthy()
    expect(wellRows().map((w) => w.id)).toEqual([d.well_id])
    expect(existsSync(join(well, wellRows()[0].rel_path))).toBe(true)
    expect(proposal(h)).toMatchObject({ answer: 'keep', answered_at: new Date(T0).toISOString() })
    const o = await svc.overview()
    expect(o.needALook).toBe(2)
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

  it('Undo restores the exact earlier decision and answer; the well copy and record a Keep made stay', async () => {
    await svc.act('hd1', 'keep')
    const rel = wellRows()[0].rel_path
    await svc.act('hd2', 'throwaway')
    expect((await svc.undo()).hash).toBe('hd2')
    expect(decision('hd2')).toBeUndefined()
    expect(proposal('hd2')).toMatchObject({ answer: null, answered_at: null })
    expect((await svc.undo()).hash).toBe('hd1')
    expect(decision('hd1')).toBeUndefined()
    expect(existsSync(join(well, rel))).toBe(true) // review never deletes a file
    expect(wellRows().length).toBe(1) // nor a well record
    expect((await svc.overview()).needALook).toBe(2)
    expect((await svc.undo()).ok).toBe(false)
  })

  it('Undo keeps its history entry when the restore fails, so ⌘Z can retry', async () => {
    await svc.act('hd2', 'throwaway')
    const db = join(well, 'triage.db')
    chmodSync(db, 0o444) // a write failure
    try {
      const r = await svc.undo()
      expect(r.ok).toBe(false)
      expect(decision('hd2')?.state).toBe('excluded')
      expect((await svc.overview()).canUndo).toBe(true)
    } finally {
      chmodSync(db, 0o644)
    }
    expect(await svc.undo()).toMatchObject({ ok: true, hash: 'hd2' })
    expect(decision('hd2')).toBeUndefined()
    expect((await svc.overview()).canUndo).toBe(false)
  })
})

describe('review action layer: no file is ever deleted or moved', () => {
  it('keep, throwaway, rescue, undo, the 30-day move and Empty Bin delete or move no file at all; originals byte-identical', async () => {
    const before = snapshot()
    expect(Object.keys(before).sort()).toEqual([...ORIGINALS].sort())
    await svc.act('hd1', 'keep')
    await svc.act('hd2', 'throwaway')
    await svc.act('hk1', 'throwaway') // the sorter's keep, overridden
    await svc.undo()
    await svc.act('hk1', 'keep')
    await svc.act('hk1', 'throwaway') // kept into the well, then thrown away
    await svc.act('ht1', 'rescue')
    clock = T0 + 45 * DAY
    const piles = await svc.piles()
    expect(piles.bin.items.map((c) => c.hash).sort()).toEqual(['hclip', 'hd2', 'hk1', 'ht2'])
    const tree = treeSnapshot()
    const res = await svc.emptyBin(piles.bin.token)
    expect(res).toMatchObject({ ok: true, emptied: 4, changed: 0 })
    expect(treeSnapshot()).toEqual(tree) // well copies, sidecars, posters: all still there
    expect(snapshot()).toEqual(before)
  })

  it("a kept-then-binned item's well record is hidden, not deleted", async () => {
    const h = await addScannedItem('kept-binned.png', [70, 20, 200])
    await svc.act(h, 'keep')
    const wellId = decision(h)!.well_id!
    await svc.act(h, 'throwaway')
    clock = T0 + 31 * DAY
    await svc.emptyBin((await svc.piles()).bin.token)
    expect(decision(h)).toMatchObject({ state: 'emptied', well_id: wellId })
    expect(wellRows().map((w) => w.id)).toContain(wellId)
    expect(await wellByIds(well, [wellId])).toEqual([])
    expect((await searchWell(well, '', 60)).map((r) => r.id)).not.toContain(wellId)
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

  it('writes only the permanent emptied marker: never proposed again, out of every pile', async () => {
    clock = T0 + 30 * DAY
    await svc.emptyBin((await svc.piles()).bin.token)
    for (const h of ['ht1', 'ht2', 'hclip']) expect(decision(h)).toMatchObject({ state: 'emptied' })
    expect(proposal('ht1')).toBeDefined() // records stay; the marker hides them
    expect(loadUndecided(well).map((s) => s.hash)).not.toContain('ht1')
    const after = await svc.piles()
    expect(after.bin.total + after.throwaway.total).toBe(0)
    expect(after.kept.items.map((c) => c.hash)).toEqual(['hk1'])
    expect((await svc.act('ht1', 'rescue')).ok).toBe(false)
  })

  it('race: a Bin item changed to selected during Empty Bin is left alone and reported', async () => {
    clock = T0 + 30 * DAY
    const bin = (await svc.piles()).bin.items.map((c) => ({ hash: c.hash, decision: null }))
    expect(bin.map((b) => b.hash).sort()).toEqual(['hclip', 'ht1', 'ht2'])
    // Empty Bin has taken its snapshot; meanwhile Triage selects one of them
    await putTriageDecision(well, 'ht1', { state: 'selected', decidedAt: new Date(clock).toISOString(), wellId: null })
    const r = writeEmptiedMarkers(well, bin, clock)
    expect(r.emptied.sort()).toEqual(['hclip', 'ht2'])
    expect(r.changed).toEqual(['ht1'])
    expect(decision('ht1')?.state).toBe('selected')
  })

  it('race: an item whose clock no longer says Bin at write time is left alone', async () => {
    await svc.act('hd2', 'throwaway')
    clock = T0 + 30 * DAY
    const snap = [{ hash: 'hd2', decision: { state: 'excluded', decidedAt: new Date(T0).toISOString(), wellId: null } }]
    expect(writeEmptiedMarkers(well, snap, T0 + 29 * DAY)).toEqual({ emptied: [], changed: ['hd2'] })
    expect(writeEmptiedMarkers(well, snap, T0 + 30 * DAY)).toEqual({ emptied: ['hd2'], changed: [] })
  })
})

describe('review: more than 500 items', () => {
  it('pages through every item of a 600-item Bin and Empty Bin hides exactly that many', async () => {
    const extra = addBinItems(600)
    clock = T0 + 1 * DAY
    const piles = await svc.piles()
    expect(piles.bin.total).toBe(600)
    expect(piles.bin.items.length).toBe(60)
    const seen = new Set(piles.bin.items.map((c) => c.hash))
    let next: string | null = piles.bin.next
    while (next !== null) {
      const pg = await svc.page('bin', next, 500)
      pg.items.forEach((c) => seen.add(c.hash))
      next = pg.next
    }
    expect(seen.size).toBe(600)
    expect([...seen].sort()).toEqual(extra.sort())
    const r = await svc.emptyBin(piles.bin.token)
    expect(r).toMatchObject({ ok: true, emptied: 600, changed: 0 })
    expect((await svc.piles()).bin.total).toBe(0)
  })

  it('pages the kept pile past 500 the same way', async () => {
    const db = new DatabaseSync(join(well, 'triage.db'))
    const put = db.prepare("INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, sorter_version, proposed_at) VALUES (?, 'keep', 0.9, 0.9, 'kept', 'test', ?)")
    db.exec('BEGIN')
    for (let i = 0; i < 700; i++) put.run(`hkp${i}`, new Date(T0).toISOString())
    db.exec('COMMIT')
    db.close()
    let got = 0
    let next: string | null = null
    do {
      const pg = await svc.page('kept', next, 500)
      got += pg.items.length
      next = pg.next
    } while (next !== null)
    expect(got).toBe(701)
  })
})

describe('review: keyset paging is stable between pages', () => {
  it('an insert before and after the cursor and a rescue between pages: no duplicate, no unchanged item skipped', async () => {
    const original = addBinItems(10) // hb0000..hb0009; same clock, no file times, so ordered by hash
    clock = T0 + DAY
    const first = await svc.page('bin', null, 4)
    expect(first.items.map((c) => c.hash)).toEqual(original.slice(0, 4))
    // between pages: one new item sorts before the cursor, one after; one already-seen item is rescued
    const db = new DatabaseSync(join(well, 'triage.db'))
    const old = new Date(T0 - 40 * DAY).toISOString()
    const put = db.prepare("INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, sorter_version, proposed_at, throwaway_since) VALUES (?, 'throwaway', 0.95, 0.05, 'old', 'test', ?, ?)")
    put.run('hb0001a', old, old)
    put.run('hb0005a', old, old)
    db.close()
    await svc.act('hb0000', 'rescue')
    const seen = first.items.map((c) => c.hash)
    let next = first.next
    while (next) {
      const pg = await svc.page('bin', next, 4)
      seen.push(...pg.items.map((c) => c.hash))
      next = pg.next
    }
    expect(new Set(seen).size).toBe(seen.length) // never a duplicate
    for (const h of original) expect(seen).toContain(h) // no unchanged item skipped
    expect(seen).toContain('hb0005a') // a new item after the cursor appears
    // (hb0001a, inserted before the cursor, appears on the next fresh load)
  })
})

describe('Triage import and the emptied marker', () => {
  it('an item emptied while its ingest runs stays emptied; the import reports it skipped', async () => {
    // the stand-in OCR runs mid-ingest; here it plays Empty Bin landing at that moment
    const slow = join(work, 'archive-race')
    mkdirSync(join(slow, 'tools', 'ocr'), { recursive: true })
    writeFileSync(
      join(slow, 'tools', 'ocr', 'vision_ocr'),
      `#!/bin/sh\n/usr/bin/sqlite3 '${join(well, 'triage.db')}' "UPDATE triage_decisions SET state = 'emptied' WHERE hash = '${await addScannedItem('race.png', [5, 90, 160])}'"\necho '{"text":""}'\n`
    )
    chmodSync(join(slow, 'tools', 'ocr', 'vision_ocr'), 0o755)
    const h = contentHash(join(src, 'race.png'))
    await putTriageDecision(well, h, { state: 'selected', decidedAt: new Date(T0).toISOString(), wellId: null })
    const r = await promoteTriageHashes(slow, well, src, [h])
    expect(r.imported).toEqual([])
    expect(r.skipped).toBe(1)
    expect(decision(h)?.state).toBe('emptied')
    // the copy ingest made is hidden by content identity, not deleted
    const ids = wellRows().map((w) => w.id)
    expect(ids.length).toBe(1)
    expect(await wellByIds(well, ids)).toEqual([])
    expect(await searchWell(well, '', 60)).toEqual([])
  })
})

describe('hidden by content identity, whatever happened to the well id', () => {
  it('ingest records the content hash of the source file; a decision key that is not that hash is not linked', async () => {
    await svc.act('hd1', 'keep') // the fixture's key 'hd1' is not the file's content hash
    expect(decision('hd1')).toMatchObject({ state: 'included', well_id: null }) // so the decision names no well copy
    const wellId = wellRows()[0].id
    const content = createHash('sha256').update(readFileSync(join(src, 'doubt1.png'))).digest('hex').slice(0, 12)
    const db = new DatabaseSync(join(well, 'well.db'), { readOnly: true })
    const links = db.prepare('SELECT source_hash FROM well_sources WHERE well_id = ?').all(wellId) as Array<{ source_hash: string }>
    db.close()
    expect(links.map((l) => l.source_hash)).toEqual([content])
  })

  const hiddenEverywhere = async (wellId: string): Promise<void> => {
    expect(wellRows().map((w) => w.id)).toContain(wellId) // the record stays
    expect(await wellByIds(well, [wellId])).toEqual([]) // picture-search resolve path
    expect((await searchWell(well, '', 60)).map((r) => r.id)).not.toContain(wellId)
    expect((await searchWell(well, 'scratch ocr', 60)).map((r) => r.id)).not.toContain(wellId)
  }

  it('Keep, then Triage exclude (drops the well id), then emptied: hidden from search and picture search', async () => {
    const h = await addScannedItem('real1.png', [33, 66, 99])
    await svc.act(h, 'keep')
    const wellId = decision(h)!.well_id!
    await setTriageDecision(archive, well, src, h, 'exclude')
    expect(decision(h)).toMatchObject({ state: 'excluded', well_id: null })
    clock = Date.now() + 31 * DAY
    const r = await svc.emptyBin((await svc.piles()).bin.token)
    expect(r.ok).toBe(true)
    expect(decision(h)).toMatchObject({ state: 'emptied', well_id: null })
    await hiddenEverywhere(wellId)
  })

  it('Keep, Undo Keep, then throw away, then emptied: hidden from search and picture search', async () => {
    const h = await addScannedItem('real2.png', [99, 66, 33])
    await svc.act(h, 'keep')
    const wellId = decision(h)!.well_id!
    await svc.undo()
    expect(decision(h)).toBeUndefined()
    expect((await wellByIds(well, [wellId])).length).toBe(1) // visible while not emptied
    await svc.act(h, 'throwaway')
    expect(decision(h)).toMatchObject({ state: 'excluded', well_id: null })
    clock = T0 + 30 * DAY
    await svc.emptyBin((await svc.piles()).bin.token)
    expect(decision(h)?.state).toBe('emptied')
    await hiddenEverywhere(wellId)
  })

  it('a stale scan hash: scan A, replace the file with B, import, empty A — B stays visible, also after a restart', async () => {
    const hA = await addScannedItem('swap.png', [10, 200, 90]) // scanned as A
    await png(join(src, 'swap.png'), 200, 30, 140) // replaced with B before import
    const hB = contentHash(join(src, 'swap.png'))
    expect(hB).not.toBe(hA)
    const before = new Set(wellRows().map((w) => w.id))
    await svc.act(hA, 'keep') // imports B's bytes under A's decision key
    const wellId = wellRows().find((w) => !before.has(w.id))!.id
    expect(decision(hA)).toMatchObject({ state: 'included', well_id: null }) // A's decision does not name B's copy
    const links = (): string[] => {
      const db = new DatabaseSync(join(well, 'well.db'), { readOnly: true })
      try {
        return (db.prepare('SELECT source_hash FROM well_sources WHERE well_id = ?').all(wellId) as Array<{ source_hash: string }>).map((l) => l.source_hash)
      } finally {
        db.close()
      }
    }
    expect(links()).toEqual([hB]) // never linked to A
    await svc.act(hA, 'throwaway')
    clock = T0 + 30 * DAY
    await svc.emptyBin((await svc.piles()).bin.token)
    expect(decision(hA)?.state).toBe('emptied')
    expect((await wellByIds(well, [wellId])).map((r) => r.id)).toEqual([wellId])
    expect((await searchWell(well, '', 60)).map((r) => r.id)).toContain(wellId)
    // a decision that names B's copy under another key (as older builds wrote) must not be linked by a restart
    const t = new DatabaseSync(join(well, 'triage.db'))
    t.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES ('hstale', 'emptied', ?, ?)").run(new Date(T0).toISOString(), wellId)
    t.close()
    // restart: fresh modules, so nothing is remembered in memory
    vi.resetModules()
    const fresh = await import('../src/main/well')
    expect((await fresh.wellByIds(well, [wellId])).map((r) => r.id)).toEqual([wellId])
    expect((await fresh.searchWell(well, '', 60)).map((r) => r.id)).toContain(wellId)
    expect(links()).toEqual([hB])
  })

})

describe('Triage list: throwaways stay findable until binned (same clock as the piles)', () => {
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

  it('unreadable or missing dates stay in Throwaway and stay findable', async () => {
    const db = new DatabaseSync(join(well, 'triage.db'))
    db.prepare("UPDATE sorter_proposals SET throwaway_since = 'garbage', proposed_at = 'garbage' WHERE hash = 'ht1'").run()
    db.prepare("UPDATE sorter_proposals SET throwaway_since = NULL, proposed_at = '' WHERE hash = 'ht2'").run()
    db.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES ('hd2', 'excluded', 'not a date', NULL)").run()
    db.close()
    const far = T0 + 400 * DAY
    const hashes = (await listTriage(well, '', 'all', 'scanned', 50, 0, far)).map((r) => r.hash)
    expect(hashes).toEqual(expect.arrayContaining(['ht1', 'ht2', 'hd2']))
    clock = far
    const piles = await svc.piles()
    expect(piles.throwaway.items.map((c) => c.hash)).toEqual(expect.arrayContaining(['ht1', 'ht2', 'hd2']))
    expect(piles.bin.items.map((c) => c.hash)).toEqual(['hclip'])
  })
})

describe('Triage: an emptied marker is permanent', () => {
  it('reset, select and exclude are refused and say so; the marker stays', async () => {
    clock = T0 + 30 * DAY
    await svc.emptyBin((await svc.piles()).bin.token)
    for (const action of ['reset', 'select', 'exclude'] as const) {
      const r = await setTriageDecision(archive, well, src, 'ht1', action)
      expect(r.state).toBe('emptied')
      expect(r.refused).toMatch(/emptied from the Bin/)
      expect(decision('ht1')?.state).toBe('emptied')
    }
    await putTriageDecision(well, 'ht1', null) // review's own write path cannot remove it either
    expect(decision('ht1')?.state).toBe('emptied')
    expect(await setTriageDecision(archive, well, src, 'hd1', 'select')).toEqual({ state: 'selected' }) // others unaffected
  })
})

describe('IPC guard: Triage answers the main window only', () => {
  it('runs the handler for the main window and refuses any other sender', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const ipc = { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void handlers.set(ch, fn) }
    const main = { id: 1 }
    let ran = 0
    guardedHandle(ipc as never, (s) => s === (main as never), 'triage:decide', (_e, hash: string) => {
      ran++
      return hash
    })
    expect(handlers.get('triage:decide')!({ sender: main }, 'h1')).toBe('h1')
    expect(() => handlers.get('triage:decide')!({ sender: { id: 2 } }, 'h1')).toThrow(/not allowed/)
    expect(ran).toBe(1)
  })

  it('every Triage handler in the main process goes through the guard', () => {
    const text = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    expect(text).not.toMatch(/ipcMain\.handle\('triage:/)
    for (const ch of ['triage:scan', 'triage:list', 'triage:decide', 'triage:import-selected', 'well:add-from-clipboard']) {
      expect(text).toContain(`guardedHandle(ipcMain, fromMainWindow, '${ch}'`)
    }
  })
})

describe('the sorter cannot write his decisions', () => {
  it('no sorter source writes triage_decisions', () => {
    const dir = join(__dirname, '..', 'src', 'main', 'sorter')
    // every source file, subfolders included (the cloud step lives in sorter/cloud/)
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f))
    expect(files.some((f) => f.includes('cloud'))).toBe(true)
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      expect(text, f).not.toMatch(/(INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+triage_decisions/i)
      expect(text, f).not.toMatch(/putTriageDecision|setTriageDecision|promoteTriageHashes|importSelectedTriage/)
    }
  })
})

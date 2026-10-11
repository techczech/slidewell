import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadLabelled, loadUndecided, SorterStore } from '../src/main/sorter/store'
import { PictureSearchEngine, normalise, type Embedder } from '../src/main/picture-search/engine'
import { VectorStore, triageImageId, wellImageId } from '../src/main/picture-search/vector-store'

let well: string
let src: string
beforeEach(() => {
  well = mkdtempSync(join(tmpdir(), 'sw-sorter-'))
  src = join(well, 'source')
  mkdirSync(join(well, 'images'), { recursive: true })
  mkdirSync(src, { recursive: true })
  const png = (p: string): void => writeFileSync(p, Buffer.alloc(64, 1))
  for (const f of ['kept.png', 'binned.png', 'new1.png', 'new2.png']) png(join(src, f))
  png(join(well, 'images', 'shot--w1.webp')) // kept; triage original still present (kept.png)
  png(join(well, 'images', 'shot--w2.webp')) // kept; triage original gone
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);`)
  const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, app, window_title) VALUES (?, ?, ?, ?, 'png', ?, ?, ?, ?, '')")
  row.run('hkept', 'image', 'kept.png', 'kept.png', '0', 'a chart', src, '')
  row.run('hbin', 'image', 'binned.png', 'binned.png', '0', 'zsh: command not found', src, 'Terminal')
  row.run('hnew1', 'image', 'new1.png', 'new1.png', '0', 'WriteFlex', src, '')
  row.run('hnew2', 'image', 'new2.png', 'new2.png', '0', '', src, '')
  row.run('hnew2', 'image', 'missing-dup.png', 'missing-dup.png', '0', '', src, '') // duplicate hash, file gone
  row.run('hvid', 'video', 'clip.mov', 'clip.mov', '0', '', src, '')
  row.run('hoff', 'image', 'offline.png', 'offline.png', '1', '', src, '')
  row.run('hsel', 'image', 'new1.png', 'staged.png', '0', '', src, '')
  const dec = t.prepare('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)')
  dec.run('hkept', 'included', '2026-10-01', 'w1')
  dec.run('hgone', 'included', '2026-10-01', 'w2')
  dec.run('hbin', 'excluded', '2026-10-01', null)
  dec.run('hsel', 'selected', '2026-10-01', null)
  t.close()
  const w = new DatabaseSync(join(well, 'well.db'))
  w.exec('CREATE VIRTUAL TABLE well_fts USING fts5(id UNINDEXED, slug, ext UNINDEXED, rel_path UNINDEXED, root UNINDEXED, source UNINDEXED, tags, notes, ocr_text, added_at UNINDEXED)')
  const wr = w.prepare('INSERT INTO well_fts (id, rel_path, root, source, ocr_text) VALUES (?, ?, ?, ?, ?)')
  wr.run('w1', 'images/shot--w1.webp', 'well', 'screenshot', 'well ocr 1')
  wr.run('w2', 'images/shot--w2.webp', 'well', 'screenshot', 'well ocr 2')
  wr.run('v1', 'talk/a.png', 'vault', 'talkweaver', '') // not a screenshot: not labelled
  w.close()
})
afterEach(() => rmSync(well, { recursive: true, force: true }))

describe('sorter store: what it reads', () => {
  it('labelled history: well screenshots + included = keep, excluded = throwaway; original preferred over the well copy', () => {
    const shots = loadLabelled(well)
    const byKey = Object.fromEntries(shots.map((s) => [s.key, s]))
    expect(Object.keys(byKey).sort()).toEqual(['h:hbin', 'h:hgone', 'h:hkept'].sort())
    expect(byKey['h:hkept']).toMatchObject({ truth: 'keep', fromWellCopy: false, image: { id: triageImageId('hkept'), kind: 'triage' } })
    expect(byKey['h:hgone']).toMatchObject({ truth: 'keep', fromWellCopy: true, image: { id: wellImageId('w2'), kind: 'well-image' }, facts: { ocrText: 'well ocr 2' } })
    expect(byKey['h:hbin']).toMatchObject({ truth: 'throwaway', facts: { app: 'Terminal' }, image: { kind: 'triage' } })
  })

  it('undecided: pictures with no decision of his, one per hash, readable file preferred; videos, placeholders, staged skipped', () => {
    const shots = loadUndecided(well)
    expect(shots.map((s) => s.hash).sort()).toEqual(['hnew1', 'hnew2'])
    expect(shots.find((s) => s.hash === 'hnew2')!.image?.path).toBe(join(src, 'new2.png'))
  })
})

describe('sorter store: what it writes', () => {
  it('proposals go to sorter_proposals; his decisions are never touched', () => {
    const before = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
    const decisions = before.prepare('SELECT * FROM triage_decisions ORDER BY hash').all()
    before.close()
    const s = new SorterStore(well)
    s.writeProposals(
      [
        { hash: 'hnew1', proposal: 'keep', confidence: 0.9, pKeep: 0.9, reason: 'r', rule: 'own-apps' },
        { hash: 'hnew2', proposal: 'doubtful', confidence: 0.6, pKeep: 0.4, reason: 'r', rule: null },
        { hash: 'hbin', proposal: 'throwaway', confidence: 0.95, pKeep: 0.05, reason: 'r', rule: 'terminal' } // already decided by him
      ],
      'sorter-local-1',
      'model-x'
    )
    expect(s.pendingCounts()).toMatchObject({ keep: 1, throwaway: 0, doubtful: 1 })
    s.saveModel({ id: 'm1', trainedAt: '2026-10-09T10:00:00Z', sorterVersion: 'v', model: { kind: 'logistic-v1', dim: 1, mean: [0], weights: [1], bias: 0, l2: 0.1, trainedOn: { keep: 1, throwaway: 1 } }, report: { n: 1 } })
    expect(s.latestModel<{ n: number }>()?.report.n).toBe(1)
    s.close()
    const after = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
    expect(after.prepare('SELECT * FROM triage_decisions ORDER BY hash').all()).toEqual(decisions)
    expect(after.prepare("SELECT sorter_version, model_id FROM sorter_proposals WHERE hash = 'hnew1'").get()).toEqual({ sorter_version: 'sorter-local-1', model_id: 'model-x' })
    after.close()
  })
})

describe('picture store: triage kind', () => {
  it('triage vectors are stored but left out of search unless asked for', async () => {
    const store = new VectorStore(join(well, 'picture-search.db'), { model: 'fake', dim: '2' })
    const fake: Embedder = { embedText: async () => normalise(Float32Array.from([1, 0])), embedImage: async () => normalise(Float32Array.from([1, 0.1])) }
    const engine = new PictureSearchEngine(store, () => fake)
    await engine.embedAndStore({ id: triageImageId('h1'), kind: 'triage', path: '/x/a.png', size: 1, mtimeMs: 1 })
    await engine.embedAndStore({ id: wellImageId('w1'), kind: 'well-image', path: '/x/b.png', size: 1, mtimeMs: 1 })
    expect((await engine.pictureQuery({ text: 'anything' })).map((r) => r.id)).toEqual(['well:w1'])
    expect((await engine.pictureQuery({ text: 'anything' }, { kinds: ['triage'] })).map((r) => r.id)).toEqual(['triage:h1'])
    expect((await engine.pictureQuery({ imageId: 'triage:h1' })).map((r) => r.id)).toEqual(['well:w1'])
    store.close()
  })
})

describe('sorter store: cloud step columns (ticket 07)', () => {
  it('an older sorter_proposals table gains decided_by; the review reads it onto the card row', async () => {
    const db = new DatabaseSync(join(well, 'triage.db'))
    db.exec(`DROP TABLE IF EXISTS sorter_proposals;
      CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT NOT NULL, confidence REAL NOT NULL, p_keep REAL NOT NULL, reason TEXT NOT NULL, rule TEXT,
        sorter_version TEXT NOT NULL, model_id TEXT, proposed_at TEXT NOT NULL, throwaway_since TEXT, answered_at TEXT, answer TEXT);
      INSERT INTO sorter_proposals VALUES ('hold', 'doubtful', 0.6, 0.4, 'r', NULL, 'v', NULL, '2026-10-01', NULL, NULL, NULL);`)
    db.close()
    const s = new SorterStore(well)
    s.writeProposals([{ hash: 'hnew1', proposal: 'keep', confidence: 0.9, pKeep: 0.9, reason: 'r', rule: 'own-apps', decidedBy: 'rules' }], 'v', null)
    s.close()
    const { readReviewRows } = await import('../src/main/review/store')
    const rows = new Map(readReviewRows(well).map((r) => [r.hash, r]))
    expect(rows.get('hnew1')?.decidedBy).toBe('rules')
    expect(rows.get('hold')?.decidedBy).toBeNull()
  })
})

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { makeSearchArchive } from './search-fixture.mjs'

export const SHOWN_WELL = 'a10000000001'
export const HIDDEN_WELL = 'a10000000002'
const VAULT_WELL = 'a10000000003'
const LINK_WELL = 'a10000000004'
const BIN_WELL = 'a10000000005'
export const SHOWN_SLIDE = 'slide:fixture-deck-1#1'
export const OTHER_SLIDE = 'slide:fixture-deck-2#1'
export const OUT_OF_SCOPE_SLIDE = 'slide:fixture-deck-3#1'

export async function makeFinderFixture(root) {
  const archiveRoot = join(root, 'archive')
  const wellRoot = join(root, 'well')
  await makeSearchArchive(archiveRoot)
  mkdirSync(join(wellRoot, 'images'), { recursive: true })
  const bytes = await sharp({ create: { width: 720, height: 414, channels: 3, background: '#a25d40' } }).png().toBuffer()
  const well = new DatabaseSync(join(wellRoot, 'well.db'))
  const triage = new DatabaseSync(join(wellRoot, 'triage.db'))
  try {
    well.exec(`CREATE VIRTUAL TABLE well_fts USING fts5(
      id UNINDEXED, slug UNINDEXED, ext UNINDEXED, rel_path UNINDEXED, root UNINDEXED,
      source UNINDEXED, tags, notes, ocr_text, added_at UNINDEXED);
      CREATE TABLE well_sources(well_id TEXT, source_hash TEXT, PRIMARY KEY (well_id, source_hash));
      CREATE TABLE well_meta(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO well_meta VALUES ('well_sources_backfilled', 'fixture');`)
    triage.exec(`CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT, well_id TEXT);
      CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT, proposed_at TEXT, throwaway_since TEXT);`)
    const add = well.prepare('INSERT INTO well_fts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const link = well.prepare('INSERT INTO well_sources VALUES (?, ?)')
    for (const [id, slug, source] of [
      [SHOWN_WELL, 'lantern-photo', 'well'], [HIDDEN_WELL, 'discarded-photo', 'well'],
      [VAULT_WELL, 'vault-photo', 'vault'], [LINK_WELL, 'linked-photo', 'well'], [BIN_WELL, 'binned-photo', 'well']
    ]) {
      const rel = `images/${slug}.png`
      add.run(id, slug, 'png', rel, source, source === 'well' ? 'screenshot' : 'talkweaver', 'coast', '', 'Lantern at sea', '2025-04-10')
      link.run(id, id)
      if (id === LINK_WELL) {
        writeFileSync(join(root, 'outside.png'), bytes)
        symlinkSync(join(root, 'outside.png'), join(wellRoot, rel))
      } else {
        writeFileSync(join(wellRoot, rel), bytes)
      }
    }
    triage.prepare('INSERT INTO triage_decisions VALUES (?, ?, ?)').run(HIDDEN_WELL, 'emptied', SHOWN_WELL)
    triage.prepare('INSERT INTO sorter_proposals VALUES (?, ?, ?, ?)').run(BIN_WELL, 'throwaway', '2020-01-01', null)
  } finally {
    well.close()
    triage.close()
  }
  return {
    scope: {
      libraryId: 'fixture-library', archiveRoot, wellRoot,
      presentations: ['fixture-deck-1', 'fixture-deck-2'],
      wellImages: [SHOWN_WELL, HIDDEN_WELL, VAULT_WELL, LINK_WELL, BIN_WELL]
    },
    bytes,
    relabel(id, state) {
      const db = new DatabaseSync(join(wellRoot, 'triage.db'))
      try {
        db.prepare('INSERT OR REPLACE INTO triage_decisions VALUES (?, ?, ?)').run(id, state, id)
      } finally {
        db.close()
      }
    }
  }
}

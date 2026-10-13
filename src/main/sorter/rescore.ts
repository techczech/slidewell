/**
 * What moved after a retrain (ticket 22): the undecided screenshots that already carry a proposal
 * are scored again with the model just trained, and the difference is counted.
 *
 * It is not a sort:
 *   - only a row that already exists is changed, and only while he has still not decided the
 *     screenshot (no row in triage_decisions, not answered in Review). No row is created;
 *   - only a row that is doubtful now and was made under the current sorter version is read, counted
 *     or changed. A proposal the sorter was sure about (keep or throwaway) is never touched: only a
 *     real sort can change it. Nor is one from an older version, which needs a real sort too. So a
 *     re-score can take a screenshot out of what a cloud model may be asked about and can never bring
 *     one in (store.ts eligibleSql asks for doubtful and for the version);
 *   - the row stays in the sort run that proposed it (run_id) and keeps its proposed_at, so no sort
 *     run is made and "last sorted" does not move;
 *   - nothing is written to triage_decisions, and no cloud model is asked: an answer one already
 *     gave is applied again, exactly as a sort does (score.ts).
 *
 * A row is written only if it is still as it was read (still doubtful, same proposed_at): a sort or a
 * cloud answer that changed it in the meantime wins and the row is left alone.
 *
 * Everything is counted over that one set, the rows read at the start: need-a-look before = its size;
 * after = those of it still doubtful (and still undecided) when the re-score ends; "moved to sure" =
 * those of it written as keep or throwaway.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IndexItem } from '../picture-search/vector-store'
import type { Classifier } from './classifier'
import type { Thresholds } from './decide'
import type { Job, JobResult } from './jobs'
import type { AppRuleLookup } from './rules'
import { scoreShot } from './score'
import { loadUndecided, type ProposalRow, type Shot, type StoredCloudAnswer } from './store'

/** At most this many hashes of screenshots that moved to sure are kept with a retrain. */
export const MOVED_HASHES_KEPT = 200

/** What a re-score did, all of it counted over the doubtful proposals it read at the start (see above). */
export type Rescore = {
  /** Proposals written again (whether or not the call changed). */
  rescored: number
  /** before: the doubtful proposals read; after: those of them still doubtful at the end. */
  needALook: { before: number; after: number }
  /** Those of them written as keep / throwaway. */
  movedToSure: { keep: number; throwaway: number }
  /** The first MOVED_HASHES_KEPT screenshots that moved to sure. */
  movedHashes: string[]
}

type Existing = { hash: string; proposedAt: string }

function open(wellRoot: string): DatabaseSync | null {
  const file = join(wellRoot, 'triage.db')
  if (!existsSync(file)) return null
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout=5000;')
  return db
}

const hasTable = (db: DatabaseSync, name: string): boolean => Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name))

/** "He has not decided it": no decision of his in Triage and no answer in Review (alias p). */
const undecidedSql = (db: DatabaseSync): string => `p.answered_at IS NULL ${hasTable(db, 'triage_decisions') ? 'AND NOT EXISTS (SELECT 1 FROM triage_decisions d WHERE d.hash = p.hash)' : ''}`

/** The doubtful proposals, made under `sorterVersion`, of screenshots he has not decided, as they are now: all a re-score reads. */
export function doubtfulProposals(wellRoot: string, sorterVersion: string): Existing[] {
  const db = open(wellRoot)
  if (!db) return []
  try {
    if (!hasTable(db, 'sorter_proposals')) return []
    return (db.prepare(`SELECT p.hash AS hash, p.proposed_at AS proposed_at FROM sorter_proposals p WHERE p.proposal = 'doubtful' AND p.sorter_version = ? AND ${undecidedSql(db)}`).all(sorterVersion) as Array<{ hash: string; proposed_at: string }>).map((r) => ({ hash: r.hash, proposedAt: r.proposed_at }))
  } finally {
    db.close()
  }
}

/**
 * Write re-scored proposals over the rows they were read from (one transaction). A row is changed
 * only if it is still doubtful, still undecided, still has the proposed_at it was read with and was
 * made under `sorterVersion` (which is therefore not written). The check is in the UPDATE itself, so
 * a row the sorter is sure about cannot be written here whatever the caller passes. run_id and
 * proposed_at are left as they are; a row that becomes throwaway starts its 30-day clock now.
 * Returns the hashes written.
 */
export function writeRescored(wellRoot: string, rows: Array<ProposalRow & { proposedAt: string }>, sorterVersion: string, modelId: string, now: Date = new Date()): string[] {
  if (!rows.length) return []
  const db = open(wellRoot)
  if (!db) return []
  try {
    const put = db.prepare(
      `UPDATE sorter_proposals AS p SET proposal = ?, confidence = ?, p_keep = ?, reason = ?, rule = ?, model_id = ?, decided_by = ?, decided_model = ?,
         throwaway_since = CASE WHEN ? = 'throwaway' THEN ? END
       WHERE p.hash = ? AND p.proposal = 'doubtful' AND p.proposed_at = ? AND p.sorter_version = ? AND ${undecidedSql(db)}`
    )
    const written: string[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        const res = put.run(r.proposal, r.confidence, r.pKeep, r.reason, r.rule, modelId, r.decidedBy ?? null, r.decidedModel ?? null, r.proposal, now.toISOString(), r.hash, r.proposedAt, sorterVersion)
        if (Number(res.changes)) written.push(r.hash)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return written
  } finally {
    db.close()
  }
}

export type RescoreContext = {
  wellRoot: string
  model: Classifier
  modelId: string
  sorterVersion: string
  thresholds: Thresholds
  rules: AppRuleLookup
  /** Stored cloud answers that count now, by hash. Nothing is asked. */
  asked: ReadonlyMap<string, StoredCloudAnswer[]>
  /** Stored embeddings for these pictures (service.ts: the picture engine's ensureVectors). */
  vectors: (items: IndexItem[]) => Promise<Map<string, Float32Array>>
  /** Embeddings of everything he kept, for the look-alike signal. */
  keptVectors: Float32Array[]
  job: <J extends Job>(j: J) => Promise<JobResult<J>>
  aborted: () => boolean
  onProgress?: (done: number, total: number) => void
}

const CHUNK = 50

/**
 * Score again the screenshots he has not decided whose proposal is doubtful, and say what moved.
 * Stops between chunks when aborted: the rows written by then stay, and the counts are then of a
 * part only (service.ts trainAndTest reports such a re-score as not checked).
 */
export async function rescoreUndecided(c: RescoreContext): Promise<Rescore> {
  const before = new Map(doubtfulProposals(c.wellRoot, c.sorterVersion).map((r) => [r.hash, r]))
  const out: Rescore = { rescored: 0, needALook: { before: before.size, after: 0 }, movedToSure: { keep: 0, throwaway: 0 }, movedHashes: [] }
  // a proposal whose file is no longer in the index is left as it is
  const shots = loadUndecided(c.wellRoot).filter((s): s is Shot & { hash: string } => Boolean(s.hash && before.has(s.hash)))
  for (let i = 0; i < shots.length && !c.aborted(); i += CHUNK) {
    const chunk = shots.slice(i, i + CHUNK)
    const vectors = await c.vectors(chunk.flatMap((s) => (s.image ? [s.image] : [])))
    if (c.aborted()) break
    const have = chunk.filter((s) => s.image && vectors.has(s.image.id))
    const tiers = have.length ? await c.job({ kind: 'kept-tiers', vectors: have.map((s) => vectors.get(s.image!.id)!), kept: c.keptVectors }) : []
    if (c.aborted()) break
    const tierOf = new Map(have.map((s, k) => [s, tiers[k]]))
    const rows = chunk.map((s) => {
      const v = s.image ? vectors.get(s.image.id) : undefined
      return { ...scoreShot(s, v, v ? (tierOf.get(s) ?? null) : null, c), proposedAt: before.get(s.hash)!.proposedAt }
    })
    const written = new Set(writeRescored(c.wellRoot, rows, c.sorterVersion, c.modelId))
    for (const r of rows) {
      if (!written.has(r.hash)) continue
      out.rescored++
      if (r.proposal === 'doubtful') continue
      out.movedToSure[r.proposal]++
      if (out.movedHashes.length < MOVED_HASHES_KEPT) out.movedHashes.push(r.hash)
    }
    c.onProgress?.(Math.min(shots.length, i + chunk.length), shots.length)
  }
  out.needALook.after = doubtfulProposals(c.wellRoot, c.sorterVersion).filter((r) => before.has(r.hash)).length
  return out
}

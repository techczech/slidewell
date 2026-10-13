/**
 * What moved after a retrain (ticket 22): the undecided screenshots that already carry a proposal
 * are scored again with the model just trained, and the difference is counted.
 *
 * It is not a sort:
 *   - only a row that already exists is changed, and only while he has still not decided the
 *     screenshot (no row in triage_decisions, not answered in Review). No row is created;
 *   - only a row made under the current sorter version is read, counted or changed. A proposal from
 *     an older version needs a real sort: it is left exactly as it is, so a re-score never brings a
 *     screenshot into what a cloud model may be asked about (store.ts eligibleSql reads the version);
 *   - the row stays in the sort run that proposed it (run_id) and keeps its proposed_at, so no sort
 *     run is made and "last sorted" does not move;
 *   - nothing is written to triage_decisions, and no cloud model is asked: an answer one already
 *     gave is applied again, exactly as a sort does (score.ts).
 *
 * A row is written only if it is still as it was read (same proposed_at): a sort or a cloud answer
 * that changed it in the meantime wins and the row is left alone.
 *
 * "Moved to sure" = was doubtful before, is keep or throwaway after. Need-a-look before and after are
 * the doubtful proposals, made under the current sorter version, among his undecided screenshots,
 * read from the table each time.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IndexItem } from '../picture-search/vector-store'
import type { Classifier } from './classifier'
import type { Proposal, Thresholds } from './decide'
import type { Job, JobResult } from './jobs'
import type { AppRuleLookup } from './rules'
import { scoreShot } from './score'
import { loadUndecided, type ProposalRow, type Shot, type StoredCloudAnswer } from './store'

/** At most this many hashes of screenshots that moved to sure are kept with a retrain. */
export const MOVED_HASHES_KEPT = 200

export type Rescore = {
  /** Proposals written again (whether or not the call changed). */
  rescored: number
  needALook: { before: number; after: number }
  movedToSure: { keep: number; throwaway: number }
  /** The first MOVED_HASHES_KEPT screenshots that moved to sure. */
  movedHashes: string[]
}

type Existing = { hash: string; proposal: Proposal; proposedAt: string }

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

/** The proposals, made under `sorterVersion`, of screenshots he has not decided, as they are now. */
export function undecidedProposals(wellRoot: string, sorterVersion: string): Existing[] {
  const db = open(wellRoot)
  if (!db) return []
  try {
    if (!hasTable(db, 'sorter_proposals')) return []
    return (db.prepare(`SELECT p.hash AS hash, p.proposal AS proposal, p.proposed_at AS proposed_at FROM sorter_proposals p WHERE p.sorter_version = ? AND ${undecidedSql(db)}`).all(sorterVersion) as Array<{ hash: string; proposal: Proposal; proposed_at: string }>).map((r) => ({
      hash: r.hash,
      proposal: r.proposal,
      proposedAt: r.proposed_at
    }))
  } finally {
    db.close()
  }
}

/**
 * Write re-scored proposals over the rows they were read from (one transaction). A row is changed
 * only if it is still undecided, still has the proposed_at it was read with and was made under
 * `sorterVersion` (which is therefore not written). run_id and proposed_at are left as they are; a throwaway keeps the 30-day clock it already had, and a row
 * that becomes throwaway now starts one. Returns the hashes written.
 */
export function writeRescored(wellRoot: string, rows: Array<ProposalRow & { proposedAt: string }>, sorterVersion: string, modelId: string, now: Date = new Date()): string[] {
  if (!rows.length) return []
  const db = open(wellRoot)
  if (!db) return []
  try {
    const put = db.prepare(
      `UPDATE sorter_proposals AS p SET proposal = ?, confidence = ?, p_keep = ?, reason = ?, rule = ?, model_id = ?, decided_by = ?, decided_model = ?,
         throwaway_since = CASE WHEN ? != 'throwaway' THEN NULL
                                WHEN p.proposal = 'throwaway' AND p.throwaway_since IS NOT NULL THEN p.throwaway_since
                                ELSE ? END
       WHERE p.hash = ? AND p.proposed_at = ? AND p.sorter_version = ? AND ${undecidedSql(db)}`
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

/** Score his undecided, already proposed screenshots again and say what moved. Stops between chunks when aborted. */
export async function rescoreUndecided(c: RescoreContext): Promise<Rescore> {
  const before = new Map(undecidedProposals(c.wellRoot, c.sorterVersion).map((r) => [r.hash, r]))
  const doubtful = (rows: Iterable<Existing>): number => [...rows].filter((r) => r.proposal === 'doubtful').length
  const out: Rescore = { rescored: 0, needALook: { before: doubtful(before.values()), after: 0 }, movedToSure: { keep: 0, throwaway: 0 }, movedHashes: [] }
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
      if (before.get(r.hash)!.proposal !== 'doubtful' || r.proposal === 'doubtful') continue
      out.movedToSure[r.proposal]++
      if (out.movedHashes.length < MOVED_HASHES_KEPT) out.movedHashes.push(r.hash)
    }
    c.onProgress?.(Math.min(shots.length, i + chunk.length), shots.length)
  }
  out.needALook.after = doubtful(undecidedProposals(c.wellRoot, c.sorterVersion))
  return out
}

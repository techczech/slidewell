/**
 * The sorter's data: what it reads (his labelled history and the undecided screenshots, from
 * triage.db and well.db) and what it writes (its own proposals and trained models, in triage.db).
 *
 * Writes go ONLY to the sorter's own tables in triage.db. His own decisions (triage_decisions) are read,
 * never written: a proposal sits beside a decision, it never replaces or imitates one.
 *
 *   sorter_proposals(hash TEXT PRIMARY KEY,           triage content hash (same key as triage_decisions)
 *                    proposal TEXT,                    keep | throwaway | doubtful
 *                    confidence REAL, p_keep REAL,     probability of the proposal; combined p(keep)
 *                    reason TEXT, rule TEXT,           plain-words reason; rule name or NULL
 *                    sorter_version TEXT, model_id TEXT, proposed_at TEXT,
 *                    throwaway_since TEXT,             when it first proposed throwaway (kept across re-sorts;
 *                                                      starts the review's 30-day clock), NULL otherwise
 *                    answered_at TEXT, answer TEXT,    set by the review screen when he answers (keep | throwaway)
 *                    decided_by TEXT)                  which step made the call: rules | history | luna; NULL
 *                                                      for a local doubtful (ticket 07)
 *   sorter_cloud_answers(hash TEXT PRIMARY KEY, verdict TEXT, confidence REAL, reason TEXT,
 *                    model TEXT, prompt_version TEXT, asked_at TEXT)
 *                                                      Luna's answer per screenshot, so a screenshot is asked
 *                                                      once per model + prompt and its answer re-applied on
 *                                                      later local sorts (cloud/service.ts)
 *   sorter_cloud_claims(hash TEXT PRIMARY KEY, run_id TEXT, claimed_at TEXT)
 *                                                      screenshots a cloud run has claimed and is sending now;
 *                                                      claimed in one write transaction, so two processes can
 *                                                      never send the same screenshot; released when the run
 *                                                      ends (a crashed run's claims go stale after CLAIM_STALE_MS)
 *   sorter_cloud_allowance(night TEXT PRIMARY KEY, sent INTEGER)
 *                                                      how many screenshots were sent to Luna in each night
 *                                                      window (schedule.ts nightOf), nightly and Sort now alike;
 *                                                      the per-night limit is checked against it in the claim
 *   sorter_models(id TEXT PRIMARY KEY, trained_at TEXT, sorter_version TEXT,
 *                 model TEXT (classifier JSON), report TEXT (accuracy report JSON))
 *
 * Image embeddings live in picture-search.db (kind 'triage', id `triage:<hash>`), see vector-store.ts.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { triageImageId, wellImageId, type IndexItem } from '../picture-search/vector-store'
import type { ShotFacts } from './rules'
import type { Truth } from './accuracy'
import type { Classifier } from './classifier'
import type { Proposal } from './decide'
import type { DecidedBy } from './cloud/cascade'
import type { LunaAnswer } from './cloud/luna'

const IMAGE_EXT = /\.(webp|png|jpe?g|gif|bmp|tiff?)$/i

/** One screenshot the sorter looks at: its facts for the rules and the image to embed (if readable). */
export type Shot = {
  /** Stable key for splitting: `h:<triage hash>` or `w:<well id>`. */
  key: string
  hash: string | null
  truth?: Truth
  facts: ShotFacts
  /** Local time from the file name ('YYYY-MM-DDTHH:MM:SS'), '' when unknown (for grouping bursts). */
  takenAt: string
  image: IndexItem | null
  /** A kept screenshot whose original is gone; the well's own (re-encoded) copy is embedded instead. */
  fromWellCopy: boolean
}

export type ProposalRow = { hash: string; proposal: Proposal; confidence: number; pKeep: number; reason: string; rule: string | null; decidedBy?: DecidedBy | null }

/** A doubtful proposal the cloud step may ask about (undecided, unanswered, current sorter version). */
export type CloudPending = { hash: string; confidence: number; pKeep: number; reason: string }

export type CloudAnswerRow = LunaAnswer & { hash: string; model: string; promptVersion: string; askedAt: string }

/** Which proposals and answers count for the cloud step: the current sorter, Luna model and prompt. */
export type CloudScope = { sorterVersion: string; model: string; promptVersion: string }

/** A claim older than this belongs to a run that crashed; it no longer blocks the screenshot. */
export const CLAIM_STALE_MS = 6 * 60 * 60 * 1000

export type ModelRecord<R> = { id: string; trainedAt: string; sorterVersion: string; model: Classifier; report: R }

export type PendingCounts = { keep: number; throwaway: number; doubtful: number; lastProposedAt: string | null }

type TriageJoinRow = { hash: string; taken_at?: string | null; source: string | null; rel_path: string | null; filename: string | null; app: string | null; window_title: string | null; ocr_text: string | null; state?: string; well_id?: string | null }

/** A local file we may read: present, non-empty, and not an online-only placeholder (never fetch). */
function localFile(p: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size === 0 || st.blocks === 0) return null
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  } catch {
    return null
  }
}

function triageItem(r: TriageJoinRow): IndexItem | null {
  if (!r.source || !r.rel_path || !IMAGE_EXT.test(r.rel_path)) return null
  const path = join(r.source, r.rel_path)
  const f = localFile(path)
  return f ? { id: triageImageId(r.hash), kind: 'triage', path, size: f.size, mtimeMs: f.mtimeMs } : null
}

const factsOf = (r: TriageJoinRow | undefined, ocrFallback = ''): ShotFacts => ({
  app: r?.app ?? '',
  windowTitle: r?.window_title ?? '',
  ocrText: r?.ocr_text || ocrFallback,
  filename: r?.filename ?? ''
})

function openRead(file: string): DatabaseSync | null {
  if (!existsSync(file)) return null
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000;')
  return db
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name))
}

/** Group join rows by hash; first row whose image is readable wins, else the first row. */
function byHash(rows: TriageJoinRow[]): Map<string, { row: TriageJoinRow; image: IndexItem | null }> {
  const out = new Map<string, { row: TriageJoinRow; image: IndexItem | null }>()
  for (const r of rows) {
    const cur = out.get(r.hash)
    if (cur?.image) continue
    const image = triageItem(r)
    if (!cur || image) out.set(r.hash, { row: r, image })
  }
  return out
}

const TRIAGE_COLS = 'f.taken_at, f.source, f.rel_path, f.filename, f.app, f.window_title, f.ocr_text'

/**
 * His labelled history. keep = every screenshot in the well (source 'screenshot') plus triage
 * `included`; throwaway = triage `excluded`. A kept screenshot is embedded from its triage original
 * when that file is still here, else from the well's copy. Binned screenshots whose file is gone
 * have nothing to embed and come back with image null.
 */
export function loadLabelled(wellRoot: string): Shot[] {
  const tdb = openRead(join(wellRoot, 'triage.db'))
  const wdb = openRead(join(wellRoot, 'well.db'))
  try {
    const decided: TriageJoinRow[] =
      tdb && hasTable(tdb, 'triage_decisions') && hasTable(tdb, 'triage_fts')
        ? (tdb
            .prepare(
              `SELECT d.hash AS hash, d.state AS state, d.well_id AS well_id, ${TRIAGE_COLS}
               FROM triage_decisions d LEFT JOIN triage_fts f ON f.hash = d.hash AND f.kind = 'image' AND f.offline = '0'
               WHERE d.state IN ('included', 'excluded')`
            )
            .all() as TriageJoinRow[])
        : []
    const wellShots =
      wdb && hasTable(wdb, 'well_fts')
        ? (wdb.prepare("SELECT id, rel_path, ocr_text FROM well_fts WHERE source = 'screenshot' AND root = 'well'").all() as Array<{ id: string; rel_path: string; ocr_text: string | null }>)
        : []
    const groups = byHash(decided)
    const includedByWell = new Map<string, string>() // well id → triage hash
    for (const [hash, g] of groups) if (g.row.state === 'included' && g.row.well_id) includedByWell.set(g.row.well_id, hash)

    const out: Shot[] = []
    const usedHashes = new Set<string>()
    for (const w of wellShots) {
      if (!IMAGE_EXT.test(w.rel_path)) continue
      const hash = includedByWell.get(w.id) ?? null
      const g = hash ? groups.get(hash) : undefined
      if (hash) usedHashes.add(hash)
      let image = g?.image ?? null
      let fromWellCopy = false
      if (!image) {
        const path = join(wellRoot, w.rel_path)
        const f = localFile(path)
        if (f) {
          image = { id: wellImageId(w.id), kind: 'well-image', path, size: f.size, mtimeMs: f.mtimeMs, wellId: w.id }
          fromWellCopy = true
        }
      }
      out.push({ key: hash ? `h:${hash}` : `w:${w.id}`, hash, truth: 'keep', facts: factsOf(g?.row, w.ocr_text ?? ''), takenAt: g?.row.taken_at ?? '', image, fromWellCopy })
    }
    for (const [hash, g] of groups) {
      if (usedHashes.has(hash)) continue
      if (g.row.state === 'included') out.push({ key: `h:${hash}`, hash, truth: 'keep', facts: factsOf(g.row), takenAt: g.row.taken_at ?? '', image: g.image, fromWellCopy: false })
      else if (g.row.state === 'excluded') out.push({ key: `h:${hash}`, hash, truth: 'throwaway', facts: factsOf(g.row), takenAt: g.row.taken_at ?? '', image: g.image, fromWellCopy: false })
    }
    return out
  } finally {
    tdb?.close()
    wdb?.close()
  }
}

/** Screenshots in triage with no decision of his (pictures only; videos and placeholders skipped). */
export function loadUndecided(wellRoot: string): Shot[] {
  const tdb = openRead(join(wellRoot, 'triage.db'))
  if (!tdb) return []
  try {
    if (!hasTable(tdb, 'triage_fts')) return []
    const decisions = hasTable(tdb, 'triage_decisions')
    const rows = tdb
      .prepare(
        `SELECT f.hash AS hash, ${TRIAGE_COLS} FROM triage_fts f
         ${decisions ? 'LEFT JOIN triage_decisions d ON d.hash = f.hash' : ''}
         WHERE f.kind = 'image' AND f.offline = '0' ${decisions ? 'AND d.hash IS NULL' : ''}`
      )
      .all() as TriageJoinRow[]
    return [...byHash(rows)].map(([hash, g]) => ({ key: `h:${hash}`, hash, facts: factsOf(g.row), takenAt: g.row.taken_at ?? '', image: g.image, fromWellCopy: false }))
  } finally {
    tdb.close()
  }
}

/**
 * Review columns on sorter_proposals (ticket 08), added in place to an older table. A new
 * throwaway_since is backfilled from proposed_at for existing throwaway proposals.
 */
export function migrateProposalColumns(db: DatabaseSync): void {
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('sorter_proposals')").all() as Array<{ name: string }>).map((c) => c.name))
  if (!cols.has('throwaway_since')) {
    db.exec('ALTER TABLE sorter_proposals ADD COLUMN throwaway_since TEXT')
    db.exec("UPDATE sorter_proposals SET throwaway_since = proposed_at WHERE proposal = 'throwaway'")
  }
  if (!cols.has('answered_at')) db.exec('ALTER TABLE sorter_proposals ADD COLUMN answered_at TEXT')
  if (!cols.has('answer')) db.exec('ALTER TABLE sorter_proposals ADD COLUMN answer TEXT')
  if (!cols.has('decided_by')) db.exec('ALTER TABLE sorter_proposals ADD COLUMN decided_by TEXT')
}

/** The sorter's own tables in triage.db: proposals and trained models. */
export class SorterStore {
  private db: DatabaseSync

  constructor(wellRoot: string) {
    this.db = new DatabaseSync(join(wellRoot, 'triage.db'))
    // triage.db stays in rollback-journal mode (its readers open it read-only; see triage.ts)
    this.db.exec('PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sorter_proposals (
        hash TEXT PRIMARY KEY,
        proposal TEXT NOT NULL CHECK (proposal IN ('keep', 'throwaway', 'doubtful')),
        confidence REAL NOT NULL,
        p_keep REAL NOT NULL,
        reason TEXT NOT NULL,
        rule TEXT,
        sorter_version TEXT NOT NULL,
        model_id TEXT,
        proposed_at TEXT NOT NULL,
        throwaway_since TEXT,
        answered_at TEXT,
        answer TEXT,
        decided_by TEXT
      );
      CREATE TABLE IF NOT EXISTS sorter_cloud_answers (
        hash TEXT PRIMARY KEY,
        verdict TEXT NOT NULL CHECK (verdict IN ('keep', 'throwaway', 'unsure')),
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        asked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sorter_cloud_claims (
        hash TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sorter_cloud_allowance (
        night TEXT PRIMARY KEY,
        sent INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sorter_models (
        id TEXT PRIMARY KEY,
        trained_at TEXT NOT NULL,
        sorter_version TEXT NOT NULL,
        model TEXT NOT NULL,
        report TEXT NOT NULL
      );
    `)
    migrateProposalColumns(this.db)
  }

  saveModel<R>(rec: ModelRecord<R>): void {
    this.db.prepare('INSERT OR REPLACE INTO sorter_models (id, trained_at, sorter_version, model, report) VALUES (?, ?, ?, ?, ?)').run(rec.id, rec.trainedAt, rec.sorterVersion, JSON.stringify(rec.model), JSON.stringify(rec.report))
  }

  latestModel<R>(): ModelRecord<R> | null {
    const r = this.db.prepare('SELECT id, trained_at, sorter_version, model, report FROM sorter_models ORDER BY trained_at DESC LIMIT 1').get() as
      | { id: string; trained_at: string; sorter_version: string; model: string; report: string }
      | undefined
    return r ? { id: r.id, trainedAt: r.trained_at, sorterVersion: r.sorter_version, model: JSON.parse(r.model), report: JSON.parse(r.report) } : null
  }

  /** Record proposals (one transaction). Never touches triage_decisions. */
  writeProposals(rows: ProposalRow[], sorterVersion: string, modelId: string | null): void {
    if (!rows.length) return
    const now = new Date().toISOString()
    const put = this.db.prepare(
      `INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at, decided_by, throwaway_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'throwaway' THEN ? END)
       ON CONFLICT(hash) DO UPDATE SET proposal = excluded.proposal, confidence = excluded.confidence, p_keep = excluded.p_keep,
         reason = excluded.reason, rule = excluded.rule, sorter_version = excluded.sorter_version, model_id = excluded.model_id, proposed_at = excluded.proposed_at,
         decided_by = excluded.decided_by,
         throwaway_since = CASE WHEN excluded.proposal != 'throwaway' THEN NULL
                                WHEN sorter_proposals.proposal = 'throwaway' AND sorter_proposals.throwaway_since IS NOT NULL THEN sorter_proposals.throwaway_since
                                ELSE excluded.proposed_at END`
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) put.run(r.hash, r.proposal, r.confidence, r.pKeep, r.reason, r.rule, sorterVersion, modelId, now, r.decidedBy ?? null, r.proposal, now)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * The cloud eligibility test for proposal `p`, as SQL: doubtful, made under the current sorter, not
   * answered in review, no decision of his (kept or excluded in Triage), no Luna answer yet for this
   * model + prompt. Parameters: sorterVersion, model, promptVersion.
   */
  private eligibleSql(): string {
    const decisions = hasTable(this.db, 'triage_decisions') ? 'AND NOT EXISTS (SELECT 1 FROM triage_decisions d WHERE d.hash = p.hash)' : ''
    return `p.proposal = 'doubtful' AND p.answered_at IS NULL AND p.sorter_version = ?
      AND NOT EXISTS (SELECT 1 FROM sorter_cloud_answers c WHERE c.hash = p.hash AND c.model = ? AND c.prompt_version = ?) ${decisions}`
  }

  /** Doubtful proposals the cloud step may ask about (eligibleSql), whether or not a run holds them. */
  cloudPending(sorterVersion: string, model: string, promptVersion: string): CloudPending[] {
    return (
      this.db
        .prepare(`SELECT p.hash AS hash, p.confidence AS confidence, p.p_keep AS p_keep, p.reason AS reason FROM sorter_proposals p WHERE ${this.eligibleSql()}`)
        .all(sorterVersion, model, promptVersion) as Array<{ hash: string; confidence: number; p_keep: number; reason: string }>
    ).map((r) => ({ hash: r.hash, confidence: Number(r.confidence), pKeep: Number(r.p_keep), reason: r.reason }))
  }

  /** Screenshots sent to Luna in this night window so far. */
  allowanceUsed(night: string): number {
    const r = this.db.prepare('SELECT sent FROM sorter_cloud_allowance WHERE night = ?').get(night) as { sent: number } | undefined
    return r ? Number(r.sent) : 0
  }

  /**
   * Claim screenshots for one cloud run, in one write transaction (BEGIN IMMEDIATE, so a second
   * process waits and then sees these claims): of `hashes`, in order, those still eligible and not
   * held by another live run, at most what is left of `limit` for `night`. The claimed count is added
   * to the night's allowance in the same transaction. Returns the claimed hashes.
   */
  claimForCloud(hashes: string[], o: CloudScope & { night: string; limit: number; runId: string; now: Date }): { claimed: string[]; leftBefore: number } {
    const nowIso = o.now.toISOString()
    const staleBefore = new Date(o.now.getTime() - CLAIM_STALE_MS).toISOString()
    const eligible = this.db.prepare(
      `SELECT 1 FROM sorter_proposals p WHERE p.hash = ? AND ${this.eligibleSql()} AND NOT EXISTS (SELECT 1 FROM sorter_cloud_claims k WHERE k.hash = p.hash)`
    )
    const claim = this.db.prepare('INSERT INTO sorter_cloud_claims (hash, run_id, claimed_at) VALUES (?, ?, ?)')
    const claimed: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM sorter_cloud_claims WHERE claimed_at < ?').run(staleBefore)
      const used = this.allowanceUsed(o.night)
      const leftBefore = Math.max(0, Math.floor(o.limit) - used)
      for (const h of hashes) {
        if (claimed.length >= leftBefore) break
        if (claimed.includes(h) || !eligible.get(h, o.sorterVersion, o.model, o.promptVersion)) continue
        claim.run(h, o.runId, nowIso)
        claimed.push(h)
      }
      if (claimed.length) {
        this.db
          .prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?) ON CONFLICT(night) DO UPDATE SET sent = sorter_cloud_allowance.sent + excluded.sent')
          .run(o.night, claimed.length)
      }
      this.db.exec('COMMIT')
      return { claimed, leftBefore }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Of `hashes`, those this run still holds and that are still eligible (checked just before a request). */
  stillEligible(hashes: string[], runId: string, scope: CloudScope): Set<string> {
    const q = this.db.prepare(
      `SELECT 1 FROM sorter_proposals p JOIN sorter_cloud_claims k ON k.hash = p.hash AND k.run_id = ? WHERE p.hash = ? AND ${this.eligibleSql()}`
    )
    return new Set(hashes.filter((h) => q.get(runId, h, scope.sorterVersion, scope.model, scope.promptVersion)))
  }

  /**
   * End of a run: its claims go, and the night's allowance gets back `unsent` (claimed screenshots
   * that never went into a request, so never left the Mac).
   */
  releaseClaims(runId: string, night: string, unsent: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM sorter_cloud_claims WHERE run_id = ?').run(runId)
      if (unsent > 0) this.db.prepare('UPDATE sorter_cloud_allowance SET sent = MAX(0, sent - ?) WHERE night = ?').run(Math.floor(unsent), night)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Luna's answers for this model + prompt, by hash. */
  cloudAnswers(model: string, promptVersion: string): Map<string, LunaAnswer> {
    const rows = this.db.prepare('SELECT hash, verdict, confidence, reason FROM sorter_cloud_answers WHERE model = ? AND prompt_version = ?').all(model, promptVersion) as Array<{ hash: string; verdict: LunaAnswer['verdict']; confidence: number; reason: string }>
    return new Map(rows.map((r) => [r.hash, { verdict: r.verdict, confidence: Number(r.confidence), reason: r.reason }]))
  }

  /**
   * Record Luna's answers and, in the same transaction, the proposals they lead to. A proposal is
   * changed only while it is still doubtful, unanswered and without a decision of his in Triage
   * (review or Triage may have got there first). Reasons arrive already redacted (cloud/service.ts).
   * Returns the hashes whose proposal changed.
   */
  saveCloudResults(answers: CloudAnswerRow[], proposals: Array<Pick<ProposalRow, 'hash' | 'proposal' | 'confidence' | 'pKeep' | 'reason' | 'decidedBy'>>): string[] {
    if (!answers.length && !proposals.length) return []
    const now = new Date().toISOString()
    const putAnswer = this.db.prepare(
      `INSERT INTO sorter_cloud_answers (hash, verdict, confidence, reason, model, prompt_version, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET verdict = excluded.verdict, confidence = excluded.confidence, reason = excluded.reason,
         model = excluded.model, prompt_version = excluded.prompt_version, asked_at = excluded.asked_at`
    )
    const putProposal = this.db.prepare(
      `UPDATE sorter_proposals SET proposal = ?, confidence = ?, p_keep = ?, reason = ?, decided_by = ?, proposed_at = ?,
         throwaway_since = CASE WHEN ? = 'throwaway' THEN ? END
       WHERE hash = ? AND proposal = 'doubtful' AND answered_at IS NULL
         ${hasTable(this.db, 'triage_decisions') ? 'AND NOT EXISTS (SELECT 1 FROM triage_decisions d WHERE d.hash = sorter_proposals.hash)' : ''}`
    )
    const changed: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const a of answers) putAnswer.run(a.hash, a.verdict, a.confidence, a.reason, a.model, a.promptVersion, a.askedAt)
      for (const p of proposals) if (Number(putProposal.run(p.proposal, p.confidence, p.pKeep, p.reason, p.decidedBy ?? null, now, p.proposal, now, p.hash).changes)) changed.push(p.hash)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return changed
  }

  /** Proposals for screenshots he has still not decided, by label. */
  pendingCounts(): PendingCounts {
    const decisions = hasTable(this.db, 'triage_decisions')
    const rows = this.db
      .prepare(
        `SELECT p.proposal AS proposal, COUNT(*) AS n, MAX(p.proposed_at) AS last FROM sorter_proposals p
         ${decisions ? 'LEFT JOIN triage_decisions d ON d.hash = p.hash WHERE d.hash IS NULL' : ''} GROUP BY p.proposal`
      )
      .all() as Array<{ proposal: Proposal; n: number; last: string | null }>
    const out: PendingCounts = { keep: 0, throwaway: 0, doubtful: 0, lastProposedAt: null }
    for (const r of rows) {
      out[r.proposal] = Number(r.n)
      if (r.last && (!out.lastProposedAt || r.last > out.lastProposedAt)) out.lastProposedAt = r.last
    }
    return out
  }

  /** The review screen marks a proposal answered (or, on undo, restores the earlier mark). */
  setAnswer(hash: string, answer: { answer: string; answeredAt: string } | null): void {
    this.db.prepare('UPDATE sorter_proposals SET answer = ?, answered_at = ? WHERE hash = ?').run(answer?.answer ?? null, answer?.answeredAt ?? null, hash)
  }

  /** Empty Bin: SlideWell's proposal records for these items go (one transaction). */
  deleteProposals(hashes: string[]): void {
    if (!hashes.length) return
    const del = this.db.prepare('DELETE FROM sorter_proposals WHERE hash = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const h of hashes) del.run(h)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.db.close()
  }
}

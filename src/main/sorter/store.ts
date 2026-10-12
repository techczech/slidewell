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
 *                    decided_by TEXT,                  which step made the call: rules | history | luna | haiku;
 *                                                      NULL for a local doubtful (tickets 07, 16). luna =
 *                                                      OpenAI's Luna, haiku = Anthropic's Haiku
 *                    decided_model TEXT)               the model id when a cloud model made the call
 *                                                      (gpt-6-luna, claude-haiku-5-5); NULL otherwise
 *   sorter_cloud_answers(hash TEXT, provider TEXT,    one row per screenshot AND provider (PRIMARY KEY
 *                    verdict TEXT, confidence REAL,    (hash, provider)): what that provider's model answered,
 *                    reason TEXT, model TEXT,          so a provider is asked about a screenshot once and the
 *                    prompt_version TEXT,              answer is re-applied on later local sorts. provider is
 *                    asked_at TEXT)                    'openai' | 'anthropic', or 'unknown' for a row stored
 *                                                      before the column existed whose model id is neither
 *                                                      provider's (migrateCloudAnswers). A row counts as that
 *                                                      provider's answer only under its current model + prompt.
 *                                                      Who may be asked: eligibleSql. Until ticket 17 the table
 *                                                      was keyed by hash alone (one row per screenshot)
 *   sorter_cloud_claims(hash TEXT PRIMARY KEY, run_id TEXT, claimed_at TEXT, counted INTEGER)
 *                                                      screenshots a cloud run has claimed and is sending now;
 *                                                      claimed in one write transaction, so two processes can
 *                                                      never send the same screenshot; released when the run
 *                                                      ends (a crashed run's claims go stale after CLAIM_STALE_MS);
 *                                                      counted = 1 once it went into a request (admitForRequest)
 *   sorter_cloud_allowance(night TEXT PRIMARY KEY, sent INTEGER)
 *                                                      how many screenshots were put into a request to a cloud
 *                                                      model, whichever provider (one allowance for both), in
 *                                                      each night window (schedule.ts nightOf), nightly and Sort
 *                                                      now alike; counted when the request is built, never at the
 *                                                      claim, so a run that dies before sending uses none of it
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
import { providerOfModel, type AnswerScope, type ProviderId } from './cloud/provider'
import { inWindow, isEverything, type PeriodWindow } from './period'

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

export type ProposalRow = { hash: string; proposal: Proposal; confidence: number; pKeep: number; reason: string; rule: string | null; decidedBy?: DecidedBy | null; decidedModel?: string | null }

/**
 * A doubtful proposal the cloud step may ask the selected provider about (eligibleSql).
 * `secondOpinion`: another provider has answered it and was unsure; false when no provider has.
 */
export type CloudPending = { hash: string; confidence: number; pKeep: number; reason: string; secondOpinion: boolean }

export type CloudAnswerRow = LunaAnswer & { hash: string; provider: ProviderId; model: string; promptVersion: string; askedAt: string }

/**
 * Which proposals and answers count for the cloud step: the current sorter; the provider that is
 * asking, with its current model and prompt; `others`, the other providers with theirs;
 * `throwawayAt`, the confidence from which a throwaway answer is a decision (the sorter's throwaway
 * threshold, cascade.ts isConfident); and `secondOpinions`, the switch in Settings: false means a
 * screenshot another provider has answered is never eligible, whatever that answer was and whatever
 * model or prompt it was given under (absent: they are allowed, as before there was a switch;
 * cloud/service.ts always says which).
 */
export type CloudScope = AnswerScope & { sorterVersion: string; others?: ReadonlyArray<AnswerScope>; throwawayAt: number; secondOpinions?: boolean }

/** A stored answer with who gave it, the model + prompt it was given under, and when. */
export type StoredCloudAnswer = LunaAnswer & { provider: ProviderId; model: string; promptVersion: string; askedAt: string }

/** The answers table could not be brought to its current shape, so nothing may be read from or written to it. */
export class CloudAnswersUnavailable extends Error {
  constructor() {
    super('The cloud answers stored on this Mac could not be read')
    this.name = 'CloudAnswersUnavailable'
  }
}

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
  if (!cols.has('decided_model')) db.exec('ALTER TABLE sorter_proposals ADD COLUMN decided_model TEXT')
}

const answersTableSql = (name: string): string => `
  CREATE TABLE ${name} (
    hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('keep', 'throwaway', 'unsure')),
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    asked_at TEXT NOT NULL,
    PRIMARY KEY (hash, provider)
  )`

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).some((c) => c.name === column)

/**
 * sorter_cloud_answers from one row per screenshot to one row per screenshot and provider (ticket 17),
 * in place. Every existing row is kept, with the provider its model id belongs to (the model id was
 * the one record of who answered: provider.ts providerOfModel); a row whose model id is neither
 * provider's is kept as provider 'unknown', which counts as nobody's answer, exactly as before.
 *
 * One write transaction: the new table is built beside the old one, filled, checked to hold as many
 * rows, and only then takes its place. Anything that goes wrong (the database is busy, a row the new
 * table refuses, a count that differs) rolls all of it back and throws: the old table is untouched.
 * Does nothing when the table already has the provider column, so running it again is harmless.
 * Returns the number of rows carried over, or null when there was nothing to do.
 */
export function migrateCloudAnswers(db: DatabaseSync): number | null {
  const current = (): boolean => !hasTable(db, 'sorter_cloud_answers') || hasColumn(db, 'sorter_cloud_answers', 'provider')
  if (current()) return null
  const NEXT = 'sorter_cloud_answers_by_provider'
  db.exec('BEGIN IMMEDIATE')
  try {
    // read again inside the transaction: another process may have done it while this one waited
    if (current()) {
      db.exec('COMMIT')
      return null
    }
    db.exec(answersTableSql(NEXT))
    const put = db.prepare(`INSERT INTO ${NEXT} (hash, provider, verdict, confidence, reason, model, prompt_version, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const old = db.prepare('SELECT hash, verdict, confidence, reason, model, prompt_version, asked_at FROM sorter_cloud_answers').all() as Array<Record<string, string | number | null>>
    for (const r of old) put.run(r.hash, providerOfModel(String(r.model)) ?? 'unknown', r.verdict, r.confidence, r.reason, r.model, r.prompt_version, r.asked_at)
    const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
    const before = count('sorter_cloud_answers')
    if (count(NEXT) !== before) throw new Error('cloud answers: the copy does not hold every row')
    db.exec(`DROP TABLE sorter_cloud_answers; ALTER TABLE ${NEXT} RENAME TO sorter_cloud_answers`)
    db.exec('COMMIT')
    return before
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* the failed statement already ended the transaction */
    }
    throw e
  }
}

/** One provider's row, by its current model + prompt (alias c). Three parameters: scopeArgs. */
const ANSWERED_BY = '(c.provider = ? AND c.model = ? AND c.prompt_version = ?)'
/** An answer that is a decision (alias c): the same test as cascade.ts isConfident. One parameter: the throwaway threshold. */
const CONFIDENT_SQL = "(c.verdict = 'keep' OR (c.verdict = 'throwaway' AND c.confidence >= ?))"
const scopeArgs = (x: AnswerScope): string[] => [x.provider, x.model, x.promptVersion]

/** The sorter's own tables in triage.db: proposals and trained models. */
export class SorterStore {
  private db: DatabaseSync
  /** False when sorter_cloud_answers could not be migrated: its old rows are left as they are and the cloud methods refuse. */
  private answersReady = true

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
        decided_by TEXT,
        decided_model TEXT
      );
      ${answersTableSql('IF NOT EXISTS sorter_cloud_answers')};
      CREATE TABLE IF NOT EXISTS sorter_cloud_claims (
        hash TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        counted INTEGER NOT NULL DEFAULT 0
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
    const claimCols = new Set((this.db.prepare("SELECT name FROM pragma_table_info('sorter_cloud_claims')").all() as Array<{ name: string }>).map((c) => c.name))
    if (!claimCols.has('counted')) this.db.exec('ALTER TABLE sorter_cloud_claims ADD COLUMN counted INTEGER NOT NULL DEFAULT 0')
    try {
      migrateCloudAnswers(this.db)
    } catch {
      // the old rows stay where they are; proposals, review and models still work, the cloud step does not
      this.answersReady = false
    }
  }

  /** Whether the cloud answers can be read and written (false: the table is still in its old shape). */
  cloudAnswersReady(): boolean {
    return this.answersReady
  }

  private needAnswers(): void {
    if (!this.answersReady) throw new CloudAnswersUnavailable()
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
      `INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at, decided_by, decided_model, throwaway_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'throwaway' THEN ? END)
       ON CONFLICT(hash) DO UPDATE SET proposal = excluded.proposal, confidence = excluded.confidence, p_keep = excluded.p_keep,
         reason = excluded.reason, rule = excluded.rule, sorter_version = excluded.sorter_version, model_id = excluded.model_id, proposed_at = excluded.proposed_at,
         decided_by = excluded.decided_by, decided_model = excluded.decided_model,
         throwaway_since = CASE WHEN excluded.proposal != 'throwaway' THEN NULL
                                WHEN sorter_proposals.proposal = 'throwaway' AND sorter_proposals.throwaway_since IS NOT NULL THEN sorter_proposals.throwaway_since
                                ELSE excluded.proposed_at END`
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) put.run(r.hash, r.proposal, r.confidence, r.pKeep, r.reason, r.rule, sorterVersion, modelId, now, r.decidedBy ?? null, r.decidedModel ?? null, r.proposal, now)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * The cloud eligibility test for proposal `p` and the scope's provider, as SQL. Eligible: doubtful,
   * made under the current sorter, not answered in review, no decision of his (kept or excluded in
   * Triage), and among the answers stored for it
   *   - none from this provider (so a provider is asked about a screenshot once), and
   *   - none from another provider that is a decision (CONFIDENT_SQL).
   * That leaves two kinds: screenshots no provider has answered, and screenshots another provider
   * answered and was unsure about (a second opinion). Once every provider has answered one, it is
   * never eligible again, whichever is selected. An answer counts only under its provider's current
   * model + prompt. With second opinions switched off (scope.secondOpinions false) the second kind
   * goes too, and there the other provider is told by its identity alone: any stored answer that is
   * not this provider's makes the screenshot ineligible, whatever model or prompt it was given under
   * (an answer from an older model is still an answer he would be asking a second opinion on).
   * Parameters: eligibleArgs(scope).
   */
  private eligibleSql(o: CloudScope): string {
    const decisions = hasTable(this.db, 'triage_decisions') ? 'AND NOT EXISTS (SELECT 1 FROM triage_decisions d WHERE d.hash = p.hash)' : ''
    const others = (o.others ?? []).map(() => ANSWERED_BY).join(' OR ')
    const decidedElsewhere = o.secondOpinions === false ? ' OR c.provider != ?' : !others ? '' : ` OR ((${others}) AND ${CONFIDENT_SQL})`
    return `p.proposal = 'doubtful' AND p.answered_at IS NULL AND p.sorter_version = ?
      AND NOT EXISTS (SELECT 1 FROM sorter_cloud_answers c WHERE c.hash = p.hash AND (${ANSWERED_BY}${decidedElsewhere})) ${decisions}`
  }

  private eligibleArgs(o: CloudScope): Array<string | number> {
    const others = o.others ?? []
    if (o.secondOpinions === false) return [o.sorterVersion, ...scopeArgs(o), o.provider]
    return [o.sorterVersion, ...scopeArgs(o), ...others.flatMap(scopeArgs), ...(others.length ? [o.throwawayAt] : [])]
  }

  /**
   * Doubtful proposals the cloud step may ask the scope's provider about (eligibleSql), whether or not
   * a run holds them; each says whether it would be a second opinion (another provider has answered it).
   */
  cloudPending(scope: CloudScope): CloudPending[] {
    this.needAnswers()
    const others = scope.others ?? []
    const second = others.length ? `EXISTS (SELECT 1 FROM sorter_cloud_answers c WHERE c.hash = p.hash AND (${others.map(() => ANSWERED_BY).join(' OR ')}))` : '0'
    return (
      this.db
        .prepare(`SELECT p.hash AS hash, p.confidence AS confidence, p.p_keep AS p_keep, p.reason AS reason, ${second} AS second FROM sorter_proposals p WHERE ${this.eligibleSql(scope)}`)
        .all(...others.flatMap(scopeArgs), ...this.eligibleArgs(scope)) as Array<{ hash: string; confidence: number; p_keep: number; reason: string; second: number }>
    ).map((r) => ({ hash: r.hash, confidence: Number(r.confidence), pKeep: Number(r.p_keep), reason: r.reason, secondOpinion: Number(r.second) === 1 }))
  }

  /** Screenshots sent to a cloud model in this night window so far, both providers together. */
  allowanceUsed(night: string): number {
    const r = this.db.prepare('SELECT sent FROM sorter_cloud_allowance WHERE night = ?').get(night) as { sent: number } | undefined
    return r ? Number(r.sent) : 0
  }

  /**
   * Claim screenshots for one cloud run, in one write transaction (BEGIN IMMEDIATE, so a second
   * process waits and then sees these claims): of `hashes`, in order, those still eligible and not
   * held by another live run, at most what is left of `limit` for `night`. A claim uses no allowance;
   * admitForRequest counts each screenshot when it goes into a request. Returns the claimed hashes.
   */
  claimForCloud(hashes: string[], o: CloudScope & { night: string; limit: number; runId: string; now: Date }): { claimed: string[]; leftBefore: number } {
    this.needAnswers()
    const nowIso = o.now.toISOString()
    const staleBefore = new Date(o.now.getTime() - CLAIM_STALE_MS).toISOString()
    const eligible = this.db.prepare(
      `SELECT 1 FROM sorter_proposals p WHERE p.hash = ? AND ${this.eligibleSql(o)} AND NOT EXISTS (SELECT 1 FROM sorter_cloud_claims k WHERE k.hash = p.hash)`
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
        if (claimed.includes(h) || !eligible.get(h, ...this.eligibleArgs(o))) continue
        claim.run(h, o.runId, nowIso)
        claimed.push(h)
      }
      this.db.exec('COMMIT')
      return { claimed, leftBefore }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Called just before every HTTP attempt (first try and each retry), in one write transaction: of
   * `hashes`, those this run still holds and that are still eligible. Each one not yet counted is
   * counted against `night`'s allowance now, while room is left under `limit`; one that does not fit
   * is dropped (overLimit). A retry passes already-counted ones through without counting them again.
   * Returns the hashes that may go into this request, in order.
   *
   * `window` is the frozen period window of a manual batch (period.ts; absent, or EVERYTHING, for a
   * run that takes everything: then no date is read). Under a limited window the capture time now
   * recorded for each of these screenshots (triage_fts.taken_at, read inside this transaction) must
   * be inside it. `paths` names, per hash, the file the run is about to send; the time checked is that
   * file's row (every row for the hash when no path is given), and a screenshot with no row is
   * outside. If any is outside (outOfPeriod, how many), the batch is no longer the one that was
   * confirmed: nothing is admitted and nothing is counted by this call, and the caller stops its run.
   * What an earlier call counted stays counted.
   */
  admitForRequest(
    hashes: string[],
    o: CloudScope & { runId: string; night: string; limit: number; window?: PeriodWindow; paths?: ReadonlyMap<string, string> }
  ): { admitted: string[]; overLimit: number; outOfPeriod?: number } {
    this.needAnswers()
    const limited = o.window && !isEverything(o.window) ? o.window : null
    const q = this.db.prepare(
      `SELECT k.counted AS counted FROM sorter_proposals p JOIN sorter_cloud_claims k ON k.hash = p.hash AND k.run_id = ? WHERE p.hash = ? AND ${this.eligibleSql(o)}`
    )
    const mark = this.db.prepare('UPDATE sorter_cloud_claims SET counted = 1 WHERE hash = ? AND run_id = ?')
    const admitted: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let left = Math.max(0, Math.floor(o.limit) - this.allowanceUsed(o.night))
      let added = 0
      let overLimit = 0
      // those this run holds and may still ask about, with whether each was already counted
      const held: Array<{ hash: string; counted: boolean }> = []
      for (const h of hashes) {
        const r = q.get(o.runId, h, ...this.eligibleArgs(o)) as { counted: number } | undefined
        if (r) held.push({ hash: h, counted: Boolean(Number(r.counted)) })
      }
      if (limited) {
        const inside = this.takenInside(held.map((x) => x.hash), limited, o.paths)
        const outOfPeriod = held.filter((x) => !inside.has(x.hash)).length
        if (outOfPeriod) {
          this.db.exec('COMMIT')
          return { admitted: [], overLimit: 0, outOfPeriod }
        }
      }
      for (const { hash: h, counted } of held) {
        if (!counted) {
          if (left <= 0) {
            overLimit++
            continue
          }
          mark.run(h, o.runId)
          left--
          added++
        }
        admitted.push(h)
      }
      if (added) {
        this.db
          .prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?) ON CONFLICT(night) DO UPDATE SET sent = sorter_cloud_allowance.sent + excluded.sent')
          .run(o.night, added)
      }
      this.db.exec('COMMIT')
      return limited ? { admitted, overLimit, outOfPeriod: 0 } : { admitted, overLimit }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Of `hashes`, those whose capture time as recorded now is inside the window. The rows read are
   * the ones the cloud step picks from (pictures on this Mac: loadUndecided); for a hash with a path
   * in `paths`, only that file's row. A hash with no such row, or with any such row outside the
   * window, is not inside. One read for all of them (triage_fts has no index on hash).
   */
  private takenInside(hashes: string[], w: PeriodWindow, paths?: ReadonlyMap<string, string>): Set<string> {
    const inside = new Set<string>()
    if (!hashes.length || !hasTable(this.db, 'triage_fts')) return inside
    const rows = this.db
      .prepare(`SELECT hash, source, rel_path, taken_at FROM triage_fts WHERE kind = 'image' AND offline = '0' AND hash IN (${hashes.map(() => '?').join(', ')})`)
      .all(...hashes) as Array<{ hash: string; source: string | null; rel_path: string | null; taken_at: string | null }>
    const outside = new Set<string>()
    for (const r of rows) {
      const path = paths?.get(r.hash)
      if (path !== undefined && (!r.source || !r.rel_path || join(r.source, r.rel_path) !== path)) continue
      if (inWindow(r.taken_at, w)) inside.add(r.hash)
      else outside.add(r.hash)
    }
    for (const h of outside) inside.delete(h)
    return inside
  }

  /** End of a run: its claims go. The allowance holds only what went into a request, so nothing is given back. */
  releaseClaims(runId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM sorter_cloud_claims WHERE run_id = ?').run(runId)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** The stored answers that count for these providers (each under its current model + prompt), by hash: at most one per provider. */
  cloudAnswersIn(scopes: ReadonlyArray<AnswerScope>): Map<string, StoredCloudAnswer[]> {
    this.needAnswers()
    const out = new Map<string, StoredCloudAnswer[]>()
    if (!scopes.length) return out
    const rows = this.db
      .prepare(`SELECT c.hash AS hash, c.provider AS provider, c.verdict AS verdict, c.confidence AS confidence, c.reason AS reason, c.model AS model, c.prompt_version AS prompt_version, c.asked_at AS asked_at
                FROM sorter_cloud_answers c WHERE ${scopes.map(() => ANSWERED_BY).join(' OR ')} ORDER BY c.asked_at, c.provider`)
      .all(...scopes.flatMap(scopeArgs)) as Array<{ hash: string; provider: ProviderId; verdict: LunaAnswer['verdict']; confidence: number; reason: string; model: string; prompt_version: string; asked_at: string }>
    for (const r of rows) {
      const a: StoredCloudAnswer = { provider: r.provider, verdict: r.verdict, confidence: Number(r.confidence), reason: r.reason, model: r.model, promptVersion: r.prompt_version, askedAt: r.asked_at }
      const list = out.get(r.hash)
      if (list) list.push(a)
      else out.set(r.hash, [a])
    }
    return out
  }

  /**
   * Record a cloud model's answers and, in the same transaction, the proposals they lead to. An answer
   * takes its own provider's row for that screenshot; another provider's row for it is left as it is.
   * A proposal is changed only while it is still doubtful, unanswered and without a decision of his in
   * Triage (review or Triage may have got there first). Reasons arrive already redacted
   * (cloud/service.ts). Returns the hashes whose proposal changed.
   */
  saveCloudResults(answers: CloudAnswerRow[], proposals: Array<Pick<ProposalRow, 'hash' | 'proposal' | 'confidence' | 'pKeep' | 'reason' | 'decidedBy' | 'decidedModel'>>): string[] {
    this.needAnswers()
    if (!answers.length && !proposals.length) return []
    const now = new Date().toISOString()
    const putAnswer = this.db.prepare(
      `INSERT INTO sorter_cloud_answers (hash, provider, verdict, confidence, reason, model, prompt_version, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash, provider) DO UPDATE SET verdict = excluded.verdict, confidence = excluded.confidence, reason = excluded.reason,
         model = excluded.model, prompt_version = excluded.prompt_version, asked_at = excluded.asked_at`
    )
    const putProposal = this.db.prepare(
      `UPDATE sorter_proposals SET proposal = ?, confidence = ?, p_keep = ?, reason = ?, decided_by = ?, decided_model = ?, proposed_at = ?,
         throwaway_since = CASE WHEN ? = 'throwaway' THEN ? END
       WHERE hash = ? AND proposal = 'doubtful' AND answered_at IS NULL
         ${hasTable(this.db, 'triage_decisions') ? 'AND NOT EXISTS (SELECT 1 FROM triage_decisions d WHERE d.hash = sorter_proposals.hash)' : ''}`
    )
    const changed: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const a of answers) putAnswer.run(a.hash, a.provider, a.verdict, a.confidence, a.reason, a.model, a.promptVersion, a.askedAt)
      for (const p of proposals) if (Number(putProposal.run(p.proposal, p.confidence, p.pKeep, p.reason, p.decidedBy ?? null, p.decidedModel ?? null, now, p.proposal, now, p.hash).changes)) changed.push(p.hash)
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

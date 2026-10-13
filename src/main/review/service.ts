/**
 * The review screen's action layer (ticket 08): read the piles, apply his Keep / Throwaway / Rescue,
 * undo the last one, empty the Bin.
 *
 * Write-path rules:
 *   - His choice is written to triage_decisions through triage.ts, the path the Triage panel uses;
 *     the sorter's proposal is only marked answered. Keep promotes into the well through the same
 *     ingest path as Triage's Import.
 *   - Nothing here deletes or moves a file, and nothing deletes a well record. Throwaway and Bin are
 *     record states. Emptying the Bin is his own action: it writes a permanent 'emptied' marker
 *     (one transaction, only for rows still in the Bin at write time) and the items are hidden
 *     everywhere. "Emptying the Bin hides these for good. SlideWell never deletes your files."
 *   - Undo restores the exact earlier decision and answer mark. Its history entry is removed only
 *     after the restore has fully succeeded.
 *
 * Teaching the sorter (ticket 22) adds reads only: teachQueue() (the doubtful screenshots he has not
 * decided, least sure first) and the same order for the overview's queue. A teaching answer is act().
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewActResult, ReviewCard, ReviewOverview, ReviewPage, ReviewPiles, ReviewUndoResult, EmptyBinResult, TeachQueue } from '../../preload'
import { binToken, CARDS_MAX, compareKeys, HASH, keysetPage, pileKey, pileOf, planAction, summarise, teachKey, BIN_AFTER_DAYS, type PileKey, type PileView, type ReviewAction } from './piles'
import { newestFirst, readReviewRows, timeOf, type ReviewRow } from './store'
import { putTriageDecision, promoteTriageHashes, writeEmptiedMarkers, type PromoteResult, type TriageDecisionRow } from '../triage'
import { SorterStore } from '../sorter/store'
import { SORTER_VERSION } from '../sorter/decide'

export type ReviewDeps = {
  wellRoot: () => string
  archiveRoot: () => string
  /** Fallback root for triage rows that carry no source (older scans). */
  sourceRoot: () => string | null
  thumbUrl: (abs: string | null) => string | null
  now?: () => number
  /** Keep's promotion into the well; defaults to triage.ts promoteTriageHashes for these hashes. */
  promote?: (hashes: string[]) => Promise<PromoteResult>
  /** Something changed (re-list Triage, poke picture search). */
  changed?: () => void
  /** `why` in plain words for these cards, by hash (sorter/why.ts whyReader). Absent: the sorter's reason. */
  why?: (items: Array<{ hash: string; app: string | null; reason: string }>) => Map<string, string>
}

type Item = { row: ReviewRow; view: PileView }
type UndoEntry = {
  hash: string
  prior: TriageDecisionRow | null
  priorAnswer: { answer: string; answeredAt: string } | null
}

const UNDO_DEPTH = 50

export class ReviewService {
  private undoStack: UndoEntry[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private migrated = new Set<string>()

  constructor(private deps: ReviewDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** One operation at a time: an action never interleaves with another or with a read. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private withSorterStore<T>(fn: (s: SorterStore) => T): T {
    const s = new SorterStore(this.deps.wellRoot())
    try {
      return fn(s)
    } finally {
      s.close()
    }
  }

  /** Bring an older sorter_proposals table up to the review columns (never creates triage.db). */
  private migrate(): void {
    const root = this.deps.wellRoot()
    if (this.migrated.has(root) || !existsSync(join(root, 'triage.db'))) return
    this.withSorterStore(() => undefined)
    this.migrated.add(root)
  }

  private items(): Item[] {
    this.migrate()
    const now = this.now()
    return readReviewRows(this.deps.wellRoot())
      .map((row) => ({ row, view: pileOf(row, now) }))
      .filter((i) => i.view.pile !== 'gone')
  }

  /** Cards for a list he teaches from: each with its `why` (one read for all of them). */
  private taught(items: Item[]): ReviewCard[] {
    const why = this.deps.why?.(items.map((i) => ({ hash: i.row.hash, app: i.row.file?.app || null, reason: i.row.reason })))
    return items.map((i) => this.card(i, why?.get(i.row.hash)))
  }

  private card(i: Item, why?: string): ReviewCard {
    const f = i.row.file
    const root = this.deps.wellRoot()
    let abs: string | null = null
    if (f && !f.offline) abs = f.kind === 'video' ? (f.posterRel ? join(root, f.posterRel) : null) : join(f.source || this.deps.sourceRoot() || '', f.relPath)
    return {
      hash: i.row.hash,
      filename: f?.filename ?? i.row.hash,
      app: f?.app || null,
      windowTitle: f?.windowTitle || null,
      takenAt: f?.takenAt || null,
      reason: i.row.reason,
      confidence: i.row.confidence,
      proposal: i.row.proposal,
      pile: i.view.pile as ReviewCard['pile'],
      by: i.view.by,
      decidedBy: i.row.decidedBy,
      binInDays: i.view.binInDays,
      thumbUrl: abs ? this.deps.thumbUrl(abs) : null,
      offline: Boolean(f?.offline),
      pKeep: i.row.pKeep,
      leans: i.row.pKeep >= 0.5 ? 'keep' : 'throwaway',
      why: why ?? i.row.reason
    }
  }

  private teachKeyOf = (i: Item): PileKey => teachKey(i.row.pKeep, timeOf(i.row), i.row.hash)

  /**
   * The teach queue: screenshots he has not decided whose proposal, made under the current sorter,
   * is doubtful; the one the sorter is least sure of first. Paged like the piles (`after` = the
   * cursor of the page before; default 10 a page).
   */
  teachQueue(after: string | null = null, limit?: number): Promise<TeachQueue> {
    return this.serial(() => {
      const queue = this.items().filter((i) => i.view.pile === 'doubtful' && !i.row.answeredAt && i.row.sorterVersion === SORTER_VERSION)
      const pg = keysetPage(queue, this.teachKeyOf, after, typeof limit === 'number' && Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), 500) : 10)
      return { total: pg.total, items: this.taught(pg.items), next: pg.next }
    })
  }

  private head(items: Item[]): { needALook: number; kept: number; throwaway: number; lastSortedAt: string | null } {
    const s = summarise(items.map((i) => ({ view: i.view, proposal: i.row.proposal, decided: Boolean(i.row.decision && i.row.decision.state !== 'undecided') })))
    let last: string | null = null
    for (const i of items) if (i.row.proposedAt && (!last || i.row.proposedAt > last)) last = i.row.proposedAt
    return { needALook: s.needALook, kept: s.confidentKept, throwaway: s.confidentThrowaway, lastSortedAt: last }
  }

  /** `order: 'teach'` lists the queue in the teaching order ("teaches most first") instead of newest first. */
  overview(opts: { queue?: number; sample?: number; order?: unknown } = {}): Promise<ReviewOverview> {
    return this.serial(() => {
      const items = this.items()
      const h = this.head(items)
      const doubtful = items.filter((i) => i.view.pile === 'doubtful')
      const queue = opts.order === 'teach' ? doubtful.sort((a, b) => compareKeys(this.teachKeyOf(a), this.teachKeyOf(b))) : doubtful.sort((a, b) => newestFirst(a.row, b.row))
      const confident = items.filter((i) => i.view.by === 'sorter' && i.view.pile !== 'doubtful').sort((a, b) => newestFirst(a.row, b.row))
      return {
        needALook: h.needALook,
        confident: { kept: h.kept, throwaway: h.throwaway },
        lastSortedAt: h.lastSortedAt,
        queue: this.taught(queue.slice(0, clampN(opts.queue, 50))),
        confidentSample: confident.slice(0, clampN(opts.sample, 12)).map((i) => this.card(i)),
        canUndo: this.undoStack.length > 0
      }
    })
  }

  private pileItems(items: Item[], p: 'kept' | 'throwaway' | 'bin'): Item[] {
    return items.filter((i) => i.view.pile === p)
  }

  private key = (i: Item): PileKey => pileKey(i.view.pile, i.view.binInDays, timeOf(i.row), i.row.hash)

  /** First page of each pile plus totals and the cursor for the next page. More pages: page(). */
  piles(opts: { kept?: number; throwaway?: number; bin?: number } = {}): Promise<ReviewPiles> {
    return this.serial(() => {
      const items = this.items()
      const h = this.head(items)
      const first = (p: 'kept' | 'throwaway' | 'bin', n?: number): { total: number; items: ReviewCard[]; next: string | null } => {
        const pg = keysetPage(this.pileItems(items, p), this.key, null, pageSize(n))
        return { total: pg.total, items: pg.items.map((i) => this.card(i)), next: pg.next }
      }
      const bin = this.pileItems(items, 'bin')
      return {
        needALook: h.needALook,
        confidentTotal: h.kept + h.throwaway,
        lastSortedAt: h.lastSortedAt,
        kept: first('kept', opts.kept),
        throwaway: first('throwaway', opts.throwaway),
        bin: { ...first('bin', opts.bin), token: binToken(bin.map((i) => i.row.hash)) },
        canUndo: this.undoStack.length > 0
      }
    })
  }

  /** The page after `after` (a cursor from piles() or an earlier page): keyset, no cap on how far. */
  page(pile: 'kept' | 'throwaway' | 'bin', after: string | null, limit?: number): Promise<ReviewPage> {
    return this.serial(() => {
      const pg = keysetPage(this.pileItems(this.items(), pile), this.key, after, pageSize(limit))
      return { total: pg.total, items: pg.items.map((i) => this.card(i)), next: pg.next }
    })
  }

  /**
   * The cards for these screenshots, in the order asked for (ticket 23, "See what moved"): at most
   * CARDS_MAX of them, each once. Only what Review shows outside the Bin is answered: a screenshot
   * that is in the Bin, was emptied from it, has no proposal or is not a valid hash is left out.
   * Reads only.
   */
  cards(hashes: string[]): Promise<ReviewCard[]> {
    return this.serial(() => {
      const want = [...new Set(Array.isArray(hashes) ? hashes.filter((h) => typeof h === 'string' && HASH.test(h)) : [])].slice(0, CARDS_MAX)
      if (!want.length) return []
      const asked = new Set(want)
      const found = new Map<string, Item>()
      for (const i of this.items()) if (asked.has(i.row.hash) && i.view.pile !== 'bin') found.set(i.row.hash, i)
      return want.flatMap((h) => (found.has(h) ? [this.card(found.get(h)!)] : []))
    })
  }

  private promote(hashes: string[]): Promise<PromoteResult> {
    if (this.deps.promote) return this.deps.promote(hashes)
    return promoteTriageHashes(this.deps.archiveRoot(), this.deps.wellRoot(), this.deps.sourceRoot() ?? '', hashes)
  }

  act(hash: string, action: ReviewAction): Promise<ReviewActResult> {
    return this.serial(async () => {
      const it = this.items().find((i) => i.row.hash === hash)
      if (!it) return { ok: false, hash, message: 'This screenshot is no longer in review.' }
      const plan = planAction(it.view, action, this.now())
      if (plan.kind !== 'decide') return { ok: plan.kind === 'noop', hash, message: plan.reason, pile: it.view.pile as ReviewCard['pile'] }
      const root = this.deps.wellRoot()
      const d = it.row.decision
      const prior: TriageDecisionRow | null = d ? { state: d.state, decidedAt: d.decidedAt, wellId: d.wellId } : null
      const priorAnswer = it.row.answer ? { answer: it.row.answer, answeredAt: it.row.answeredAt ?? '' } : null
      // his decision first (the well id of an earlier keep is carried, so Empty Bin can find its copy)
      await putTriageDecision(root, hash, { state: plan.state, decidedAt: plan.decidedAt, wellId: prior?.wellId ?? null })
      let message = `Moved to Throwaway — bin in ${BIN_AFTER_DAYS} days. Your original file is not touched.`
      if (plan.promote) {
        // a failed ingest leaves his keep staged (Triage's Import retries it); the decision still stands
        const r = await this.promote([hash]).catch((): PromoteResult => ({ imported: [], skipped: 1, gated: 0 }))
        const imp = r.imported.find((x) => x.hash === hash)
        if (imp) {
          message = action === 'rescue' ? 'Rescued — kept and added to the well.' : 'Kept — added to the well.'
        } else {
          message = r.gated ? 'Kept — a large video; add it with Import in Triage.' : 'Kept — the file is not on this Mac yet; it joins the well when Triage imports it.'
        }
      }
      this.withSorterStore((s) => s.setAnswer(hash, { answer: plan.answer, answeredAt: plan.decidedAt }))
      this.undoStack.push({ hash, prior, priorAnswer })
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
      this.deps.changed?.()
      return { ok: true, hash, message, pile: plan.state === 'selected' ? 'kept' : 'throwaway' }
    })
  }

  undo(): Promise<ReviewUndoResult> {
    return this.serial(async () => {
      const e = this.undoStack[this.undoStack.length - 1]
      if (!e) return { ok: false, message: 'Nothing to undo.' }
      // A well copy that the undone Keep created is left in place, and so is its well record: review
      // never deletes a file or a record. The decision goes back; the copy simply stays in the well.
      try {
        await putTriageDecision(this.deps.wellRoot(), e.hash, e.prior)
        this.withSorterStore((s) => s.setAnswer(e.hash, e.priorAnswer))
      } catch {
        return { ok: false, hash: e.hash, message: 'Undo did not go through; press ⌘Z to try again.' }
      }
      this.undoStack.pop() // only once the restore fully succeeded
      this.deps.changed?.()
      return { ok: true, hash: e.hash, message: 'Undone.' }
    })
  }

  emptyBin(token: string): Promise<EmptyBinResult> {
    return this.serial(async () => {
      const bin = this.items().filter((i) => i.view.pile === 'bin')
      if (typeof token !== 'string' || binToken(bin.map((i) => i.row.hash)) !== token) {
        return { ok: false, emptied: 0, changed: 0, message: 'The Bin changed since you looked; nothing was emptied.' }
      }
      if (!bin.length) return { ok: true, emptied: 0, changed: 0, message: 'The Bin is already empty.' }
      const snapshot = bin.map((i) => ({ hash: i.row.hash, decision: i.row.decision ? { state: i.row.decision.state, decidedAt: i.row.decision.decidedAt, wellId: i.row.decision.wellId } : null }))
      const r = writeEmptiedMarkers(this.deps.wellRoot(), snapshot, this.now())
      const gone = new Set(r.emptied)
      this.undoStack = this.undoStack.filter((u) => !gone.has(u.hash)) // an emptied item cannot be undone
      this.deps.changed?.()
      const n = r.emptied.length
      const left = r.changed.length
      const parts = [n ? `Emptied ${n} from the Bin. SlideWell never deletes your files.` : 'Nothing was emptied.']
      if (left) parts.push(`${left} ${left === 1 ? 'item' : 'items'} changed and ${left === 1 ? 'was' : 'were'} left alone.`)
      return { ok: true, emptied: n, changed: left, message: parts.join(' ') }
    })
  }
}

/** Page size: default 60, at most 500 per request (more by paging). */
function pageSize(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 500) : 60
}

function clampN(n: unknown, dflt: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 500) : dflt
}

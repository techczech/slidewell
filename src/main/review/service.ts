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
import { pictureChooser, type PictureChoice, type PictureState } from './picture'

const SHOWN: ReadonlySet<string> = new Set<PictureState>(['ok', 'not-downloaded', 'missing', 'none'])
import type { ReviewActResult, ReviewBlindAnswers, ReviewCard, ReviewOverview, ReviewPage, ReviewPiles, ReviewRescueResult, ReviewRescueRetrain, ReviewUndoResult, EmptyBinResult, TeachQueue } from '../../preload'
import { blindRescue, BLIND_SINCE_DEFAULT } from './rescue'
import { binToken, CARDS_MAX, compareKeys, HASH, inSure, keysetPage, parseSure, pileKey, pileOf, planAction, summarise, teachKey, BIN_AFTER_DAYS, type PileKey, type SureRange, type PileView, type ReviewAction } from './piles'
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
  /** The roots pictures may be served from (index.ts allowedRoots). Absent: any path counts. */
  allowedRoots?: () => string[]
  now?: () => number
  /** Keep's promotion into the well; defaults to triage.ts promoteTriageHashes for these hashes. */
  promote?: (hashes: string[]) => Promise<PromoteResult>
  /** Something changed (re-list Triage, poke picture search). */
  changed?: () => void
  /** `why` in plain words for these cards, by hash (sorter/why.ts whyReader). Absent: the sorter's reason. */
  why?: (items: Array<{ hash: string; app: string | null; reason: string }>) => Map<string, string>
  /** Start a retrain (Retrainer.retrain('manual')): asked once after blind answers were put back (rescue.ts). */
  retrain?: () => unknown
}

type Item = { row: ReviewRow; view: PileView }
type UndoEntry = {
  hash: string
  prior: TriageDecisionRow | null
  priorAnswer: { answer: string; answeredAt: string; picture: string | null } | null
}

const UNDO_DEPTH = 50

/** The words for a retrain that broke without saying why (as the teaching round says it). */
const RETRAIN_FAILED = 'The sorter could not retrain just now.'
/** A training's outcome (Retrainer's result) as the banner reports it: ok, or the reason it did not finish. */
function retrainEnd(o: unknown): ReviewRescueRetrain {
  const r = o && typeof o === 'object' ? (o as { ok?: unknown; error?: unknown }) : {}
  if (r.ok === true) return { ok: true }
  return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : RETRAIN_FAILED }
}

export class ReviewService {
  private undoStack: UndoEntry[] = []
  private chain: Promise<unknown> = Promise.resolve()
  /** An operation of the queue (serial) is running: rescue() checks it, since its set check depends on it. */
  private inQueue = false
  private migrated = new Set<string>()
  /** The retrain asked for by the last rescue that put anything back, by id (rescueBlind's `retrain`). */
  private rescueTraining: { id: number; end: Promise<ReviewRescueRetrain> } | null = null
  private rescueSeq = 0

  constructor(private deps: ReviewDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** One operation at a time: an action never interleaves with another or with a read. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(async () => {
      this.inQueue = true
      try {
        return await fn()
      } finally {
        this.inQueue = false
      }
    })
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

  private items(sure?: SureRange): Item[] {
    this.migrate()
    const now = this.now()
    return readReviewRows(this.deps.wellRoot())
      .map((row) => ({ row, view: pileOf(row, now) }))
      .filter((i) => i.view.pile !== 'gone' && inSure(i.row.pKeep, sure))
  }

  /** A `sure` that reached the service unvalidated is refused, never clamped (ipc.ts refuses it first). */
  private sureOf(x: unknown): SureRange | undefined {
    if (x === undefined) return undefined
    const r = parseSure(x)
    if (!r) throw new Error('review: bad how-sure range')
    return r
  }

  /** Cards for a list he teaches from: each with its `why` (one read for all of them). */
  private taught(items: Item[]): ReviewCard[] {
    const why = this.deps.why?.(items.map((i) => ({ hash: i.row.hash, app: i.row.file?.app || null, reason: i.row.reason })))
    const choose = this.chooser()
    return items.map((i) => this.card(i, why?.get(i.row.hash), choose))
  }

  /** One chooser per read: each hash is looked at on disk once, however many cards show it. */
  private chooser(): (hash: string, copies: ReviewRow['copies']) => PictureChoice {
    return pictureChooser({ wellRoot: this.deps.wellRoot, sourceRoot: this.deps.sourceRoot, allowedRoots: this.deps.allowedRoots })
  }

  private card(i: Item, why?: string, choose: (hash: string, copies: ReviewRow['copies']) => PictureChoice = this.chooser()): ReviewCard {
    const f = i.row.file
    const pic = choose(i.row.hash, i.row.copies)
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
      thumbUrl: pic.abs ? this.deps.thumbUrl(pic.abs) : null,
      offline: pic.state === 'not-downloaded' || Boolean(f?.offline),
      picture: pic.state,
      revealUrl: pic.originalAbs ? this.deps.thumbUrl(pic.originalAbs) : null,
      expectedDir: pic.expectedDir,
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
  overview(opts: { queue?: number; sample?: number; order?: unknown; sure?: unknown } = {}): Promise<ReviewOverview> {
    return this.serial(() => {
      const sure = this.sureOf(opts.sure)
      const everything = this.items()
      const items = sure ? everything.filter((i) => inSure(i.row.pKeep, sure)) : everything
      const h = this.head(items)
      const all = sure ? this.head(everything) : h
      const doubtful = items.filter((i) => i.view.pile === 'doubtful')
      const queue = opts.order === 'teach' ? doubtful.sort((a, b) => compareKeys(this.teachKeyOf(a), this.teachKeyOf(b))) : doubtful.sort((a, b) => newestFirst(a.row, b.row))
      const confident = items.filter((i) => i.view.by === 'sorter' && i.view.pile !== 'doubtful').sort((a, b) => newestFirst(a.row, b.row))
      return {
        needALook: h.needALook,
        confident: { kept: h.kept, throwaway: h.throwaway },
        all: { needALook: all.needALook, confident: all.kept + all.throwaway },
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
  piles(opts: { kept?: number; throwaway?: number; bin?: number; sure?: unknown } = {}): Promise<ReviewPiles> {
    return this.serial(() => {
      const sure = this.sureOf(opts.sure)
      const items = this.items(sure)
      const h = this.head(items)
      const first = (p: 'kept' | 'throwaway' | 'bin', n?: number): { total: number; items: ReviewCard[]; next: string | null } => {
        const pg = keysetPage(this.pileItems(items, p), this.key, null, pageSize(n))
        return { total: pg.total, items: pg.items.map((i) => this.card(i)), next: pg.next }
      }
      // Empty Bin acts on the whole Bin. Only an unfiltered answer carries its token, so the count the confirm shows (bin.total)
      // and the token emptyBin() accepts always come from the same read of the whole Bin; an answer under a range carries none.
      const token = sure ? null : binToken(this.pileItems(items, 'bin').map((i) => i.row.hash))
      return {
        needALook: h.needALook,
        confidentTotal: h.kept + h.throwaway,
        lastSortedAt: h.lastSortedAt,
        kept: first('kept', opts.kept),
        throwaway: first('throwaway', opts.throwaway),
        bin: { ...first('bin', opts.bin), token },
        canUndo: this.undoStack.length > 0
      }
    })
  }

  /** The page after `after` (a cursor from piles() or an earlier page): keyset, no cap on how far. */
  page(pile: 'kept' | 'throwaway' | 'bin', after: string | null, limit?: number, sure?: unknown): Promise<ReviewPage> {
    return this.serial(() => {
      const pg = keysetPage(this.pileItems(this.items(this.sureOf(sure)), pile), this.key, after, pageSize(limit))
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

  /**
   * `shown`: the picture state the card was shown with (the renderer's ReviewShot shownPicture). Recorded with the answer
   * is the worse of it and main's own file check: a file that is there but would not load was seen as missing.
   * Absent: main's own check.
   */
  act(hash: string, action: ReviewAction, shown?: PictureState): Promise<ReviewActResult> {
    return this.serial(async () => {
      const it = this.items().find((i) => i.row.hash === hash)
      if (!it) return { ok: false, hash, message: 'This screenshot is no longer in review.' }
      const plan = planAction(it.view, action, this.now())
      if (plan.kind !== 'decide') return { ok: plan.kind === 'noop', hash, message: plan.reason, pile: it.view.pile as ReviewCard['pile'] }
      const root = this.deps.wellRoot()
      const d = it.row.decision
      const prior: TriageDecisionRow | null = d ? { state: d.state, decidedAt: d.decidedAt, wellId: d.wellId } : null
      const priorAnswer = it.row.answer ? { answer: it.row.answer, answeredAt: it.row.answeredAt ?? '', picture: it.row.answeredPicture } : null
      // the picture he was shown, as the card had it (the same chooser as card()), recorded with the answer (rescue.ts)
      const own = this.chooser()(hash, it.row.copies).state
      const picture: PictureState = own !== 'ok' ? own : shown && SHOWN.has(shown) && shown !== 'ok' ? shown : own
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
      this.withSorterStore((s) => s.setAnswer(hash, { answer: plan.answer, answeredAt: plan.decidedAt, picture }))
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

  private rescuer(): ReturnType<typeof blindRescue> {
    return blindRescue({ wellRoot: this.deps.wellRoot, sourceRoot: this.deps.sourceRoot, allowedRoots: this.deps.allowedRoots, retrain: this.deps.retrain, inQueue: () => this.inQueue })
  }

  /** Review answers given on cards with no picture since `since` (rescue.ts findBlind): counts and the token rescueBlind() takes. Reads only. */
  blindAnswers(since: string = BLIND_SINCE_DEFAULT): Promise<ReviewBlindAnswers> {
    return this.serial(() => {
      this.migrate()
      const f = this.rescuer().findBlind(since)
      // the list and the counts come from the same read as the token
      const items = f.items.map((i) => ({ hash: i.hash, filename: i.filename, answer: i.answer, picture: i.picture, recorded: i.recorded, putBack: i.putBack }))
      return { thrownAway: f.thrownAway, kept: f.keptImported + f.keptNotImported, keptImported: f.keptImported, keptNotImported: f.keptNotImported, emptied: f.emptied, items, token: f.token }
    })
  }

  /**
   * Put the blind answers he confirmed (same token) back to undecided and ask for a retrain (rescue.ts rescue).
   * Their undo entries go: undo would bring the blind answer back.
   */
  rescueBlind(token: string, since: string = BLIND_SINCE_DEFAULT): Promise<ReviewRescueResult> {
    return this.serial(() => {
      this.migrate()
      const r = this.rescuer().rescue(token, since)
      if (r.ok && r.reset) {
        const back = new Set(r.hashes)
        this.undoStack = this.undoStack.filter((u) => !back.has(u.hash))
        this.deps.changed?.()
      }
      if (r.retrain) {
        // held from the moment of the reset, so a training that ends before the renderer asks is still reported
        const id = ++this.rescueSeq
        this.rescueTraining = { id, end: r.retrain.then(retrainEnd, () => ({ ok: false, error: RETRAIN_FAILED })) }
        return { ok: r.ok, reset: r.reset, retrain: id }
      }
      return r.error ? { ok: r.ok, reset: r.reset, error: r.error } : { ok: r.ok, reset: r.reset }
    })
  }

  /**
   * How the retrain asked for by rescueBlind (its `retrain` id) ended: answers once that training has run or failed,
   * at once if it already has. Null for an id that is not the last rescue's (nothing to report). Not queued: it waits
   * on the training, not on the well.
   */
  rescueRetrain(id: number): Promise<ReviewRescueRetrain | null> {
    const t = this.rescueTraining
    return t && t.id === id ? t.end : Promise.resolve(null)
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

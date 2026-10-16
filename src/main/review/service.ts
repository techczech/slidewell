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
import type { ReviewActResult, ReviewAnswersSince, ReviewDownloadProgress, ReviewDownloadResult, ReviewBlindAnswers, ReviewCard, ReviewOverview, ReviewPage, ReviewPiles, ReviewRescueResult, ReviewRescueRetrain, ReviewRetrainAsked, ReviewUndoResult, EmptyBinResult, TeachQueue } from '../../preload'
import { blindRescue, BLIND_SINCE_DEFAULT, kindOf } from './rescue'
import { binToken, CARDS_MAX, compareKeys, HASH, inSure, keysetPage, parseSure, pileKey, pileOf, planAction, summarise, teachKey, BIN_AFTER_DAYS, type PileKey, type SureRange, type PileView, type ReviewAction } from './piles'
import { newestFirst, readReviewRows, timeOf, type ReviewRow } from './store'
import { putTriageDecision, promoteTriageHashes, setTriageOffline, writeEmptiedMarkers, type PromoteResult, type TriageDecisionRow } from '../triage'
import { downloadTargets, type DownloadLoopDeps, type DownloadTarget } from './download'
import { NotOnMacCache } from './not-on-mac-cache'
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
  /**
   * "Leave screenshots that are not on this Mac out of Review and sorting until they are downloaded" (config, default off):
   * read, and stored. On: screenshots whose picture is a cloud placeholder are left out of the queue and the piles (never
   * out of the Not on this Mac view itself).
   */
  leaveOutNotOnMac?: () => boolean
  saveLeaveOutNotOnMac?: (on: boolean) => void
  /** A cloud placeholder on disk (picture.ts datalessOnDisk); a test seam. */
  dataless?: (abs: string) => boolean
  /** Download them (download.ts): the per-file download (default: read in a child process) and its timeout. Test seams. */
  download?: DownloadLoopDeps['download']
  downloadTimeoutMs?: number
  /** Record a file's state on its scan row; default triage.ts setTriageOffline. */
  setOffline?: (wellRoot: string, rowSource: string, relPath: string, offline: boolean) => unknown
  /** Progress of Download them, after each file (index.ts sends it to the window). */
  downloadProgress?: (p: ReviewDownloadProgress) => void
  /** Download them brought files onto this Mac (re-list Triage, poke picture search). Not an answer. */
  downloaded?: () => void
}

/** Which part of Review a read covers: a how-sure range, and the Not on this Mac view. */
type Scope = { sure?: SureRange; notOnMac?: boolean }
type Choose = (hash: string, copies: ReviewRow['copies']) => PictureChoice

type Item = { row: ReviewRow; view: PileView }
type UndoEntry = {
  /** Unique per act in this run of the app: the renderer matches an undo to its act by this, never by hash. */
  id: number
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
  private undoSeq = 0
  /** Download them, while it runs: Cancel aborts it. */
  private fetching: { ctl: AbortController; progress: ReviewDownloadProgress } | null = null
  /** Which screenshots are not on this Mac, per hash, for up to 60 s (not-on-mac-cache.ts). */
  private notOnMacCache: NotOnMacCache

  constructor(private deps: ReviewDeps) {
    this.notOnMacCache = new NotOnMacCache({ now: () => this.now() })
  }

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
  private taught(items: Item[], choose: Choose = this.chooser()): ReviewCard[] {
    const why = this.deps.why?.(items.map((i) => ({ hash: i.row.hash, app: i.row.file?.app || null, reason: i.row.reason })))
    return items.map((i) => this.card(i, why?.get(i.row.hash), choose))
  }

  /** One chooser per read: each hash is looked at on disk once, however many cards show it. */
  private chooser(): (hash: string, copies: ReviewRow['copies']) => PictureChoice {
    return pictureChooser({ wellRoot: this.deps.wellRoot, sourceRoot: this.deps.sourceRoot, allowedRoots: this.deps.allowedRoots, dataless: this.deps.dataless })
  }

  private leaveOut(): boolean {
    try {
      return this.deps.leaveOutNotOnMac?.() === true
    } catch {
      return false
    }
  }

  /**
   * The hashes among `all` whose picture is a cloud placeholder (not on this Mac): not-on-mac-cache.ts, kept up to 60 s
   * per hash and checked in batches that yield to the event loop.
   */
  private away(all: Item[], choose: Choose): Promise<Set<string>> {
    return this.notOnMacCache.notHere(all.map((i) => ({ hash: i.row.hash, copies: i.row.copies })), choose)
  }

  /**
   * Review as a read covers it: the Not on this Mac view holds only screenshots whose picture is not on this Mac
   * (whatever the switch says); otherwise, with "leave them out" on, those are left out. Then the how-sure range.
   * The not-on-this-Mac set is worked out only when the view or the switch needs it (`known`: one already worked out).
   */
  private async scoped(scope: Scope, choose: Choose, all: Item[], known?: Set<string>): Promise<Item[]> {
    const leaveOut = !scope.notOnMac && this.leaveOut()
    const set = scope.notOnMac || leaveOut ? (known ?? (await this.away(all, choose))) : null
    const inView = set === null ? all : all.filter((i) => set.has(i.row.hash) === Boolean(scope.notOnMac))
    return scope.sure ? inView.filter((i) => inSure(i.row.pKeep, scope.sure)) : inView
  }

  /** Files on disk changed (a scan, Download them): what is and is not on this Mac is worked out again at the next read. */
  filesChanged(): void {
    this.notOnMacCache.invalidate()
  }

  /** A Not on this Mac flag that reached the service: true, false or absent; anything else refuses (ipc.ts refuses it first). */
  private cloudOf(x: unknown): boolean {
    if (x === undefined || x === false) return false
    if (x === true) return true
    throw new Error('review: bad not-on-this-Mac flag')
  }

  private card(i: Item, why?: string, choose: Choose = this.chooser()): ReviewCard {
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
    return this.serial(async () => {
      const choose = this.chooser()
      const queue = (await this.scoped({}, choose, this.items())).filter((i) => i.view.pile === 'doubtful' && !i.row.answeredAt && i.row.sorterVersion === SORTER_VERSION)
      const pg = keysetPage(queue, this.teachKeyOf, after, typeof limit === 'number' && Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), 500) : 10)
      return { total: pg.total, items: this.taught(pg.items, choose), next: pg.next }
    })
  }

  private head(items: Item[]): { needALook: number; kept: number; throwaway: number; lastSortedAt: string | null } {
    const s = summarise(items.map((i) => ({ view: i.view, proposal: i.row.proposal, decided: Boolean(i.row.decision && i.row.decision.state !== 'undecided') })))
    let last: string | null = null
    for (const i of items) if (i.row.proposedAt && (!last || i.row.proposedAt > last)) last = i.row.proposedAt
    return { needALook: s.needALook, kept: s.confidentKept, throwaway: s.confidentThrowaway, lastSortedAt: last }
  }

  /** `order: 'teach'` lists the queue in the teaching order ("teaches most first") instead of newest first. */
  overview(opts: { queue?: number; sample?: number; order?: unknown; sure?: unknown; notOnMac?: unknown } = {}): Promise<ReviewOverview> {
    return this.serial(async () => {
      const sure = this.sureOf(opts.sure)
      const notOnMac = this.cloudOf(opts.notOnMac)
      const choose = this.chooser()
      const read = this.items() // one read of the well for the whole answer
      // the Not on this Mac count: need a look and the sorted piles, whatever the range and the switch (worked out once)
      const away = await this.away(read, choose)
      // `all`: Review as he sees it with no range and no Not on this Mac view (the tab's count)
      const everything = await this.scoped({}, choose, read, away)
      const items = await this.scoped({ sure, notOnMac }, choose, read, away)
      const h = this.head(items)
      const all = sure || notOnMac ? this.head(everything) : h
      const cloud = away.size
      const doubtful = items.filter((i) => i.view.pile === 'doubtful')
      const queue = opts.order === 'teach' ? doubtful.sort((a, b) => compareKeys(this.teachKeyOf(a), this.teachKeyOf(b))) : doubtful.sort((a, b) => newestFirst(a.row, b.row))
      const confident = items.filter((i) => i.view.by === 'sorter' && i.view.pile !== 'doubtful').sort((a, b) => newestFirst(a.row, b.row))
      return {
        needALook: h.needALook,
        confident: { kept: h.kept, throwaway: h.throwaway },
        all: { needALook: all.needALook, confident: all.kept + all.throwaway },
        lastSortedAt: h.lastSortedAt,
        queue: this.taught(queue.slice(0, clampN(opts.queue, 50)), choose),
        confidentSample: confident.slice(0, clampN(opts.sample, 12)).map((i) => this.card(i, undefined, choose)),
        canUndo: this.undoStack.length > 0,
        notOnMac: cloud,
        leaveOutNotOnMac: this.leaveOut()
      }
    })
  }

  private pileItems(items: Item[], p: 'kept' | 'throwaway' | 'bin'): Item[] {
    return items.filter((i) => i.view.pile === p)
  }

  private key = (i: Item): PileKey => pileKey(i.view.pile, i.view.binInDays, timeOf(i.row), i.row.hash)

  /** First page of each pile plus totals and the cursor for the next page. More pages: page(). */
  piles(opts: { kept?: number; throwaway?: number; bin?: number; sure?: unknown; notOnMac?: unknown } = {}): Promise<ReviewPiles> {
    return this.serial(async () => {
      const sure = this.sureOf(opts.sure)
      const notOnMac = this.cloudOf(opts.notOnMac)
      const choose = this.chooser()
      const read = this.items()
      const items = await this.scoped({ sure, notOnMac }, choose, read)
      const h = this.head(items)
      const first = (p: 'kept' | 'throwaway' | 'bin', n?: number): { total: number; items: ReviewCard[]; next: string | null } => {
        const pg = keysetPage(this.pileItems(items, p), this.key, null, pageSize(n))
        return { total: pg.total, items: pg.items.map((i) => this.card(i, undefined, choose)), next: pg.next }
      }
      // Empty Bin acts on the whole Bin. Only an answer whose Bin is the whole Bin carries its token, so the count the confirm
      // shows (bin.total) and the token emptyBin() accepts always come from the same read of the whole Bin; an answer under a
      // range, in the Not on this Mac view, or with screenshots left out of the Bin carries none.
      const binNow = this.pileItems(items, 'bin').map((i) => i.row.hash)
      const whole = sure || notOnMac ? null : this.pileItems(read, 'bin').length === binNow.length
      const token = whole ? binToken(binNow) : null
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
  page(pile: 'kept' | 'throwaway' | 'bin', after: string | null, limit?: number, sure?: unknown, notOnMac?: unknown): Promise<ReviewPage> {
    return this.serial(async () => {
      const choose = this.chooser()
      const scope = { sure: this.sureOf(sure), notOnMac: this.cloudOf(notOnMac) }
      const pg = keysetPage(this.pileItems(await this.scoped(scope, choose, this.items()), pile), this.key, after, pageSize(limit))
      return { total: pg.total, items: pg.items.map((i) => this.card(i, undefined, choose)), next: pg.next }
    })
  }

  /** Set "leave screenshots that are not on this Mac out of Review and sorting"; answers what is stored now. */
  setLeaveOutNotOnMac(on: boolean): boolean {
    this.deps.saveLeaveOutNotOnMac?.(on === true)
    return this.leaveOut()
  }

  /** Download them, while it runs (null when none is running). */
  downloadStatus(): ReviewDownloadProgress | null {
    return this.fetching ? { ...this.fetching.progress } : null
  }

  /** Cancel Download them: it stops before the next file (the one being fetched is stopped too). False when none runs. */
  cancelDownload(): boolean {
    if (!this.fetching) return false
    this.fetching.ctl.abort()
    return true
  }

  /**
   * Download them: every screenshot in the Not on this Mac view (under the how-sure range when one is set), need a look
   * first, then newest first, one file at a time (download.ts). Only one runs at a time. Writes nothing but each scan row's
   * `offline` flag; no answer, no decision.
   */
  async downloadNotOnMac(sure?: unknown): Promise<ReviewDownloadResult> {
    if (this.fetching) return { ok: false, total: 0, done: 0, failed: 0, cancelled: false, message: 'A download is already running.' }
    const ctl = new AbortController()
    const fetching = { ctl, progress: { running: true, total: 0, current: 0, done: 0, failed: 0 } as ReviewDownloadProgress }
    this.fetching = fetching
    try {
      const targets = await this.serial(() => this.downloadList(this.sureOf(sure)))
      const wellRoot = this.deps.wellRoot()
      const setOffline = this.deps.setOffline ?? setTriageOffline
      const r = await downloadTargets(
        targets,
        {
          allowedRoots: this.deps.allowedRoots,
          download: this.deps.download,
          dataless: this.deps.dataless,
          timeoutMs: this.deps.downloadTimeoutMs,
          setOffline: (t, offline) => setOffline(wellRoot, t.rowSource, t.relPath, offline)
        },
        {
          signal: ctl.signal,
          onProgress: (p) => {
            this.notOnMacCache.invalidate() // a file came down, or did not: worked out again at the next read
            fetching.progress = p
            this.deps.downloadProgress?.(p)
          }
        }
      )
      if (r.done) this.deps.downloaded?.()
      return { ok: true, total: r.total, done: r.done, failed: r.failed, cancelled: r.cancelled, message: downloadWords(r) }
    } finally {
      this.fetching = null
    }
  }

  /** The placeholders to ask for: one per screenshot (the copy its picture chooser picked), need a look first, then newest first. */
  private downloadList(sure: SureRange | undefined): DownloadTarget[] {
    // checked afresh, not from the cache: this is the list of files to ask for
    const choose = this.chooser()
    const items = this.items(sure).filter((i) => choose(i.row.hash, i.row.copies).state === 'not-downloaded')
    const rank = (i: Item): number => (i.view.pile === 'doubtful' ? 0 : 1)
    items.sort((a, b) => rank(a) - rank(b) || newestFirst(a.row, b.row))
    const fallback = this.deps.sourceRoot() || ''
    const out: DownloadTarget[] = []
    for (const i of items) {
      const abs = choose(i.row.hash, i.row.copies).originalAbs
      const f = abs ? i.row.copies.find((c) => c.kind !== 'video' && join(c.source || fallback, c.relPath) === abs) : undefined
      if (abs && f) out.push({ hash: i.row.hash, abs, source: f.source || fallback, relPath: f.relPath, rowSource: f.source })
    }
    return out
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
      const undoId = ++this.undoSeq
      this.undoStack.push({ id: undoId, hash, prior, priorAnswer })
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
      this.deps.changed?.()
      return { ok: true, hash, message, pile: plan.state === 'selected' ? 'kept' : 'throwaway', undoId }
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
      return { ok: true, hash: e.hash, message: 'Undone.', undoId: e.id }
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
   * Look again: his Review answers since `since` that still stand (rescue.ts kindOf: the decision is still the one the answer wrote;
   * a Triage or hand decision, an undone answer and an emptied item are left out), newest answer first, each as the card shows it now
   * with its answer. Keyset-paged on (answer time, hash); limit 1..200, default 60. Reads only.
   */
  answersSince(since: string, after: string | null = null, limit?: number): Promise<ReviewAnswersSince> {
    return this.serial(() => {
      const t0 = typeof since === 'string' ? Date.parse(since) : NaN
      if (!Number.isFinite(t0)) throw new Error('review: bad since')
      this.migrate()
      const now = this.now()
      const stand: Array<{ item: Item; t: number; answer: 'keep' | 'throwaway'; at: string }> = []
      for (const row of readReviewRows(this.deps.wellRoot())) {
        const t = row.answeredAt ? Date.parse(row.answeredAt) : NaN
        if (!Number.isFinite(t) || t < t0 || !kindOf(row)) continue
        const view = pileOf(row, now)
        if (view.pile === 'gone') continue
        stand.push({ item: { row, view }, t, answer: row.answer as 'keep' | 'throwaway', at: row.answeredAt! })
      }
      const by = new Map(stand.map((x) => [x.item.row.hash, x]))
      const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 200)) : 60
      const pg = keysetPage(stand.map((x) => x.item), (i): PileKey => [-by.get(i.row.hash)!.t, 0, i.row.hash], after, n)
      const choose = this.chooser()
      return {
        total: stand.length,
        kept: stand.filter((x) => x.answer === 'keep').length,
        thrownAway: stand.filter((x) => x.answer === 'throwaway').length,
        items: pg.items.map((i) => ({ ...this.card(i, undefined, choose), answer: by.get(i.row.hash)!.answer, answeredAt: by.get(i.row.hash)!.at })),
        next: pg.next
      }
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
   * Look again's Done: ask for one training that starts after every answer written so far (deps.retrain, which is
   * Retrainer.retrainAfterChange('manual'): not joined to a training already running, kept owed while the sorter is busy,
   * whatever the auto-retrain switch says). Queued behind any answer still being written, so the training sees it.
   * Answers as soon as it is asked for, with an id whose end rescueRetrain() reports.
   */
  retrainAfterAnswers(): Promise<ReviewRetrainAsked> {
    return this.serial(() => {
      if (!this.deps.retrain) return { ok: false, error: RETRAIN_FAILED }
      let asked: Promise<unknown>
      try {
        asked = Promise.resolve(this.deps.retrain())
      } catch {
        return { ok: false, error: RETRAIN_FAILED }
      }
      const id = ++this.rescueSeq
      this.rescueTraining = { id, end: asked.then(retrainEnd, () => ({ ok: false, error: RETRAIN_FAILED })) }
      return { ok: true, retrain: id }
    })
  }

  /**
   * How the retrain asked for by rescueBlind or retrainAfterAnswers (its `retrain` id) ended: answers once that training has run or failed,
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

/** The words Download them ends with. */
export function downloadWords(r: { total: number; done: number; failed: number; cancelled: boolean }): string {
  if (!r.total) return 'Nothing to download: every screenshot here is on this Mac.'
  const got = `Downloaded ${r.done} of ${r.total}.`
  const bad = r.failed ? ` ${r.failed} could not be downloaded (offline, unavailable or slower than a minute); they stay in this list.` : ''
  return r.cancelled ? `Stopped. ${got}${bad}` : `${got}${bad}`
}

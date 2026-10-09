/**
 * The review screen's action layer (ticket 08): read the piles, apply his Keep / Throwaway / Rescue,
 * undo the last one, empty the Bin.
 *
 * Write-path rules:
 *   - His choice is written to triage_decisions through triage.ts, the path the Triage panel uses;
 *     the sorter's proposal is only marked answered. Keep promotes into the well through the same
 *     ingest path as Triage's Import.
 *   - No action deletes, moves or writes an original file. Throwaway and Bin are record states.
 *   - Emptying the Bin is his own action, guarded by the token of the Bin he confirmed. It removes
 *     only SlideWell's records (proposal, well record) and SlideWell's copies (well copy, sidecar,
 *     poster), each through removeOwnedCopy (realpath containment in a SlideWell copy folder, regular
 *     file, not a symlink). A hash-only 'emptied' marker stays so the item never comes back.
 *   - Undo restores the exact earlier decision and answer mark; a well copy that the undone Keep
 *     created is removed the same guarded way.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewActResult, ReviewCard, ReviewOverview, ReviewPiles, ReviewUndoResult, EmptyBinResult } from '../../preload'
import { binToken, pileOf, planAction, summarise, BIN_AFTER_DAYS, type PileView, type ReviewAction } from './piles'
import { newestFirst, readReviewRows, type ReviewRow } from './store'
import { removeOwnedCopy } from './owned-copy'
import { putTriageDecision, promoteTriageHashes, type PromoteResult, type TriageDecisionRow } from '../triage'
import { deleteWellRecord, wellByIds } from '../well'
import { SorterStore } from '../sorter/store'

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
}

type Item = { row: ReviewRow; view: PileView }
type UndoEntry = {
  hash: string
  prior: TriageDecisionRow | null
  priorAnswer: { answer: string; answeredAt: string } | null
  createdWell: { id: string; relPath: string } | null
}

const UNDO_DEPTH = 50

/** SlideWell's own copy folders inside the well: the only places review code may delete a file. */
export function ownedCopyRoots(wellRoot: string): { well: string[]; posters: string[] } {
  return { well: [join(wellRoot, 'images'), join(wellRoot, 'videos')], posters: [join(wellRoot, '_triage-posters')] }
}

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

  private card(i: Item): ReviewCard {
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
      binInDays: i.view.binInDays,
      thumbUrl: abs ? this.deps.thumbUrl(abs) : null,
      offline: Boolean(f?.offline)
    }
  }

  private head(items: Item[]): { needALook: number; kept: number; throwaway: number; lastSortedAt: string | null } {
    const s = summarise(items.map((i) => ({ view: i.view, proposal: i.row.proposal, decided: Boolean(i.row.decision && i.row.decision.state !== 'undecided') })))
    let last: string | null = null
    for (const i of items) if (i.row.proposedAt && (!last || i.row.proposedAt > last)) last = i.row.proposedAt
    return { needALook: s.needALook, kept: s.confidentKept, throwaway: s.confidentThrowaway, lastSortedAt: last }
  }

  overview(opts: { queue?: number; sample?: number } = {}): Promise<ReviewOverview> {
    return this.serial(() => {
      const items = this.items()
      const h = this.head(items)
      const queue = items.filter((i) => i.view.pile === 'doubtful').sort((a, b) => newestFirst(a.row, b.row))
      const confident = items.filter((i) => i.view.by === 'sorter' && i.view.pile !== 'doubtful').sort((a, b) => newestFirst(a.row, b.row))
      return {
        needALook: h.needALook,
        confident: { kept: h.kept, throwaway: h.throwaway },
        lastSortedAt: h.lastSortedAt,
        queue: queue.slice(0, clampN(opts.queue, 50)).map((i) => this.card(i)),
        confidentSample: confident.slice(0, clampN(opts.sample, 12)).map((i) => this.card(i)),
        canUndo: this.undoStack.length > 0
      }
    })
  }

  piles(opts: { kept?: number; throwaway?: number; bin?: number } = {}): Promise<ReviewPiles> {
    return this.serial(() => {
      const items = this.items()
      const h = this.head(items)
      const of = (p: PileView['pile']): Item[] => items.filter((i) => i.view.pile === p)
      const kept = of('kept').sort((a, b) => newestFirst(a.row, b.row))
      const toss = of('throwaway').sort((a, b) => (b.view.binInDays ?? 0) - (a.view.binInDays ?? 0) || newestFirst(a.row, b.row))
      const bin = of('bin').sort((a, b) => newestFirst(a.row, b.row))
      return {
        needALook: h.needALook,
        confidentTotal: h.kept + h.throwaway,
        lastSortedAt: h.lastSortedAt,
        kept: { total: kept.length, items: kept.slice(0, clampN(opts.kept, 60)).map((i) => this.card(i)) },
        throwaway: { total: toss.length, items: toss.slice(0, clampN(opts.throwaway, 60)).map((i) => this.card(i)) },
        bin: { total: bin.length, items: bin.slice(0, clampN(opts.bin, 60)).map((i) => this.card(i)), token: binToken(bin.map((i) => i.row.hash)) },
        canUndo: this.undoStack.length > 0
      }
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
      let createdWell: UndoEntry['createdWell'] = null
      let message = `Moved to Throwaway — bin in ${BIN_AFTER_DAYS} days. Your original file is not touched.`
      if (plan.promote) {
        // a failed ingest leaves his keep staged (Triage's Import retries it); the decision still stands
        const r = await this.promote([hash]).catch((): PromoteResult => ({ imported: [], skipped: 1, gated: 0 }))
        const imp = r.imported.find((x) => x.hash === hash)
        if (imp) {
          createdWell = imp.created ? { id: imp.wellId, relPath: imp.relPath } : null
          message = action === 'rescue' ? 'Rescued — kept and added to the well.' : 'Kept — added to the well.'
        } else {
          message = r.gated ? 'Kept — a large video; add it with Import in Triage.' : 'Kept — the file is not on this Mac yet; it joins the well when Triage imports it.'
        }
      }
      this.withSorterStore((s) => s.setAnswer(hash, { answer: plan.answer, answeredAt: plan.decidedAt }))
      this.undoStack.push({ hash, prior, priorAnswer, createdWell })
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
      this.deps.changed?.()
      return { ok: true, hash, message, pile: plan.state === 'selected' ? 'kept' : 'throwaway' }
    })
  }

  undo(): Promise<ReviewUndoResult> {
    return this.serial(async () => {
      const e = this.undoStack.pop()
      if (!e) return { ok: false, message: 'Nothing to undo.' }
      const root = this.deps.wellRoot()
      if (e.createdWell) await this.removeWellCopy(e.createdWell.id, e.hash)
      await putTriageDecision(root, e.hash, e.prior)
      this.withSorterStore((s) => s.setAnswer(e.hash, e.priorAnswer))
      this.deps.changed?.()
      return { ok: true, hash: e.hash, message: 'Undone.' }
    })
  }

  /** Other decisions that still point at a well id (then its copy must stay). */
  private wellIdInUse(wellId: string, exceptHash: string): boolean {
    const file = join(this.deps.wellRoot(), 'triage.db')
    if (!existsSync(file)) return false
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return Boolean(db.prepare("SELECT 1 FROM triage_decisions WHERE well_id = ? AND hash != ? AND state IN ('selected', 'included', 'excluded')").get(wellId, exceptHash))
    } finally {
      db.close()
    }
  }

  /** Remove a SlideWell well copy (file, sidecar, video poster) and its record. Returns counts. */
  private async removeWellCopy(wellId: string, exceptHash: string): Promise<{ removed: number; refused: number }> {
    const root = this.deps.wellRoot()
    const out = { removed: 0, refused: 0 }
    if (this.wellIdInUse(wellId, exceptHash)) return out
    const rows = (await wellByIds(root, [wellId])).filter((r) => r.root === 'well') // never vault files
    if (!rows.length) return out
    const owned = ownedCopyRoots(root).well
    for (const r of rows) {
      const main = join(root, r.rel_path)
      const paths = [main, main.replace(/\.[^./]+$/, '.yml')]
      if (/^videos\//.test(r.rel_path) && !/\.jpg$/i.test(main)) paths.push(main.replace(/\.[^./]+$/, '.jpg'))
      for (const p of paths) {
        const res = removeOwnedCopy(p, owned)
        if (res.removed) out.removed++
        else if (res.reason !== 'missing') out.refused++
      }
    }
    await deleteWellRecord(root, wellId)
    return out
  }

  emptyBin(token: string): Promise<EmptyBinResult> {
    return this.serial(async () => {
      const bin = this.items().filter((i) => i.view.pile === 'bin')
      if (typeof token !== 'string' || binToken(bin.map((i) => i.row.hash)) !== token) {
        return { ok: false, emptied: 0, copiesRemoved: 0, copiesRefused: 0, message: 'The Bin changed since you looked; nothing was emptied.' }
      }
      const root = this.deps.wellRoot()
      const at = new Date(this.now()).toISOString()
      const posters = ownedCopyRoots(root).posters
      let removed = 0
      let refused = 0
      for (const i of bin) {
        const wellId = i.row.decision?.wellId
        if (wellId) {
          const r = await this.removeWellCopy(wellId, i.row.hash)
          removed += r.removed
          refused += r.refused
        }
        if (i.row.file?.posterRel) {
          const res = removeOwnedCopy(join(root, i.row.file.posterRel), posters)
          if (res.removed) removed++
          else if (res.reason !== 'missing') refused++
        }
        // hash-only marker: the item leaves every pile and list, and the sorter never proposes it again
        await putTriageDecision(root, i.row.hash, { state: 'emptied', decidedAt: at, wellId: null })
      }
      this.withSorterStore((s) => s.deleteProposals(bin.map((i) => i.row.hash)))
      this.undoStack = [] // emptying cannot be undone, and earlier undos may refer to emptied items
      this.deps.changed?.()
      const n = bin.length
      return { ok: true, emptied: n, copiesRemoved: removed, copiesRefused: refused, message: n ? `Emptied ${n} from the Bin. Your original files are not touched.` : 'The Bin is already empty.' }
    })
  }
}

function clampN(n: unknown, dflt: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 500) : dflt
}

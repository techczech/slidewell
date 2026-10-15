/**
 * Putting back Review answers given blind. Until the picture states (picture.ts), a Review card whose
 * file was not on this Mac showed a drawn placeholder that looked like a real screenshot; answers
 * given on such cards are now training the sorter. This finds them and, on his word, puts them back
 * to undecided and asks for a retrain.
 *
 * "From Review": the sorter store's answer mark (sorter_proposals.answer / answered_at) is written
 * only by ReviewService.act (the queue, both piles, the teaching round) and its undo. Triage, its
 * Auto sorting piles and Triage's U never write it. An answer counts only while his current decision
 * is still the one that answer wrote:
 *   excluded + throwaway, decided_at = answered_at  -> thrown away            (put back)
 *   selected + keep,      decided_at = answered_at  -> kept, not imported     (put back) — or, when the
 *                                                      row carries a well id, kept and imported (left)
 *   included + keep,      decided_at >= answered_at -> kept and imported      (left: a real file is in the well)
 *   emptied  + throwaway, decided_at >= answered_at -> emptied from the Bin   (left: emptying is permanent;
 *                                                      there is no un-empty operation, so these are only counted)
 * Anything else (a later hand decision in Triage, undecided again) is not his Review answer and is
 * never touched. "Blind" = the card had no picture: the picture state ReviewService.act recorded with
 * the answer (sorter_proposals.answered_picture) when there is one; for an older answer without it,
 * the picture judged now over every copy (pictureChooser). Either way the state is not 'ok'.
 *
 * The token fingerprints the whole set, per item: kind, hash, decided_at, answered_at, well_id. So an
 * item answered again (even the same way) or re-imported gives a different token. rescue(token) writes
 * through triage.ts resetReviewAnswers: one transaction that first re-reads every item of the set (the
 * counted ones too) against the snapshot the token was built from, then makes the same writes as
 * Triage's reset plus clearing the answer mark; all or nothing. No file and no well record is touched.
 */
import { binToken } from './piles'
import { pictureChooser, type PictureDeps, type PictureState } from './picture'
import { readReviewRows, type ReviewRow } from './store'
import { resetReviewAnswers, type AnswerSnapshot } from '../triage'

/** The teaching build: answers before it were given on the old cards too, but this is the window he asked about. Local time. */
export const BLIND_SINCE_DEFAULT = '2026-10-13T00:00:00'

export type BlindKind = 'thrownAway' | 'keptImported' | 'keptNotImported' | 'emptied'

/** Why a card had no picture: the three states other than ok. */
export type BlindPicture = Exclude<PictureState, 'ok'>

/** One blind answer as the confirm lists it. */
/** `recorded`: the picture state is the one recorded when he answered; false = an older answer, judged by this Mac now. */
export type BlindItem = { hash: string; filename: string; kind: BlindKind; answer: 'keep' | 'throwaway'; picture: BlindPicture; recorded: boolean; putBack: boolean }

export type BlindAnswers = {
  thrownAway: number
  keptImported: number
  keptNotImported: number
  emptied: number
  /** Every blind answer found (all four kinds), newest answer first. */
  hashes: string[]
  /** The ones rescue() would put back (thrown away and kept-not-imported). */
  resettable: string[]
  /** Every blind answer found, in the order of `hashes`: what the confirm lists. */
  items: BlindItem[]
  /** Fingerprint of exactly this set, its kinds and each item's decision and answer times: rescue() acts only on the set he confirmed. */
  token: string
}

/**
 * `hashes`: the ones put back; `retrain`: the training asked for after them (deps.retrain's answer), settling when
 * that training has run or failed. Both main only; the renderer is sent ok, reset, error and an id for the retrain.
 */
export type RescueResult = { ok: boolean; reset: number; hashes: string[]; error?: string; retrain?: Promise<unknown> }

export type RescueDeps = PictureDeps & {
  /**
   * Ask for the retrain (Retrainer.retrainAfterChange('manual')); called once after a rescue that put anything back.
   * Its answer (a promise of that training's outcome) is handed back as RescueResult.retrain.
   */
  retrain?: () => unknown
  /**
   * True while the caller's one-at-a-time queue is running this call (ReviewService.serial). rescue() refuses to run
   * outside it: its set check below relies on no Review answer being written between the check and the reset.
   */
  inQueue?: () => boolean
}

type Found = { hash: string; filename: string; kind: BlindKind; picture: BlindPicture; recorded: boolean; snap: Omit<AnswerSnapshot, 'reset'> }

const STATES: ReadonlySet<string> = new Set<PictureState>(['ok', 'not-downloaded', 'missing', 'none'])

function since(s: string): number {
  const t = typeof s === 'string' ? Date.parse(s) : NaN
  if (!Number.isFinite(t)) throw new Error('review: bad since')
  return t
}

/** Which of the four kinds this row's current decision is, when it is still the Review answer; null otherwise. */
function kindOf(r: ReviewRow): BlindKind | null {
  const d = r.decision
  const at = r.answeredAt
  if (!d || !at || (r.answer !== 'keep' && r.answer !== 'throwaway')) return null
  const same = d.decidedAt === at
  const after = d.decidedAt !== null && Date.parse(d.decidedAt) >= Date.parse(at)
  if (r.answer === 'throwaway') {
    if (d.state === 'excluded' && same) return 'thrownAway'
    if (d.state === 'emptied' && after) return 'emptied'
    return null
  }
  if (d.state === 'selected' && same) return d.wellId ? 'keptImported' : 'keptNotImported'
  if (d.state === 'included' && after) return 'keptImported'
  return null
}

export function blindRescue(deps: RescueDeps): { findBlind: (since: string) => BlindAnswers; rescue: (token: string, since?: string) => RescueResult } {
  const found = (from: string): Found[] => {
    const t0 = since(from)
    const choose = pictureChooser(deps)
    const out: Array<Found & { t: number }> = []
    for (const r of readReviewRows(deps.wellRoot())) {
      const t = r.answeredAt ? Date.parse(r.answeredAt) : NaN
      if (!Number.isFinite(t) || t < t0) continue
      const kind = kindOf(r)
      if (!kind) continue
      // the picture recorded with the answer; an older answer without one is judged by what is on this Mac now
      const recorded = Boolean(r.answeredPicture && STATES.has(r.answeredPicture))
      const picture = recorded ? (r.answeredPicture as PictureState) : choose(r.hash, r.copies).state
      if (picture === 'ok') continue
      const d = r.decision!
      out.push({ hash: r.hash, filename: r.file?.filename || r.hash, kind, picture, recorded, t, snap: { hash: r.hash, decision: { state: d.state, decidedAt: d.decidedAt, wellId: d.wellId }, answer: { answer: r.answer!, answeredAt: r.answeredAt! } } })
    }
    return out.sort((a, b) => b.t - a.t || (a.hash < b.hash ? -1 : 1))
  }
  const summary = (f: Found[]): BlindAnswers => {
    const n = (k: BlindKind): number => f.filter((x) => x.kind === k).length
    return {
      thrownAway: n('thrownAway'),
      keptImported: n('keptImported'),
      keptNotImported: n('keptNotImported'),
      emptied: n('emptied'),
      hashes: f.map((x) => x.hash),
      resettable: f.filter(putBack).map((x) => x.hash),
      items: f.map((x) => ({ hash: x.hash, filename: x.filename, kind: x.kind, answer: x.snap.answer.answer as 'keep' | 'throwaway', picture: x.picture, recorded: x.recorded, putBack: putBack(x) })),
      token: tokenOf(f)
    }
  }
  return {
    findBlind: (from) => summary(found(from)),
    rescue: (token, from = BLIND_SINCE_DEFAULT) => {
      if (deps.inQueue && !deps.inQueue()) throw new Error('review: rescue runs only inside the service queue')
      const f = found(from)
      if (typeof token !== 'string' || summary(f).token !== token) return { ok: false, reset: 0, hashes: [], error: CHANGED }
      if (!f.some(putBack)) return { ok: true, reset: 0, hashes: [] }
      // the whole confirmed set goes in: the counted ones are checked against the snapshot too
      const r = resetReviewAnswers(deps.wellRoot(), f.map((x) => ({ ...x.snap, reset: putBack(x) })))
      if (r.changed.length) return { ok: false, reset: 0, hashes: [], error: CHANGED }
      let retrain: Promise<unknown> | undefined
      try {
        retrain = deps.retrain ? Promise.resolve(deps.retrain()) : undefined
      } catch (e) {
        // the answers are back either way; the retrain can be started from Auto sorting
        retrain = Promise.reject(e)
      }
      retrain?.catch(() => undefined)
      return retrain ? { ok: true, reset: r.reset.length, hashes: r.reset, retrain } : { ok: true, reset: r.reset.length, hashes: r.reset }
    }
  }
}

export const CHANGED = 'Something changed since you looked; check the list again.'
/** Per item: kind, hash, and the decision and answer it stands on, so any re-answer or re-import changes the token. */
const tokenOf = (f: Found[]): string => binToken(f.map((x) => [x.kind, x.hash, x.snap.decision.decidedAt ?? '', x.snap.answer.answeredAt, x.snap.decision.wellId ?? ''].join(':')))
const putBack = (x: Found): boolean => x.kind === 'thrownAway' || x.kind === 'keptNotImported'

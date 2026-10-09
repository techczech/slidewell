/**
 * The review piles as a pure state machine (ticket 08). No electron, sqlite or fs imports, so it is
 * unit-testable and importable from the renderer mock too.
 *
 * An item in review is a screenshot the sorter proposed something for. Where it sits is derived from
 * two records and the clock, never stored:
 *
 *   his decision (triage_decisions)      the sorter's proposal (sorter_proposals)
 *   selected | included  -> kept, by you  (only when he has no decision)
 *   excluded             -> throwaway or bin, by you, clock from decided_at
 *   emptied              -> gone (the Bin was emptied)
 *   none                 -> doubtful -> doubtful queue; keep -> kept; throwaway -> throwaway or bin,
 *                           clock from throwaway_since (first proposed throwaway)
 *
 * Throwaway and Bin are record states: an item moves from Throwaway to the Bin when the 30-day clock
 * runs out. Nothing here touches a file. When a date is missing or unreadable the item stays in
 * Throwaway with the full 30 days (when unsure, keep).
 */
export const BIN_AFTER_DAYS = 30
const DAY_MS = 86_400_000

export type ProposalLabel = 'keep' | 'throwaway' | 'doubtful'
export type Pile = 'doubtful' | 'kept' | 'throwaway' | 'bin' | 'gone'
export type ReviewAction = 'keep' | 'throwaway' | 'rescue'

/** What the state machine needs to know about one item. */
export type PileFacts = {
  proposal: ProposalLabel
  proposedAt: string | null
  /** When the sorter first proposed throwaway (kept across re-sorts); null when never. */
  throwawaySince: string | null
  decision: { state: string; decidedAt: string | null } | null
}

export type PileView = {
  pile: Pile
  /** Who put it there: his decision, or the sorter's proposal he has not overridden. */
  by: 'you' | 'sorter'
  /** Whole days until the item moves to the Bin (1..30); null outside Throwaway. */
  binInDays: number | null
}

export type ActionPlan =
  | { kind: 'decide'; state: 'selected' | 'excluded'; decidedAt: string; answer: 'keep' | 'throwaway'; promote: boolean }
  | { kind: 'noop'; reason: string }
  | { kind: 'refused'; reason: string }

function parseTime(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** Days left on the 30-day clock started at `since`; 0 means the item is in the Bin. */
export function daysLeft(since: string | null, now: number): number {
  const t = parseTime(since)
  if (t === null) return BIN_AFTER_DAYS
  const left = Math.ceil((t + BIN_AFTER_DAYS * DAY_MS - now) / DAY_MS)
  return Math.max(0, Math.min(BIN_AFTER_DAYS, left))
}

function onClock(since: string | null, now: number, by: 'you' | 'sorter'): PileView {
  const left = daysLeft(since, now)
  return left <= 0 ? { pile: 'bin', by, binInDays: null } : { pile: 'throwaway', by, binInDays: left }
}

export function pileOf(f: PileFacts, now: number): PileView {
  const state = f.decision?.state ?? 'undecided'
  if (state === 'selected' || state === 'included') return { pile: 'kept', by: 'you', binInDays: null }
  if (state === 'excluded') return onClock(f.decision?.decidedAt ?? null, now, 'you')
  if (state === 'emptied') return { pile: 'gone', by: 'you', binInDays: null }
  if (f.proposal === 'doubtful') return { pile: 'doubtful', by: 'sorter', binInDays: null }
  if (f.proposal === 'keep') return { pile: 'kept', by: 'sorter', binInDays: null }
  return onClock(f.throwawaySince ?? f.proposedAt, now, 'sorter')
}

/**
 * What one review action does to an item in a given pile.
 *   keep     from doubtful, kept by the sorter, throwaway or bin -> his keep (promoted into the well)
 *   throwaway from doubtful or kept -> his throwaway (30-day clock starts now)
 *   rescue   from throwaway or bin -> his keep
 * Already where the action would put it -> noop. An emptied item can no longer be acted on.
 */
export function planAction(view: PileView, action: ReviewAction, now: number): ActionPlan {
  const at = new Date(now).toISOString()
  const keep: ActionPlan = { kind: 'decide', state: 'selected', decidedAt: at, answer: 'keep', promote: true }
  if (view.pile === 'gone') return { kind: 'refused', reason: 'the Bin was emptied; SlideWell no longer holds this item' }
  if (action === 'rescue') {
    if (view.pile === 'throwaway' || view.pile === 'bin') return keep
    return { kind: 'refused', reason: 'only items in Throwaway or the Bin can be rescued' }
  }
  if (action === 'keep') {
    if (view.pile === 'kept' && view.by === 'you') return { kind: 'noop', reason: 'already kept' }
    return keep
  }
  if (view.pile === 'throwaway' || view.pile === 'bin') return { kind: 'noop', reason: 'already in Throwaway' }
  return { kind: 'decide', state: 'excluded', decidedAt: at, answer: 'throwaway', promote: false }
}

export type PileSummary = { needALook: number; kept: number; throwaway: number; bin: number; confidentKept: number; confidentThrowaway: number }

/** Counts for the review header and strip. "Sorted confidently" = proposals he has not overridden. */
export function summarise(items: Array<{ view: PileView; proposal: ProposalLabel; decided: boolean }>): PileSummary {
  const out: PileSummary = { needALook: 0, kept: 0, throwaway: 0, bin: 0, confidentKept: 0, confidentThrowaway: 0 }
  for (const it of items) {
    if (it.view.pile === 'doubtful') out.needALook++
    else if (it.view.pile === 'kept') out.kept++
    else if (it.view.pile === 'throwaway') out.throwaway++
    else if (it.view.pile === 'bin') out.bin++
    if (!it.decided && it.proposal === 'keep') out.confidentKept++
    if (!it.decided && it.proposal === 'throwaway') out.confidentThrowaway++
  }
  return out
}

/** A short fingerprint of the Bin's contents: Empty Bin acts only on the set he confirmed. */
export function binToken(hashes: string[]): string {
  const s = [...hashes].sort().join('\n')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return `${hashes.length}-${h1.toString(16)}${h2.toString(16)}`
}

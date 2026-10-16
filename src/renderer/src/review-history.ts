// Step back in Review: this session's answers in the need-a-look queue, oldest first, at most HISTORY_MAX. In memory only
// (module state, so leaving Review and coming back keeps it until the window closes). Each entry keeps every answer he gave
// that card, so ⌘Z can take back a changed answer and leave the earlier one showing. Pure functions over a list, plus the
// session's own list and its log of acts.
//
// Every act main can undo carries main's undo id (review.act's `undoId`; review.undo answers with the id of the act it took
// back). The session log records every such act made in Review, wherever it was made (the queue, a changed answer, the
// piles, Look again), so ⌘Z removes exactly the act it undid and never another answer on the same screenshot.
//
// What the history holds is what he answered, as he answered it: it is never the state to show or compare against. A card
// he steps back to is shown with its decision as main has it now (standingAnswer over review.cards), since an answer given
// in the piles, in Look again or in Triage since may have changed it.
import type { ReviewCard } from '../../preload'

export type Answer = 'keep' | 'throwaway'
/** `act`: main's undo id for the act that gave this answer. */
export type HistoryAnswer = { answer: Answer; at: string; act: number }
export type HistoryEntry = { card: ReviewCard; answers: HistoryAnswer[] }
/** One act main can undo, as the session made it: main's undo id, the screenshot, and where it was made. */
export type SessionAct = { undoId: number; hash: string; from: 'queue' | 'change' | 'pile' | 'look' }

export const HISTORY_MAX = 200
/** As deep as main's undo (service.ts UNDO_DEPTH). */
export const ACTS_MAX = 50

/** The answer that stands on an entry by this session's own record (its last). */
export const answerOf = (e: HistoryEntry): HistoryAnswer => e.answers[e.answers.length - 1]

/** A new answer from the queue: the card goes to the end (an earlier entry for it is dropped); the oldest drop past the cap. */
export function recordAnswer(list: HistoryEntry[], card: ReviewCard, answer: Answer, at: string, act: number): HistoryEntry[] {
  const out = [...list.filter((e) => e.card.hash !== card.hash), { card, answers: [{ answer, at, act }] }]
  return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out
}

/** He changed the answer on a card he stepped back to: it stays where it is in the list. */
export function changeAnswer(list: HistoryEntry[], hash: string, answer: Answer, at: string, act: number): HistoryEntry[] {
  return list.map((e) => (e.card.hash === hash ? { ...e, answers: [...e.answers, { answer, at, act }] } : e))
}

/** The act with this undo id was taken back: its answer goes (the one before it shows again); with none left, the card leaves the list. */
export function removeAct(list: HistoryEntry[], act: number): HistoryEntry[] {
  const i = list.findIndex((e) => e.answers.some((a) => a.act === act))
  if (i < 0) return list
  const e = list[i]
  const answers = e.answers.filter((a) => a.act !== act)
  return answers.length ? [...list.slice(0, i), { ...e, answers }, ...list.slice(i + 1)] : [...list.slice(0, i), ...list.slice(i + 1)]
}

/** The session's list, and every act it made that main can undo, oldest first. */
export const session: { history: HistoryEntry[]; acts: SessionAct[] } = { history: [], acts: [] }

/** Note an act main answered with an undo id (anything else is not an act ⌘Z can take back, and is not noted). */
export function noteAct(undoId: number | undefined, hash: string, from: SessionAct['from']): void {
  if (typeof undoId !== 'number') return
  session.acts.push({ undoId, hash, from })
  if (session.acts.length > ACTS_MAX) session.acts.shift()
}

/**
 * ⌘Z undid the act with this undo id (review.undo's `undoId`): it leaves the log, and when it gave an answer the history
 * recorded (the queue or a changed answer), exactly that answer goes. An act made elsewhere (the piles, Look again, another
 * screen) leaves the history alone; an undo with no id leaves everything alone.
 */
export function afterUndo(list: HistoryEntry[], undoId: number | undefined): HistoryEntry[] {
  if (typeof undoId !== 'number') return list
  session.acts = session.acts.filter((a) => a.undoId !== undoId)
  return removeAct(list, undoId)
}

/** His answer on a card as main has it now: Kept or Throwaway by him; null when none of his stands (or the card is not shown). */
export function standingAnswer(card: ReviewCard | null | undefined): Answer | null {
  if (!card || card.by !== 'you') return null
  return card.pile === 'kept' ? 'keep' : card.pile === 'throwaway' ? 'throwaway' : null
}

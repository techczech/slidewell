import { describe, it, expect, beforeEach } from 'vitest'
import { afterUndo, answerOf, changeAnswer, HISTORY_MAX, noteAct, recordAnswer, removeAct, session, standingAnswer, type HistoryEntry } from '../src/renderer/src/review-history'
import type { ReviewCard } from '../src/preload'

const card = (hash: string, pile: ReviewCard['pile'] = 'kept', by: ReviewCard['by'] = 'you'): ReviewCard => ({ hash, pile, by }) as ReviewCard
const at = (n: number): string => new Date(Date.UTC(2026, 9, 13, 10, n)).toISOString()

beforeEach(() => {
  session.history = []
  session.acts = []
})

describe('step back: the answer history', () => {
  it('keeps answers oldest first, at most 200, a card once', () => {
    let h: HistoryEntry[] = []
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = recordAnswer(h, card(`c${i}`), i % 2 ? 'throwaway' : 'keep', at(i % 60), i + 1)
    expect(h).toHaveLength(HISTORY_MAX)
    expect(h[0].card.hash).toBe('c5')
    h = recordAnswer(h, card('c10'), 'throwaway', at(1), 999)
    expect(h).toHaveLength(HISTORY_MAX)
    expect(h.at(-1)!.card.hash).toBe('c10')
    expect(h.filter((e) => e.card.hash === 'c10')).toHaveLength(1)
  })

  it('a changed answer stays in place and shows; undoing its act brings the earlier one back, then drops the card', () => {
    let h = recordAnswer(recordAnswer([], card('a'), 'keep', at(1), 1), card('b'), 'throwaway', at(2), 2)
    h = changeAnswer(h, 'a', 'throwaway', at(3), 3)
    expect(h.map((e) => e.card.hash)).toEqual(['a', 'b'])
    expect(answerOf(h[0])).toEqual({ answer: 'throwaway', at: at(3), act: 3 })
    h = removeAct(h, 3)
    expect(answerOf(h[0]).answer).toBe('keep')
    h = removeAct(h, 1)
    expect(h.map((e) => e.card.hash)).toEqual(['b'])
  })

  it('⌘Z removes exactly the act it undid, by undo id: never another answer on the same screenshot', () => {
    // a answered from the queue (act 1), then changed in the piles (act 2, not in the history), then ⌘Z: main undid act 2
    let h = recordAnswer([], card('a'), 'keep', at(1), 1)
    noteAct(1, 'a', 'queue')
    noteAct(2, 'a', 'pile')
    h = afterUndo(h, 2)
    expect(answerOf(h[0])).toMatchObject({ answer: 'keep', act: 1 }) // a hash-only match would have dropped the queue answer
    expect(session.acts.map((x) => x.undoId)).toEqual([1])
    h = afterUndo(h, 1)
    expect(h).toEqual([])
    expect(session.acts).toEqual([])
  })

  it('pile and Look again acts share the log; an undo without an id, or of an act made elsewhere, leaves the history alone', () => {
    const h = recordAnswer([], card('a'), 'keep', at(1), 1)
    noteAct(1, 'a', 'queue')
    noteAct(5, 'b', 'look')
    noteAct(undefined, 'c', 'pile') // wrote nothing: not an act ⌘Z can take back
    expect(session.acts.map((x) => [x.undoId, x.from])).toEqual([[1, 'queue'], [5, 'look']])
    expect(afterUndo(h, undefined)).toBe(h)
    expect(afterUndo(h, 77)).toBe(h)
    expect(afterUndo(h, 5)).toBe(h)
    expect(session.acts.map((x) => x.undoId)).toEqual([1])
  })

  it('the answer that stands is read from the card as main has it now, not from the history', () => {
    expect(standingAnswer(card('a', 'kept', 'you'))).toBe('keep')
    expect(standingAnswer(card('a', 'throwaway', 'you'))).toBe('throwaway')
    expect(standingAnswer(card('a', 'kept', 'sorter'))).toBeNull() // his answer was taken back: the sorter's proposal shows
    expect(standingAnswer(card('a', 'doubtful', 'sorter'))).toBeNull()
    expect(standingAnswer(undefined)).toBeNull() // in the Bin, emptied or gone: not among the cards main answers
  })
})

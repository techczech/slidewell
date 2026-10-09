import { describe, expect, it } from 'vitest'
import { interleave, mergeBands, scoreLabel, wordScore } from '../src/main/match-bands'
import { relatedFold } from '../src/renderer/src/match-fold'

const w = (name: string, ...ids: string[]) => ({ item: name, ids })

describe('mergeBands', () => {
  it('puts an item found by both only in the Words band', () => {
    const b = mergeBands([w('a', 'slide:p#1'), w('b', 'well:abc1234')], [
      { id: 'slide:p#1', score: 0.9 },
      { id: 'slide:p#2', score: 0.7 }
    ])
    expect(b.words.map((x) => x.item)).toEqual(['a', 'b'])
    expect(b.related.map((x) => x.id)).toEqual(['slide:p#2'])
  })

  it('treats every id of a cluster as a word match', () => {
    const b = mergeBands([w('cluster', 'slide:p#1', 'slide:q#4')], [
      { id: 'slide:q#4', score: 0.8 },
      { id: 'slide:z#1', score: 0.6 }
    ])
    expect(b.related.map((x) => x.id)).toEqual(['slide:z#1'])
  })

  it('never reorders word hits for a picture match', () => {
    const words = [w('first', 'slide:p#1'), w('second', 'slide:p#2'), w('third')]
    const pics = [{ id: 'slide:p#3', score: 0.99 }, { id: 'slide:p#2', score: 0.95 }]
    expect(mergeBands(words, pics).words.map((x) => x.item)).toEqual(['first', 'second', 'third'])
    expect(mergeBands(words, []).words.map((x) => x.item)).toEqual(['first', 'second', 'third'])
  })

  it('orders the related band by meaning score, best first, without duplicates', () => {
    const b = mergeBands([], [
      { id: 'x', score: 0.5 },
      { id: 'y', score: 0.8 },
      { id: 'x', score: 0.5 },
      { id: 'z', score: 0.65 }
    ])
    expect(b.related.map((x) => x.id)).toEqual(['y', 'z', 'x'])
  })

  it('with no word matches, everything related is shown and the words band is empty', () => {
    const b = mergeBands([], [{ id: 'slide:p#1', score: 0.7 }])
    expect(b.words).toEqual([])
    expect(b.related).toHaveLength(1)
  })

  it('words mode ignores pictures; meaning mode keeps hits that also match words', () => {
    const words = [w('a', 'slide:p#1')]
    const pics = [{ id: 'slide:p#1', score: 0.9 }, { id: 'slide:p#2', score: 0.8 }]
    expect(mergeBands(words, pics, 'words').related).toEqual([])
    const m = mergeBands(words, pics, 'meaning')
    expect(m.words).toEqual([])
    expect(m.related.map((x) => x.id)).toEqual(['slide:p#1', 'slide:p#2'])
  })

  it('labels scores in one form', () => {
    const b = mergeBands([w('a'), w('b')], [{ id: 'x', score: 0.781 }])
    expect(b.words.map((x) => x.score.label)).toEqual(['words 0.99', 'words 0.50'])
    expect(b.related[0].score.label).toBe('meaning 0.78')
    expect(scoreLabel('words', 0.9)).toBe('words 0.90')
  })
})

describe('wordScore and interleave', () => {
  it('scores 0.99 for the first hit, falling to 0.50 for the last, never above 1', () => {
    expect(wordScore(0, 1)).toBe(0.99)
    expect(wordScore(0, 5)).toBe(0.99)
    expect(wordScore(4, 5)).toBeCloseTo(0.5, 10)
  })
  it('interleaves by relative position so no store is buried', () => {
    expect(interleave([['s1', 's2', 's3', 's4'], ['w1', 'w2']])).toEqual(['s1', 'w1', 's2', 's3', 'w2', 's4'])
  })
})

describe('relatedFold', () => {
  const rel = (n: number) => Array.from({ length: n }, (_, i) => ({ score: { kind: 'meaning' as const, value: 0.9 - i * 0.01, label: '' } }))
  it('is null when all fit', () => expect(relatedFold(rel(10))).toBeNull())
  it('names the count and the edge score', () => expect(relatedFold(rel(12))).toEqual({ more: 2, below: '0.81' }))
})

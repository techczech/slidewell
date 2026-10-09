import { describe, expect, it, vi } from 'vitest'
import { matchedSearch, rowIds, type MatchCluster, type MatchDeps, type MatchRow } from '../src/main/matched-search'

const slide = (deck: string, order: number): MatchRow => ({ kind: 'slide', deck, slideOrder: order, reference: '' })
const well = (id: string): MatchRow => ({ kind: 'well-image', deck: 'screenshot', slideOrder: null, reference: `![](img-${id})` })
const cl = (r: MatchRow): MatchCluster => ({ representative: r, members: [r], size: 1, deckCount: 1 })

function deps(over: Partial<MatchDeps> = {}) {
  const pictureQuery = vi.fn(async () => [
    { id: 'slide:p#1', score: 0.9 },
    { id: 'slide:p#7', score: 0.7 },
    { id: 'well:abc1234', score: 0.6 }
  ])
  const d: MatchDeps = {
    words: async () => [cl(slide('p', 1)), cl(well('def5678'))],
    modelReady: () => true,
    pictureQuery,
    resolve: async (ids) => new Map(ids.map((id) => [id, cl(id.startsWith('well:') ? well(id.slice(5)) : slide('p', Number(id.split('#')[1])))])),
    ...over
  }
  return { d, pictureQuery }
}

describe('matchedSearch', () => {
  it('Both: word hits above, related below, the shared hit only in Words, scores on every card', async () => {
    const { d } = deps()
    const r = await matchedSearch(d, 'robots', { type: 'images' }, 'both')
    expect(r.mode).toBe('both')
    expect(r.words.map((c) => c.representative.score?.label)).toEqual(['words 0.99', 'words 0.99'])
    expect(r.related.map((c) => c.representative.score?.label)).toEqual(['meaning 0.70', 'meaning 0.60'])
    expect(r.related.some((c) => c.representative.slideOrder === 1)).toBe(false)
  })

  it('Words: makes no picture query', async () => {
    const { d, pictureQuery } = deps()
    const r = await matchedSearch(d, 'robots', { type: 'images' }, 'words')
    expect(pictureQuery).not.toHaveBeenCalled()
    expect(r.related).toEqual([])
    expect(r.ms.meaning).toBeNull()
  })

  it('without the model, Both and Meaning fall back to words and no picture query runs', async () => {
    const { d, pictureQuery } = deps({ modelReady: () => false })
    for (const mode of ['both', 'meaning'] as const) {
      const r = await matchedSearch(d, 'robots', { type: 'images' }, mode)
      expect(r.mode).toBe('words')
      expect(r.modelReady).toBe(false)
      expect(r.words).toHaveLength(2)
    }
    expect(pictureQuery).not.toHaveBeenCalled()
  })

  it('no free text (or only filter tokens) skips the picture query', async () => {
    const { d, pictureQuery } = deps()
    await matchedSearch(d, 'year:2024', { type: 'images' }, 'both')
    await matchedSearch(d, '', { type: 'images' }, 'both')
    expect(pictureQuery).not.toHaveBeenCalled()
  })

  it('no word matches: words empty, related still returned', async () => {
    const { d } = deps({ words: async () => [] })
    const r = await matchedSearch(d, 'inverted pyramid', { type: 'images' }, 'both')
    expect(r.words).toEqual([])
    expect(r.related).toHaveLength(3)
  })

  it('Meaning shows every picture hit and runs no word search', async () => {
    const words = vi.fn(async () => [cl(slide('p', 1))])
    const { d } = deps({ words })
    const r = await matchedSearch(d, 'robots', { type: 'images' }, 'meaning')
    expect(words).not.toHaveBeenCalled()
    expect(r.related.map((c) => c.representative.slideOrder)).toEqual([1, 7, null])
  })

  it('a failing picture query leaves the word results in place', async () => {
    const { d } = deps({ pictureQuery: async () => { throw new Error('boom') } })
    const r = await matchedSearch(d, 'robots', { type: 'images' }, 'both')
    expect(r.mode).toBe('words')
    expect(r.pictureError).toBe('boom')
    expect(r.words).toHaveLength(2)
  })

  it('asks only for the picture kinds the filters allow, and none for Presentations', async () => {
    const { d, pictureQuery } = deps()
    await matchedSearch(d, 'robots', { type: 'slides' }, 'both')
    expect(pictureQuery).toHaveBeenLastCalledWith('robots', { limit: 150, kinds: ['slide'] })
    await matchedSearch(d, 'robots', { type: 'images', from: 'screenshots' }, 'both')
    expect(pictureQuery).toHaveBeenLastCalledWith('robots', { limit: 150, kinds: ['well-image'] })
    pictureQuery.mockClear()
    await matchedSearch(d, 'robots', { type: 'decks' }, 'both')
    expect(pictureQuery).not.toHaveBeenCalled()
  })
})

describe('rowIds', () => {
  it('maps rows to picture ids', () => {
    expect(rowIds(slide('p', 3))).toEqual(['slide:p#3'])
    expect(rowIds({ ...slide('p', 2), kind: 'ocr-render' })).toEqual(['slide:p#3'])
    expect(rowIds(well('abc1234'))).toEqual(['well:abc1234'])
    expect(rowIds({ ...slide('p', 1), kind: 'archive-image' })).toEqual([])
  })
})

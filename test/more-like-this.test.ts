import { describe, expect, it } from 'vitest'
import { moreLikeThis, presentationOf } from '../src/main/more-like-this'

const s = (id: string, score: number) => ({ id, score })

describe('moreLikeThis', () => {
  it('parses the presentation out of a slide id only', () => {
    expect(presentationOf('slide:abc-1#12')).toBe('abc-1')
    expect(presentationOf('well:1a2b3c4')).toBeNull()
  })

  it('drops the item itself and other slides of the same presentation', () => {
    const out = moreLikeThis(
      [s('slide:p1#3', 1), s('slide:p1#4', 0.95), s('slide:p2#1', 0.9), s('well:aaaaaaa', 0.8), s('slide:p1#9', 0.7)],
      'slide:p1#3'
    )
    expect(out.map((x) => x.id)).toEqual(['slide:p2#1', 'well:aaaaaaa'])
  })

  it('keeps the top six, best first, from an unsorted list', () => {
    const many = Array.from({ length: 12 }, (_, i) => s(`slide:q${i}#1`, i / 20))
    const out = moreLikeThis(many, 'slide:p#1')
    expect(out).toHaveLength(6)
    expect(out.map((x) => x.score)).toEqual([...out.map((x) => x.score)].sort((a, b) => b - a))
    expect(out[0].id).toBe('slide:q11#1')
  })

  it('counts six after the exclusions, not before', () => {
    const same = Array.from({ length: 10 }, (_, i) => s(`slide:p#${i + 2}`, 0.99 - i / 100))
    const others = Array.from({ length: 8 }, (_, i) => s(`slide:o${i}#1`, 0.5 - i / 100))
    expect(moreLikeThis([...same, ...others], 'slide:p#1').map((x) => x.id)).toEqual(others.slice(0, 6).map((x) => x.id))
  })

  it('for a well image only removes the image itself', () => {
    const out = moreLikeThis([s('well:aaaaaaa', 1), s('well:bbbbbbb', 0.9), s('slide:p#1', 0.8)], 'well:aaaaaaa')
    expect(out.map((x) => x.id)).toEqual(['well:bbbbbbb', 'slide:p#1'])
  })

  it('removes duplicate ids and returns nothing for nothing', () => {
    expect(moreLikeThis([s('well:b', 0.9), s('well:b', 0.8)], 'well:a')).toHaveLength(1)
    expect(moreLikeThis([], 'well:a')).toEqual([])
  })
})

import { NotIndexedError } from '../src/main/picture-search/engine'
import { runMoreLikeThis } from '../src/main/more-like-this'

type Row = { id: string; score?: { kind: 'meaning' | 'words'; value: number; label: string } }
const row = { kind: 'slide', deck: 'p1', slideOrder: 3, reference: '' }
const deps = (over: Partial<Parameters<typeof runMoreLikeThis<Row>>[0]> = {}) => ({
  modelReady: () => true,
  query: async () => [s('slide:p1#3', 1), s('slide:p2#1', 0.8), s('well:aaaaaaa', 0.7)],
  resolve: async (ids: string[]) => new Map(ids.map((id) => [id, { id }] as [string, Row])),
  ...over
})

describe('runMoreLikeThis', () => {
  it('returns scored items, never the item itself', async () => {
    const r = await runMoreLikeThis<Row>(deps(), row)
    expect(r.state).toBe('ok')
    expect(r.items.map((i) => i.id)).toEqual(['slide:p2#1', 'well:aaaaaaa'])
    expect(r.items[0].score?.label).toBe('meaning 0.80')
  })
  it('does not query without the model', async () => {
    let called = false
    const r = await runMoreLikeThis<Row>(deps({ modelReady: () => false, query: async () => ((called = true), []) }), row)
    expect(r.state).toBe('no-model')
    expect(called).toBe(false)
  })
  it('says not-indexed for an item with no vector, and for one with no picture id', async () => {
    const r = await runMoreLikeThis<Row>(deps({ query: async () => { throw new NotIndexedError('x') } }), row)
    expect(r.state).toBe('not-indexed')
    expect((await runMoreLikeThis<Row>(deps(), { kind: 'archive-image', deck: 'p', slideOrder: 1, reference: '' })).state).toBe('not-indexed')
  })
  it('reports other failures as error, and skips ids that no longer resolve', async () => {
    expect((await runMoreLikeThis<Row>(deps({ query: async () => { throw new Error('boom') } }), row)).state).toBe('error')
    const r = await runMoreLikeThis<Row>(deps({ resolve: async () => new Map([['well:aaaaaaa', { id: 'well:aaaaaaa' }]]) }), row)
    expect(r.items.map((i) => i.id)).toEqual(['well:aaaaaaa'])
  })
})

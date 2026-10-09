import { describe, it, expect } from 'vitest'
import { mergeLookAlikeClusters, type ClusterShape } from '../src/main/look-alike/merge-clusters'

type Row = { deck: string; id: string | null }
const row = (deck: string, id: string | null): Row => ({ deck, id })
const cluster = (...rows: Row[]): ClusterShape<Row> => ({ representative: rows[0], members: rows, size: rows.length, deckCount: new Set(rows.map((r) => r.deck)).size })
const vec = (deg: number): Float32Array => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)])
const deps = (v: Record<string, Float32Array>) => ({ idOf: (r: Row) => r.id, vectorsOf: (ids: string[]) => new Map(ids.filter((i) => v[i]).map((i) => [i, v[i]])) })

describe('merging result clusters by appearance', () => {
  it('collapses look-alikes into one "N versions" cluster at the first one, keeping order', async () => {
    const out = await mergeLookAlikeClusters(
      [cluster(row('d1', 'a')), cluster(row('d2', 'z')), cluster(row('d3', 'a2')), cluster(row('d4', 'a3'), row('d5', 'a3b'))],
      deps({ a: vec(0), a2: vec(3), a3: vec(5), z: vec(90) })
    )
    expect(out.map((c) => c.representative.id)).toEqual(['a', 'z'])
    expect(out[0].size).toBe(4)
    expect(out[0].deckCount).toBe(4)
    expect(out[0].members.map((m) => m.id)).toEqual(['a', 'a2', 'a3', 'a3b'])
    expect(out[0].lookAlike).toBe('same-picture')
    expect(out[1].lookAlike).toBeUndefined()
  })
  it('marks changed copies as same-thing', async () => {
    const out = await mergeLookAlikeClusters([cluster(row('d1', 'a')), cluster(row('d2', 'b'))], deps({ a: vec(0), b: vec(20) }))
    expect(out).toHaveLength(1)
    expect(out[0].lookAlike).toBe('same-thing')
  })
  it('leaves clusters with no embedding (and rows with no picture id) as they were: text grouping stays', async () => {
    const text = cluster(row('d1', 'noembed'), row('d2', 'noembed2'))
    const input = [cluster(row('d0', null)), text, cluster(row('d3', 'a')), cluster(row('d4', 'a2'))]
    const out = await mergeLookAlikeClusters(input, deps({ a: vec(0), a2: vec(1) }))
    expect(out).toHaveLength(3)
    expect(out[1]).toBe(text)
    expect(out[2].size).toBe(2)
  })
  it('groups only the first `limit` embedded clusters', async () => {
    const v: Record<string, Float32Array> = { a: vec(0), b: vec(1), c: vec(2) }
    const out = await mergeLookAlikeClusters([cluster(row('1', 'a')), cluster(row('2', 'b')), cluster(row('3', 'c'))], deps(v), { limit: 2 })
    expect(out.map((c) => c.size)).toEqual([2, 1])
  })
  it('uses a fingerprint only for ambiguous pairs', async () => {
    const mid = 18 // cos ~ 0.951: in the hash-decided band
    let asked: string[] = []
    const out = await mergeLookAlikeClusters([cluster(row('1', 'a')), cluster(row('2', 'b'))], {
      ...deps({ a: vec(0), b: vec(mid) }),
      fingerprints: async (ids) => ((asked = ids), new Map(ids.map((i) => [i, 5n])))
    })
    expect(asked.sort()).toEqual(['a', 'b'])
    expect(out[0].lookAlike).toBe('same-picture')
  })
})

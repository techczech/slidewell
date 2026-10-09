import { describe, it, expect } from 'vitest'
import { mergeLookAlikeClusters, type ClusterShape } from '../src/main/look-alike/merge-clusters'

type Row = { deck: string; id: string | null; score?: { kind: 'meaning'; value: number; label: string } }
const row = (deck: string, id: string | null): Row => ({ deck, id })
const cluster = (...rows: Row[]): ClusterShape<Row> => ({ representative: rows[0], members: rows, size: rows.length, deckCount: new Set(rows.map((r) => r.deck)).size })
const vec = (deg: number): Float32Array => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)])
const deps = (v: Record<string, Float32Array>) => ({ idOf: (r: Row) => r.id, vectorsOf: (ids: string[]) => new Map(ids.filter((i) => v[i]).map((i) => [i, v[i]])) })
// A search hit as matched-search.ts emits it: the representative is a scored copy, the member is the bare row.
const scoredCluster = (id: string, value: number): ClusterShape<Row> => {
  const r = row('d', id)
  return { representative: { ...r, score: { kind: 'meaning', value, label: `meaning ${value}` } }, members: [r], size: 1, deckCount: 1 }
}

describe('merging result clusters by appearance', () => {
  it('collapses look-alikes into one "N versions" cluster at the first one, keeping order', async () => {
    const out = await mergeLookAlikeClusters(
      [cluster(row('d1', 'a')), cluster(row('d2', 'z')), cluster(row('d3', 'a2')), cluster(row('d4', 'a3'), row('d5', 'a3b'))],
      deps({ a: vec(0), a2: vec(3), a3: vec(5), z: vec(90) })
    )
    // a3b has no embedding: it stays behind as the text fallback
    expect(out.map((c) => c.representative.id)).toEqual(['a', 'z', 'a3b'])
    expect(out[0].size).toBe(3)
    expect(out[0].deckCount).toBe(3)
    expect(out[0].members.map((m) => m.id)).toEqual(['a', 'a2', 'a3'])
    expect(out[0].lookAlike).toBe('same-picture')
    expect(out[1].lookAlike).toBeUndefined()
  })
  it('splits a text cluster: rows are grouped by appearance, not carried along (reviewer case)', async () => {
    // A and X share their text but look different; B looks like A. Old behaviour showed "3 versions, same picture".
    const out = await mergeLookAlikeClusters([cluster(row('d1', 'A'), row('d2', 'X')), cluster(row('d3', 'B'))], deps({ A: vec(0), X: vec(90), B: vec(2) }))
    expect(out.map((c) => c.members.map((m) => m.id))).toEqual([['A', 'B'], ['X']])
    expect(out[0].lookAlike).toBe('same-picture')
    expect(out[1].lookAlike).toBeUndefined()
    expect(out[0].size).toBe(2)
  })
  it('every card tier holds for every pair in it (complete-link across text-cluster members)', async () => {
    const v = { A: vec(0), B: vec(20), C: vec(40) } // A~B and B~C related, A~C not
    const out = await mergeLookAlikeClusters([cluster(row('1', 'A'), row('2', 'C')), cluster(row('3', 'B'))], deps(v))
    for (const c of out) for (const x of c.members) for (const y of c.members) {
      const dot = v[x.id as 'A'].reduce((s, t, i) => s + t * v[y.id as 'A'][i], 0)
      expect(dot).toBeGreaterThanOrEqual(0.9 - 1e-9)
    }
    expect(out.map((c) => c.members.map((m) => m.id))).toEqual([['A', 'B'], ['C']])
  })
  it('keeps only non-embedded rows of a split text cluster as the text fallback', async () => {
    const out = await mergeLookAlikeClusters([cluster(row('1', 'a'), row('2', 'noembed')), cluster(row('3', 'b'))], deps({ a: vec(0), b: vec(1) }))
    expect(out.map((c) => c.members.map((m) => m.id))).toEqual([['a', 'b'], ['noembed']])
  })
  it('asks for vectors of at most `limit` ids, chosen before any lookup', async () => {
    const asked: string[][] = []
    const many = Array.from({ length: 30 }, (_, i) => cluster(row(String(i), `r${i}`)))
    await mergeLookAlikeClusters(many, { idOf: (r: Row) => r.id, vectorsOf: (ids) => (asked.push(ids), new Map()) }, { limit: 10 })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toHaveLength(10)
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
    expect(out.find((c) => c === text)).toBe(text)
    expect(out.find((c) => c.members.some((m) => m.id === 'a'))!.size).toBe(2)
  })
  it('groups only the first `limit` embedded clusters', async () => {
    const v: Record<string, Float32Array> = { a: vec(0), b: vec(1), c: vec(2) }
    const out = await mergeLookAlikeClusters([cluster(row('1', 'a')), cluster(row('2', 'b')), cluster(row('3', 'c'))], deps(v), { limit: 2 })
    expect(out.map((c) => c.size)).toEqual([2, 1])
  })
  it('keeps the meaning score on unrelated singleton cards (reviewer case: 0.95 and 0.85 stay [0.95, 0.85])', async () => {
    const out = await mergeLookAlikeClusters([scoredCluster('p', 0.95), scoredCluster('q', 0.85)], deps({ p: vec(0), q: vec(90) }))
    expect(out.map((c) => c.representative.id)).toEqual(['p', 'q'])
    expect(out.map((c) => c.representative.score?.value)).toEqual([0.95, 0.85])
    expect(out.map((c) => c.size)).toEqual([1, 1])
  })
  it('a merged group keeps its highest member score on the representative', async () => {
    const out = await mergeLookAlikeClusters([scoredCluster('a', 0.6), scoredCluster('a2', 0.9), scoredCluster('a3', 0.75)], deps({ a: vec(0), a2: vec(3), a3: vec(5) }))
    expect(out).toHaveLength(1)
    expect(out[0].size).toBe(3)
    expect(out[0].representative.id).toBe('a2')
    expect(out[0].representative.score?.value).toBe(0.9)
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

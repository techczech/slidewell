import { describe, it, expect } from 'vitest'
import {
  LOOK_ALIKE_THRESHOLDS as T,
  bestKeptTier,
  cosine,
  dHashFromGrey,
  groupLookAlikes,
  groupWithFingerprints,
  hashDistance,
  tierOf,
  type LookAlikeItem
} from '../src/main/look-alike/groups'
import { GROUP_LIMIT } from '../src/main/look-alike/merge-clusters'

/** Unit vector at angle `deg` from the x axis in the first plane: cosine to angle 0 is cos(deg). */
const at = (deg: number, dim = 8): Float32Array => {
  const v = new Float32Array(dim)
  v[0] = Math.cos((deg * Math.PI) / 180)
  v[1] = Math.sin((deg * Math.PI) / 180)
  return v
}
const angleFor = (cos: number): number => (Math.acos(cos) * 180) / Math.PI
const item = (id: string, deg: number, extra: Partial<LookAlikeItem> = {}): LookAlikeItem => ({ id, vector: at(deg), ...extra })
const tiers = (g: ReturnType<typeof groupLookAlikes>): string[] => g.groups.map((x) => `${x.ids.join('+')}:${x.tier}`)

describe('pair tiers', () => {
  it('cosine bands: below sameThing none, then same-thing, same-picture at the top', () => {
    expect(tierOf(T.sameThing - 0.01, null).tier).toBeNull()
    expect(tierOf(T.sameThing, null).tier).toBe('same-thing')
    expect(tierOf(T.samePicture, null).tier).toBe('same-picture')
  })
  it('the fingerprint breaks the tie in the middle band, and only there', () => {
    const mid = (T.samePictureWithHash + T.samePicture) / 2
    expect(tierOf(mid, null)).toEqual({ tier: 'same-thing', needsHash: true })
    expect(tierOf(mid, T.hashSame)).toEqual({ tier: 'same-picture', needsHash: false })
    expect(tierOf(mid, T.hashSame + 1)).toEqual({ tier: 'same-thing', needsHash: false })
    expect(tierOf(T.sameThing + 0.001, 0).tier).toBe('same-thing') // a lucky hash cannot upgrade a low cosine
    expect(tierOf(0.995, T.hashDifferent + 1).tier).toBe('same-thing') // a very different hash demotes a high cosine
  })
})

describe('dHash', () => {
  const ramp = Array.from({ length: 72 }, (_, i) => (i % 9) * 10)
  it('is stable, 64 bits, and distance counts differing bits', () => {
    const a = dHashFromGrey(ramp)
    expect(dHashFromGrey(ramp)).toBe(a)
    expect(hashDistance(a, a)).toBe(0)
    expect(hashDistance(0n, 0xffffffffffffffffn)).toBe(64)
    const flipped = dHashFromGrey(ramp.map((x) => 90 - x))
    expect(hashDistance(a, flipped)).toBe(64)
  })
  it('does not change when the whole picture is brightened', () => {
    expect(hashDistance(dHashFromGrey(ramp), dHashFromGrey(ramp.map((x) => x + 40)))).toBe(0)
  })
  it('rejects the wrong size', () => {
    expect(() => dHashFromGrey([1, 2, 3])).toThrow()
  })
})

describe('grouping: tiers', () => {
  it('splits same-picture, same-thing-changed and unrelated', () => {
    const r = groupLookAlikes([item('a', 0), item('a2', angleFor(0.995)), item('b', 40), item('b2', 40 + angleFor(0.93)), item('c', 120)])
    expect(tiers(r)).toEqual(['a+a2:same-picture', 'b+b2:same-thing', 'c:null'])
  })
  it('a group is same-picture only if every pair is', () => {
    const d = angleFor(0.995)
    // a~b same picture, a~c same picture, b~c: 2d apart, cos(2d) ~ 0.980 -> same-thing; so the group is same-thing
    const r = groupLookAlikes([item('a', 0), item('b', d), item('c', -d)])
    expect(tiers(r)).toEqual(['a+b+c:same-thing'])
  })
  it('every input id lands in exactly one group, in input order', () => {
    const ids = ['p', 'q', 'r', 's', 't']
    const r = groupLookAlikes(ids.map((id, i) => item(id, i * 7)))
    expect(r.groups.flatMap((g) => g.ids).sort()).toEqual([...ids].sort())
  })
})

describe('grouping: transitivity is complete-link', () => {
  // A~B and B~C are same-thing, A and C are not: angles 0, 20, 40 with cos(20deg)=0.94 >= 0.90, cos(40deg)=0.77 < 0.90
  it('a chain A-B-C does not become one group (single-link would)', () => {
    expect(cosine(at(0), at(20))).toBeGreaterThan(T.sameThing)
    expect(cosine(at(20), at(40))).toBeGreaterThan(T.sameThing)
    expect(cosine(at(0), at(40))).toBeLessThan(T.sameThing)
    const r = groupLookAlikes([item('A', 0), item('B', 20), item('C', 40)])
    expect(tiers(r)).toEqual(['A+B:same-thing', 'C:null'])
  })
  it('an item joins the first group it is related to ALL of; the best-ranked item anchors', () => {
    const r = groupLookAlikes([item('A', 0), item('C', 40), item('B', 20)])
    // B fits A (0.94) and C (0.94); first group wins; C is not related to A, so B does not join A+... it joins A only
    expect(tiers(r)).toEqual(['A+B:same-thing', 'C:null'])
  })
  it('a long drifting series splits into several small groups instead of one', () => {
    const series = Array.from({ length: 10 }, (_, i) => item(`s${i}`, i * 15))
    const r = groupLookAlikes(series)
    expect(Math.max(...r.groups.map((g) => g.ids.length))).toBeLessThan(10)
    for (const g of r.groups) for (const x of g.ids) for (const y of g.ids) expect(cosine(series.find((s) => s.id === x)!.vector!, series.find((s) => s.id === y)!.vector!)).toBeGreaterThanOrEqual(T.sameThing - 1e-9)
  })
})

describe('grouping: fingerprints and missing embeddings', () => {
  const mid = angleFor((T.samePictureWithHash + T.samePicture) / 2)
  it('reports the ids whose tier hinges on a missing fingerprint', () => {
    const r = groupLookAlikes([item('a', 0), item('b', mid), item('z', 90)])
    expect(r.ambiguousIds.sort()).toEqual(['a', 'b'])
    expect(tiers(r)).toEqual(['a+b:same-thing', 'z:null'])
  })
  it('groupWithFingerprints asks only for those ids, and a close hash makes the pair same-picture', async () => {
    let asked: string[] = []
    const g = await groupWithFingerprints([item('a', 0), item('b', mid), item('z', 90)], async (ids) => {
      asked = ids
      return new Map(ids.map((id) => [id, 0n]))
    })
    expect(asked.sort()).toEqual(['a', 'b'])
    expect(g.map((x) => `${x.ids.join('+')}:${x.tier}`)).toEqual(['a+b:same-picture', 'z:null'])
  })
  it('a far hash keeps the pair same-thing; no fingerprint source answers nothing', async () => {
    const far = await groupWithFingerprints([item('a', 0), item('b', mid)], async () => new Map([['a', 0n], ['b', 0xffffffffffffffffn]]))
    expect(far[0].tier).toBe('same-thing')
    const none = await groupWithFingerprints([item('a', 0), item('b', mid)], async () => new Map())
    expect(none[0].tier).toBe('same-thing')
  })
  it('items without an embedding stay alone (the caller falls back to text grouping)', () => {
    const r = groupLookAlikes([item('a', 0), { id: 'x' }, { id: 'y', vector: null }, item('a2', angleFor(0.995))])
    expect(tiers(r)).toEqual(['a+a2:same-picture', 'x:null', 'y:null'])
  })
})

describe('kept-copy tier (sorter signal)', () => {
  it('best tier against any kept picture, or null', () => {
    expect(bestKeptTier(at(0), [at(90), at(60)])).toBeNull()
    expect(bestKeptTier(at(0), [at(90), at(angleFor(0.93))])).toBe('same-thing')
    expect(bestKeptTier(at(0), [at(angleFor(0.93)), at(angleFor(0.995))])).toBe('same-picture')
    expect(bestKeptTier(at(0), [])).toBeNull()
  })
})

describe('speed', () => {
  it('groups GROUP_LIMIT (200) unrelated 768-d items in under 50 ms (bounded work on the main process)', () => {
    let s = 7
    const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 2 ** 32 - 0.5)
    const items: LookAlikeItem[] = Array.from({ length: GROUP_LIMIT }, (_, i) => {
      const v = new Float32Array(768)
      let n = 0
      for (let k = 0; k < 768; k++) {
        v[k] = rnd()
        n += v[k] * v[k]
      }
      n = Math.sqrt(n)
      for (let k = 0; k < 768; k++) v[k] /= n
      return { id: `i${i}`, vector: v }
    })
    // Warm up once, then time five runs and assert on the median. A single timing is
    // too noisy under parallel test-file load; the median keeps the bounded-work intent.
    groupLookAlikes(items)
    const times: number[] = []
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now()
      groupLookAlikes(items)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[2]
    console.log(`grouped 200 x 768-d, median of 5 in ${median.toFixed(1)} ms`)
    expect(median).toBeLessThan(50)
  })
})

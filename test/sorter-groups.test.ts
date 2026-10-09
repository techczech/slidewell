import { describe, it, expect } from 'vitest'
import { groupRelated, groupKFold } from '../src/main/sorter/groups'
import { normalise } from '../src/main/picture-search/engine'

const v = (...xs: number[]): Float32Array => normalise(Float32Array.from(xs))

describe('related screenshots', () => {
  it('near-duplicates (cosine ≥ 0.95) group, and groups are connected components', () => {
    const g = groupRelated([
      { id: 'a', vector: v(1, 0, 0) },
      { id: 'b', vector: v(1, 0.3, 0) }, // cos(a,b) ≈ 0.958
      { id: 'c', vector: v(1, 0.6, 0) }, // cos(b,c) ≈ 0.98, cos(a,c) ≈ 0.86: joined through b
      { id: 'd', vector: v(0, 0, 1) }
    ])
    expect(g.groupOf.get('a')).toBe('a')
    expect(g.groupOf.get('b')).toBe('a')
    expect(g.groupOf.get('c')).toBe('a')
    expect(g.groupOf.get('d')).toBe('d')
    expect(g).toMatchObject({ groups: 2, largest: 3 })
  })

  it('same app and window title within 5 minutes group; later, or without a window title, they do not', () => {
    const far = (i: number): Float32Array => v(...Array.from({ length: 6 }, (_, k) => (k === i ? 1 : 0)))
    const g = groupRelated([
      { id: 'a', vector: far(0), app: 'Terminal', windowTitle: 'zsh', takenAt: '2026-10-09T10:00:00' },
      { id: 'b', vector: far(1), app: 'Terminal', windowTitle: 'zsh', takenAt: '2026-10-09T10:04:59' },
      { id: 'c', vector: far(2), app: 'Terminal', windowTitle: 'zsh', takenAt: '2026-10-09T10:20:00' },
      { id: 'd', vector: far(3), app: 'Terminal', windowTitle: '', takenAt: '2026-10-09T10:00:10' },
      { id: 'e', vector: far(4), app: 'Finder', windowTitle: 'zsh', takenAt: '2026-10-09T10:00:20' },
      { id: 'f', vector: far(5), app: 'Terminal', windowTitle: 'zsh', takenAt: '' }
    ])
    expect(g.groupOf.get('b')).toBe('a')
    for (const id of ['c', 'd', 'e', 'f']) expect(g.groupOf.get(id)).toBe(id)
  })

  it('group k-fold never splits a group and stays label-stratified', () => {
    const xs = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `big${i}`, keep: true, group: 'G' })),
      ...Array.from({ length: 14 }, (_, i) => ({ id: `k${i}`, keep: true })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, keep: false }))
    ]
    const folds = groupKFold(xs, 5)
    expect(folds.filter((f) => f.some((x) => x.group === 'G'))).toHaveLength(1)
    expect(folds.flat()).toHaveLength(xs.length)
    for (const f of folds) expect(f.filter((x) => !x.keep)).toHaveLength(2)
  })
})

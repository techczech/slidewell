import { describe, it, expect } from 'vitest'
import { pickStore, keyForPath } from '../src/main/storage'

const roots = { archive: '/a/arch', others: '/a/oth', well: '/a/well' }

describe('pickStore', () => {
  it('matches a path to the store whose root contains it', () => {
    expect(pickStore(roots, '/a/well/images/x.webp')).toEqual({ store: 'well', root: '/a/well' })
    expect(pickStore(roots, '/a/arch/extracted/d/renders/s.webp')).toEqual({ store: 'archive', root: '/a/arch' })
    expect(pickStore(roots, '/a/oth/extracted/e/media/i.png')).toEqual({ store: 'others', root: '/a/oth' })
  })
  it('returns null for a path under no store root', () => {
    expect(pickStore(roots, '/somewhere/else.webp')).toBeNull()
  })
  it('does not match a sibling-prefix root (/a/well vs /a/wellington)', () => {
    expect(pickStore({ well: '/a/well' }, '/a/wellington/x.webp')).toBeNull()
  })
})

describe('keyForPath', () => {
  it('builds the path-mirrored R2 key under prefix/store', () => {
    expect(keyForPath('slidewell', 'well', '/a/well', '/a/well/images/x.webp')).toBe('slidewell/well/images/x.webp')
    expect(keyForPath('slidewell', 'archive', '/a/arch', '/a/arch/extracted/d/renders/s.webp')).toBe('slidewell/archive/extracted/d/renders/s.webp')
  })
})

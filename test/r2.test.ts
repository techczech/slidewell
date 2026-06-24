import { describe, it, expect } from 'vitest'
import { r2Endpoint, r2KeyFor } from '../src/main/r2'

describe('r2Endpoint', () => {
  it('derives the R2 S3 endpoint from the account id', () => {
    expect(r2Endpoint({ accountId: 'abc123' })).toBe('https://abc123.r2.cloudflarestorage.com')
  })
  it('honours an explicit endpoint override (trailing slash trimmed)', () => {
    expect(r2Endpoint({ accountId: 'abc', endpoint: 'https://x.example.com/' })).toBe('https://x.example.com')
  })
})

describe('r2KeyFor', () => {
  it('joins prefix/store/relPath with single slashes, no leading slash', () => {
    expect(r2KeyFor('slidewell', 'archive', 'extracted/d/renders/s.webp')).toBe('slidewell/archive/extracted/d/renders/s.webp')
  })
  it('tolerates stray slashes and empty prefix', () => {
    expect(r2KeyFor('/slidewell/', 'well', '/images/a.webp')).toBe('slidewell/well/images/a.webp')
    expect(r2KeyFor('', 'well', 'images/a.webp')).toBe('well/images/a.webp')
  })
})

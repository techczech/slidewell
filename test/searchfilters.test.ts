import { describe, it, expect } from 'vitest'
import { countFrom, fromOf, matchesFromKind, matchesKind, planSources, NO_TEXT_THRESHOLD } from '../src/main/searchfilters'

const shot = (text = 'hello world text') => ({ kind: 'well-image', text })
const oldImg = (text = 'hello world text') => ({ kind: 'archive-image', text })
const slide = (text = 'slide text here') => ({ kind: 'slide', text })

describe('fromOf', () => {
  it('maps result kinds to From buckets', () => {
    expect(fromOf(shot())).toBe('screenshots')
    expect(fromOf(oldImg())).toBe('old-images')
    expect(fromOf(slide())).toBe('old-slides')
    expect(fromOf({ kind: 'ocr-render', text: '' })).toBe('old-slides')
  })
})

describe('Kind', () => {
  it('"Pictures without text" keeps only pictures with empty or tiny OCR text', () => {
    expect(matchesKind(shot(''), 'no-text')).toBe(true)
    expect(matchesKind(oldImg('  \n '), 'no-text')).toBe(true)
    expect(matchesKind(oldImg('x'.repeat(NO_TEXT_THRESHOLD - 1)), 'no-text')).toBe(true)
    expect(matchesKind(oldImg('x'.repeat(NO_TEXT_THRESHOLD)), 'no-text')).toBe(false)
    expect(matchesKind(slide(''), 'no-text')).toBe(false)
  })
  it('"Embedded images only" keeps only images extracted from presentations', () => {
    expect(matchesKind(oldImg(), 'embedded')).toBe(true)
    expect(matchesKind(shot(), 'embedded')).toBe(false)
    expect(matchesKind(slide(), 'embedded')).toBe(false)
  })
  it('All keeps everything', () => {
    for (const r of [shot(), oldImg(), slide()]) expect(matchesKind(r, 'all')).toBe(true)
  })
})

describe('matchesFromKind and countFrom', () => {
  const rows = [shot(), shot(''), oldImg(), oldImg(''), slide(), slide(), slide()]
  it('From narrows by bucket', () => {
    expect(rows.filter((r) => matchesFromKind(r, 'old-slides', 'all'))).toHaveLength(3)
    expect(rows.filter((r) => matchesFromKind(r, 'screenshots', 'all'))).toHaveLength(2)
    expect(rows.filter((r) => matchesFromKind(r, 'talks', 'all'))).toHaveLength(0)
    expect([...rows, { ...shot(), usedInTalks: 2 }].filter((r) => matchesFromKind(r, 'talks', 'all'))).toHaveLength(1)
  })
  it('From and Kind combine', () => {
    expect(rows.filter((r) => matchesFromKind(r, 'screenshots', 'no-text'))).toHaveLength(1)
    expect(rows.filter((r) => matchesFromKind(r, 'old-slides', 'embedded'))).toHaveLength(0)
  })
  it('a result used in talks counts under its bucket and under talks', () => {
    const used = [{ ...shot(), usedInTalks: 1 }, shot(), oldImg()]
    expect(countFrom(used, 'all')).toEqual({ all: 3, screenshots: 2, 'old-images': 1, 'old-slides': 0, talks: 1 })
  })
  it('counts per chip with the Kind applied; talks is 0 when nothing is used', () => {
    expect(countFrom(rows, 'all')).toEqual({ all: 7, screenshots: 2, 'old-images': 2, 'old-slides': 3, talks: 0 })
    expect(countFrom(rows, 'no-text')).toEqual({ all: 2, screenshots: 1, 'old-images': 1, 'old-slides': 0, talks: 0 })
    expect(countFrom(rows, 'embedded')).toEqual({ all: 2, screenshots: 0, 'old-images': 2, 'old-slides': 0, talks: 0 })
  })
})

describe('planSources', () => {
  it('From = All follows Type', () => {
    expect(planSources('slides', 'all', 'all')).toEqual({ slides: true, archiveImages: false, well: false })
    expect(planSources('images', 'all', 'all')).toEqual({ slides: false, archiveImages: true, well: true })
  })
  it('a From chip decides on its own', () => {
    expect(planSources('slides', 'screenshots', 'all')).toEqual({ slides: false, archiveImages: false, well: true })
    expect(planSources('images', 'old-slides', 'all')).toEqual({ slides: true, archiveImages: false, well: false })
    expect(planSources('images', 'old-images', 'all')).toEqual({ slides: false, archiveImages: true, well: false })
    expect(planSources('images', 'talks', 'all')).toEqual({ slides: false, archiveImages: false, well: true })
  })
  it('Kind drops slides; Embedded drops the well', () => {
    expect(planSources('slides', 'all', 'no-text')).toEqual({ slides: false, archiveImages: true, well: true })
    expect(planSources('images', 'all', 'embedded')).toEqual({ slides: false, archiveImages: true, well: false })
    expect(planSources('images', 'old-slides', 'no-text').slides).toBe(false)
  })
})

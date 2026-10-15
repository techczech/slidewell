import { describe, it, expect } from 'vitest'
import { noteFailed, noteLoaded, shownPicture } from '../src/renderer/src/ReviewShot'
import type { ReviewCard } from '../src/preload'

// shownPicture is what the renderer sends with an answer: main records the worse of it and its own file check.
const card = (thumbUrl: string | null, picture: ReviewCard['picture'] = 'ok'): ReviewCard => ({ hash: 'a'.repeat(64), thumbUrl, picture }) as ReviewCard

describe('shownPicture: a picture counts as seen only once it has loaded', () => {
  it('still loading: none, not ok', () => {
    expect(shownPicture(card('swarchive://f/still-loading'))).toBe('none')
  })

  it('loaded: ok; the same URL on another card is ok too (window-wide)', () => {
    noteLoaded('swarchive://f/loaded')
    expect(shownPicture(card('swarchive://f/loaded'))).toBe('ok')
    expect(shownPicture({ ...card('swarchive://f/loaded'), hash: 'b'.repeat(64) })).toBe('ok')
  })

  it('failed: missing; a later successful load of that URL makes it ok', () => {
    noteFailed('swarchive://f/flaky')
    expect(shownPicture(card('swarchive://f/flaky'))).toBe('missing')
    noteLoaded('swarchive://f/flaky')
    expect(shownPicture(card('swarchive://f/flaky'))).toBe('ok')
  })

  it('no URL: the reason main gave, and none in place of ok', () => {
    expect(shownPicture(card(null, 'not-downloaded'))).toBe('not-downloaded')
    expect(shownPicture(card(null, 'missing'))).toBe('missing')
    expect(shownPicture(card(null, 'ok'))).toBe('none')
  })
})

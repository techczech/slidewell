import { expect, it } from 'vitest'
import { captureNotice } from '../src/renderer/src/capture-notice'

it('summarises several missing folders in one notice', () => {
  expect(captureNotice(['/old/First', '/old/Second'])).toBe(
    'SlideWell can no longer find 2 capture folders. New screenshots from them are not arriving.'
  )
})

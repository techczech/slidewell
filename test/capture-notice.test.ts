import { expect, it } from 'vitest'

it('summarises several missing folders in one notice', async () => {
  const { captureNotice } = await import('../src/renderer/src/capture-notice').catch(() => ({ captureNotice: () => undefined }))
  expect(captureNotice(['/old/First', '/old/Second'])).toBe(
    'SlideWell can no longer find 2 capture folders. New screenshots from them are not arriving.'
  )
})

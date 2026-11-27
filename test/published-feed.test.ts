import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseChannelFeed } from '../src/shared/update-channels'
import { UPDATE_IDENTITY } from '../src/shared/update-identity'

// The feed GitHub Pages serves must pass the app's own reader; alpha.23's went out with a summary line over 120 characters.
it('docs/updates.json is a feed the app accepts', () => {
  const result = parseChannelFeed(readFileSync(join(__dirname, '..', 'docs', 'updates.json'), 'utf8'), UPDATE_IDENTITY.feedUrl)
  expect(result).toMatchObject({ ok: true })
})

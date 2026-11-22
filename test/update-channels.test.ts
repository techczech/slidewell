import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newerOffer, parseChannelFeed, RELEASE_ASSET_PREFIX, PUBLISHED_BUNDLE_ID } from '../src/shared/update-channels'
import { UPDATE_IDENTITY } from '../src/shared/update-identity'

const release = {
  version: '1.2.0', released: '2026-11-22', summary: ['Faster searches.'],
  notes: 'https://techczech.github.io/slidewell/#notes',
  download: { mac: 'https://techczech.github.io/slidewell/#download', windows: 'https://techczech.github.io/slidewell/#download' }
}
const alpha = { ...release, version: '1.3.0-alpha.10' }
const mac = {
  url: RELEASE_ASSET_PREFIX + 'v1.2.0/SlideWell-mac-arm64.zip',
  sha512: createHash('sha512').update('fixture').digest('base64'),
  size: 12345, bundleId: PUBLISHED_BUNDLE_ID
}
const parse = (channels?: unknown) => parseChannelFeed(JSON.stringify({ schema: 1, latest: release, channels }), UPDATE_IDENTITY.feedUrl)

describe('SlideWell update feed', () => {
  it('keeps schema-1 notices and validates a release with a Mac update asset', () => {
    expect(parse()).toEqual({ ok: true, feed: { release, alpha: null } })
    expect(parse({ release: { ...release, update: { mac } }, alpha })).toEqual({
      ok: true, feed: { release: { ...release, update: { mac } }, alpha }
    })
  })

  it('orders numeric alphas and never downgrades on opt-out', () => {
    const feed = { release, alpha }
    expect(newerOffer(feed, false, '1.1.0')?.version).toBe('1.2.0')
    expect(newerOffer(feed, true, '1.3.0-alpha.2')?.version).toBe('1.3.0-alpha.10')
    expect(newerOffer(feed, false, '1.3.0-alpha.2')).toBeNull()
    expect(newerOffer(feed, true, alpha.version)).toBeNull()
    expect(newerOffer({ release: { ...release, version: '1.3.0' }, alpha }, true, alpha.version)?.version).toBe('1.3.0')
  })

  it.each([
    { url: 'https://example.org/v1.2.0/SlideWell-mac-arm64.zip' },
    { url: mac.url.replace('v1.2.0', 'v1.0.0') },
    { url: mac.url + '?q=1' },
    { sha512: 'x'.repeat(86) + '==' },
    { sha512: 'not-a-digest' },
    { size: 0 },
    { size: 1.5 },
    { bundleId: 'net.dominiklukes.other-app' },
    { bundleId: undefined }
  ])('rejects the whole feed for malformed update metadata %j', (patch) => {
    expect(parse({ release: { ...release, update: { mac: { ...mac, ...patch } } }, alpha }).ok).toBe(false)
  })

  it('refuses conflicting release entries and non-alpha prereleases', () => {
    expect(parse({ release: { ...release, summary: ['Different.'] }, alpha }).ok).toBe(false)
    expect(parse({ release, alpha: { ...alpha, version: '1.3.0-beta.10' } }).ok).toBe(false)
    expect(parse({ release, alpha: { ...alpha, notes: 'https://techczech.github.io/other-project/' } }).ok).toBe(false)
  })
})

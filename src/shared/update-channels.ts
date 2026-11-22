// The update feed with channels (ADR-0054, porting TalkWeaver ADR-0044 §2). Pure: no Electron, no network;
// unit-tested in test/update-channels.test.ts.
//
// `updates.json` keeps `schema: 1` and `latest` (what copies up to 0.28.x read) and gains `channels.release` (field
// for field the same as `latest`) and `channels.alpha` (optional). Each entry may name a Mac update asset
// at that entry's own GitHub release tag, with its SHA-512
// and size. The whole feed is refused when any part of it is wrong, as before. The shared validator in
// @app-patterns/updates 0.4.1 ignores the unknown `channels` key, so older copies keep telling and linking.
import {
  MAX_FEED_BYTES, compareVersions, parseVersion, validateFeedObject, type UpdateFeedLatest,
} from '@app-patterns/updates'
import { UPDATE_INSTALL_IDENTITY } from './update-identity'

/** Where every update file must live: the public repository's release assets. */
export const RELEASE_ASSET_PREFIX: string = UPDATE_INSTALL_IDENTITY.releaseAssetPrefix
/** The bundle identifier of the published Mac app (the public repository's build.appId). */
export const PUBLISHED_BUNDLE_ID: string = UPDATE_INSTALL_IDENTITY.bundleId
/** Largest update file accepted: 4 GiB. */
export const MAX_UPDATE_FILE_BYTES = 4 * 1024 * 1024 * 1024

export interface UpdateFile {
  /** `<asset prefix>v<version>/<file>.zip` (Mac). */
  url: string
  /** Base64 SHA-512 of the file (as electron-builder writes it). */
  sha512: string
  /** Exact size in bytes. */
  size: number
  /** Bundle identifier of the released Mac app. */
  bundleId: string
}
export interface ChannelEntry extends UpdateFeedLatest {
  update?: { mac?: UpdateFile }
}
export interface ChannelFeed {
  release: ChannelEntry
  /** Absent when no alpha is published (or the feed predates channels). */
  alpha: ChannelEntry | null
}
export type ChannelFeedResult = { ok: true; feed: ChannelFeed } | { ok: false; reason: 'too-large' | 'not-json' | 'not-a-version-list' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `0.29.0-alpha.2`: a release number with exactly `alpha.<n>` after it. */
export function isAlphaVersion(text: unknown): text is string {
  const parsed = parseVersion(text)
  return parsed !== null && parsed.pre.length === 2 && parsed.pre[0] === 'alpha' && typeof parsed.pre[1] === 'number'
}

const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/

/** One platform's update file, or null when anything about it is wrong. */
export function validateUpdateFile(value: unknown, version: string, assetPrefix: string = RELEASE_ASSET_PREFIX): UpdateFile | null {
  if (!isRecord(value)) return null
  const { url, sha512, size, bundleId } = value
  if (typeof url !== 'string' || url.length > 400 || /[\u0000- \u007f\\%?#]/.test(url)) return null
  const folder = `${assetPrefix}v${version}/`
  if (!url.startsWith(folder)) return null
  const name = url.slice(folder.length)
  if (name !== 'SlideWell-mac-arm64.zip') return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.href !== url || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return null
  if (typeof sha512 !== 'string' || !SHA512_BASE64.test(sha512) || !'AQgw'.includes(sha512[85])) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_FILE_BYTES) return null
  if (typeof bundleId !== 'string' || bundleId !== (assetPrefix === RELEASE_ASSET_PREFIX ? PUBLISHED_BUNDLE_ID : UPDATE_INSTALL_IDENTITY.fixtureBundleId)) return null
  return { url, sha512, size, bundleId }
}

/**
 * One channel's entry. The fields `latest` has are checked by the shared validator (an alpha's version is
 * checked here, then handed over as its release number); `update` by validateUpdateFile.
 */
export function validateChannelEntry(value: unknown, kind: 'release' | 'alpha', feedUrl: string, assetPrefix: string = RELEASE_ASSET_PREFIX): ChannelEntry | null {
  if (!isRecord(value) || typeof value.version !== 'string') return null
  const version = value.version
  if (kind === 'alpha' && !isAlphaVersion(version)) return null
  const parsed = parseVersion(version)
  if (!parsed) return null
  if (![parsed.major, parsed.minor, parsed.patch, ...parsed.pre.filter((v) => typeof v === 'number')].every(Number.isSafeInteger)) return null
  const releaseNumber = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  const base = validateFeedObject({ schema: 1, latest: { ...value, version: kind === 'alpha' ? releaseNumber : version } }, feedUrl)
  if (!base || !hasSlideWellLinks(base)) return null
  const entry: ChannelEntry = { ...base, version }
  if (value.update !== undefined) {
    if (!isRecord(value.update)) return null
    if (Object.keys(value.update).some((key) => key !== 'mac')) return null
    const mac = value.update.mac === undefined ? undefined : validateUpdateFile(value.update.mac, version, assetPrefix)
    if (mac === null) return null
    entry.update = mac ? { mac } : {}
  }
  return entry
}

/** `latest` and `channels.release` say the same thing (every field `latest` has). */
export function sameAsLatest(latest: UpdateFeedLatest, release: ChannelEntry): boolean {
  return latest.version === release.version && latest.released === release.released && latest.notes === release.notes
    && latest.download.mac === release.download.mac && latest.download.windows === release.download.windows
    && latest.summary.length === release.summary.length && latest.summary.every((line, i) => line === release.summary[i])
}

/** Validates a parsed feed: `latest` as before, then `channels` if there are any. Null when anything is wrong. */
export function validateChannelFeedObject(value: unknown, feedUrl: string, assetPrefix: string = RELEASE_ASSET_PREFIX): ChannelFeed | null {
  const latest = validateFeedObject(value, feedUrl)
  if (!latest || !hasSlideWellLinks(latest) || !isRecord(value)) return null
  if (value.channels === undefined) return { release: latest, alpha: null }
  if (!isRecord(value.channels)) return null
  for (const key of Object.keys(value.channels)) if (key !== 'release' && key !== 'alpha') return null
  const release = validateChannelEntry(value.channels.release, 'release', feedUrl, assetPrefix)
  if (!release || !sameAsLatest(latest, release)) return null
  const rawAlpha = value.channels.alpha
  if (rawAlpha === undefined || rawAlpha === null) return { release, alpha: null }
  const alpha = validateChannelEntry(rawAlpha, 'alpha', feedUrl, assetPrefix)
  return alpha ? { release, alpha } : null
}

/** Validates the text of an answer: size, JSON, then shape. */
export function parseChannelFeed(text: unknown, feedUrl: string, assetPrefix: string = RELEASE_ASSET_PREFIX): ChannelFeedResult {
  if (typeof text !== 'string') return { ok: false, reason: 'not-json' }
  if (new TextEncoder().encode(text).length > MAX_FEED_BYTES) return { ok: false, reason: 'too-large' }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, reason: 'not-json' } }
  const feed = validateChannelFeedObject(parsed, feedUrl, assetPrefix)
  return feed ? { ok: true, feed } : { ok: false, reason: 'not-a-version-list' }
}

/**
 * The version this copy is offered, before comparing with the running one: the release; with alpha on,
 * the newer of the release and the alpha. A release user never sees an alpha.
 */
export function channelOffer(feed: ChannelFeed, alpha: boolean): ChannelEntry {
  if (alpha && feed.alpha && compareVersions(feed.alpha.version, feed.release.version) > 0) return feed.alpha
  return feed.release
}

/** The entry worth a mark: the offer when it is newer than the running version (never a downgrade), else null. */
export function newerOffer(feed: ChannelFeed | undefined, alpha: boolean, running: string): ChannelEntry | null {
  if (!feed) return null
  const offer = channelOffer(feed, alpha)
  return compareVersions(offer.version, running) > 0 ? offer : null
}

/**
 * Update commits to the version the person saw (ADR-0054): `expected` is what the renderer showed, checked only as a
 * version string; true only when it is exactly the offer now. Nothing is built from it.
 */
export function isOfferSeen(expected: unknown, offer: ChannelEntry | null): offer is ChannelEntry {
  return typeof expected === 'string' && expected.length <= 64 && parseVersion(expected) !== null && offer !== null && offer.version === expected
}

/** The update file for this computer (`process.platform`, `process.arch`): Apple silicon Macs only. */
export function updateFileFor(entry: ChannelEntry | null | undefined, platform: string, arch: string): UpdateFile | null {
  if (!entry?.update) return null
  if (platform === 'darwin' && arch === 'arm64') return entry.update.mac ?? null
  return null
}


function hasSlideWellLinks({ notes, download }: UpdateFeedLatest): boolean {
  return [notes, download.mac, download.windows].every((link) => new URL(link).pathname.startsWith('/slidewell/'))
}

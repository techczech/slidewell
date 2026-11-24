import { app, net, session, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  copySource, createUpdateChecker, feedRequest, readUpdateState,
  compareVersions, type FeedAnswer, type UpdateSnapshot as NoticeSnapshot, type WhatsNewItem
} from '@app-patterns/updates'
import { createElectronFeedFetcher, createUpdateLinkOpener } from '@app-patterns/updates/electron'
import { channelOffer, isOfferSeen, newerOffer, parseChannelFeed, RELEASE_ASSET_PREFIX, updateFileFor, validateChannelFeedObject } from '../shared/update-channels'
import { IDLE, inPlaceRefusal } from '../shared/update-install'
import type { UpdateSnapshot } from '../shared/update-snapshot'
import { createUpdateInstaller, readInPlaceFacts, type InstallerDeps, type UpdateInstaller } from './update-installer'
import { isUpdateFixture, readFixtureFeed, updateFixtureRoot } from './update-fixture'
import { CHECK_UPDATES, UPDATE_IDENTITY, WHATS_NEW } from '../shared/update-identity'

const shippedNotes: Record<string, readonly WhatsNewItem[]> = {
  '0.4.0-alpha.22': [
    { title: 'Missing capture folders are shown', text: 'When a watched screenshot folder disappears or is renamed, Triage says so and Settings › Watched folders marks it. Choose folder… points SlideWell at the new place, or Stop watching turns it off.' },
    { title: 'No duplicate screenshots after a move', text: 'When you point SlideWell at a moved folder, the screenshots already in Triage are matched to their new place and keep your decisions, instead of appearing a second time.' }
  ],
  '0.4.0-alpha.21': [
    { title: 'New screenshots arrive on their own', text: 'Triage now looks for new captures when you come back to SlideWell and once a minute while it is open, so a screenshot shows up even when macOS forgets to announce it.' },
    { title: 'Updates in one click', text: 'Tick Get early versions (alpha) in Settings › About and updates to install new versions from inside SlideWell; it checks that each one comes from the same developer before restarting.' },
    { title: 'Security fixes', text: 'The picture library SlideWell uses to read and resize images is updated to a version with known problems fixed.' }
  ],
  '0.4.0-alpha.20': [
    { title: 'Update notices', text: 'SlideWell checks once a day whether a newer version exists and tells you. Turn this off in Settings › About and updates.' },
    { title: 'Safer saving', text: 'A screenshot leaves the inbox only after its copy in the well has been checked, and a damaged settings file is kept aside instead of being overwritten.' }
  ],
  '0.4.0-alpha.19': [
    { title: 'Settings in one place', text: 'Open Settings to manage your archive, watched folders, AI accounts and shortcuts.' },
    { title: 'Screenshot review', text: 'Review your sorter’s suggestions before deciding what to keep or throw away.' }
  ]
}

interface Ports {
  appHandle(channel: string, handler: (event: IpcMainInvokeEvent, seen?: unknown) => unknown): void
  broadcast(channel: string, value: unknown): void
  tellMain(channel: string, value: unknown): void
  enabled(): boolean
  alpha?(): boolean
  restart?: Pick<InstallerDeps, 'blockers' | 'closeWindows' | 'openWindows' | 'commitAbandoned' | 'drainWriteQueues' | 'writeQueuesBusy'>
  hadConfiguration: boolean
}

function testFeed(): URL | null {
  try {
    const fixture = updateFixtureRoot()
    const hiddenSource = !app.isPackaged && process.env.SLIDEWELL_E2E_HIDDEN === '1' && process.env.SLIDEWELL_DATA_DIR
    if (!fixture && !hiddenSource) return null
    const url = new URL(fixture ? readFixtureFeed(fixture) : process.env.SLIDEWELL_E2E_UPDATES_FEED ?? '')
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/updates.json' &&
        !url.username && !url.password && !url.search && !url.hash) return url
  } catch { /* no local stand-in */ }
  return null
}

async function fetchTestFeed(url: URL): Promise<FeedAnswer> {
  const { headers, timeoutMs, maxBytes } = feedRequest(UPDATE_IDENTITY)
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok || !response.body) return { ok: false, reason: 'unreadable' }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
      size += chunk.value.length
      if (size > maxBytes) {
        await reader.cancel()
        return { ok: false, reason: 'too-large' }
      }
      chunks.push(chunk.value)
    }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

export function hadUpdateConfiguration(dir: string): boolean {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'settings.json'))
}

export function installUpdateNotices(ports: Ports) {
  const running = app.getVersion()
  const feedUrl = UPDATE_IDENTITY.feedUrl
  const localFeed = testFeed()
  const fixture = isUpdateFixture && localFeed !== null
  const assetPrefix = fixture ? new URL('/releases/download/', localFeed).href : RELEASE_ASSET_PREFIX
  const source = copySource({
    packaged: (app.isPackaged && !isUpdateFixture) || localFeed !== null,
    store: process.mas === true,
    running
  })
  const fetchReleaseFeed = createElectronFeedFetcher(UPDATE_IDENTITY, { net, session })
  const dataDir = app.getPath('userData')
  const statePath = join(dataDir, 'update-notices.json')
  const alphaOn = () => ports.alpha?.() === true
  let state = readUpdateState(undefined, feedUrl)
  let channels: ReturnType<typeof validateChannelFeedObject> = null
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    state = readUpdateState(raw, feedUrl)
    channels = validateChannelFeedObject({ schema: 1, latest: raw.latest, channels: raw.channels }, feedUrl, assetPrefix)
  } catch { /* State can be rebuilt. */ }

  let enabled = ports.enabled()
  let alpha = alphaOn()
  let installer: UpdateInstaller | undefined
  let lastOffer: string | undefined
  const offer = () => newerOffer(channels ?? undefined, alphaOn(), running)
  const fileFor = () => updateFileFor(offer(), process.platform, process.arch)
  const facts = new Map<string, ReturnType<typeof inPlaceRefusal>>()
  const refusal = (file: ReturnType<typeof fileFor>) => {
    if (!app.isPackaged) return 'development'
    if (source === 'store') return 'store'
    if (!file) return 'no-file'
    if (!facts.has(file.url)) facts.set(file.url, inPlaceRefusal(readInPlaceFacts(file, source)))
    return facts.get(file.url) ?? null
  }
  const withInstall = (notice: NoticeSnapshot): UpdateSnapshot => {
    const file = state.lastResult === 'unreadable' ? null : fileFor()
    const install = installer?.state() ?? IDLE
    return { ...notice, alpha: alphaOn(), install, file, refusal: refusal(file), blockers: install.phase === 'waiting' ? ports.restart?.blockers() ?? [] : [] }
  }
  const publish = (notice: NoticeSnapshot): void => {
    const version = offer()?.version
    const changed = version !== lastOffer
    lastOffer = version
    if (changed) installer?.reset()
    ports.broadcast('updates:changed', withInstall(notice))
  }

  const checker = createUpdateChecker({
    identity: UPDATE_IDENTITY,
    running,
    source,
    platform: process.platform,
    arch: process.arch,
    fetchFeed: async () => {
      if (!ports.enabled()) return { ok: false, reason: 'unreachable' }
      const answer = await (localFeed ? fetchTestFeed(localFeed) : fetchReleaseFeed())
      if (!answer.ok) return answer
      const parsed = parseChannelFeed(answer.text, feedUrl, assetPrefix)
      if (!parsed.ok) return { ok: false, reason: 'unreadable' }
      // The shared checker still validates and schedules the schema-1 release. Project the opted-in
      // entry from the full validated feed on every read, including immediately after a channel change.
      channels = parsed.feed
      return answer
    },
    readState: () => {
      const latest = channels ? channelOffer(channels, alphaOn()) : undefined
      const lastResult = state.lastResult === 'newer' || state.lastResult === 'current'
        ? (latest && compareVersions(latest.version, running) > 0 ? 'newer' : 'current')
        : state.lastResult
      return { ...state, latest, lastResult }
    },
    writeState(next) {
      state = { ...next, latest: channels?.release }
      const temp = `${statePath}.${randomUUID()}.tmp`
      try {
        writeFileSync(temp, JSON.stringify({ ...state, channels: channels ?? undefined }), { flag: 'wx', mode: 0o600 })
        renameSync(temp, statePath)
      } catch {
        console.warn('[updates] Could not save update notice state.')
      }
    },
    enabled: ports.enabled,
    isBusy: () => installer?.state().phase === 'restarting',
    hasNotes: (version) => Boolean(shippedNotes[version]?.length),
    hadConfiguration: () => ports.hadConfiguration,
    now: Date.now,
    changed: publish
  })

  const snap = () => withInstall(checker.snapshot())
  const tell = () => publish(checker.snapshot())
  const check = async () => ports.enabled() && installer?.state().phase !== 'restarting'
    ? withInstall(await checker.checkNow()) : snap()
  const open = createUpdateLinkOpener({
    async openExternal(url) {
      if (url !== UPDATE_IDENTITY.storeUrl && !onSlideWellSite(url)) throw new Error('Off-site update link')
      if (localFeed) console.log('[updates] Test browser link:', url)
      else await shell.openExternal(url)
    }
  }, UPDATE_IDENTITY, () => checker.snapshot().state.latest, process.platform)

  const install = ports.appHandle
  const notes = () => ({ version: running, items: shippedNotes[running] ?? [] })
  install('updates:get', snap)
  install('updates:check', check)
  install('updates:not-now', () => withInstall(checker.notNow()))
  install('updates:skip', () => {
    const offered = checker.snapshot().mark
    return offered ? withInstall(checker.skip(offered.version)) : snap()
  })
  install('updates:stop-skipping', () => withInstall(checker.stopSkipping()))
  install('updates:download', () => open('download'))
  install('updates:release-notes', () => open('notes', checker.snapshot().state.latest?.version))
  install('updates:store', () => source === 'store' && open('store'))
  install('updates:whats-new', () => { checker.dismissWhatsNew(); return notes() })
  install('updates:update', (_event, seen) => {
    const entry = offer()
    const file = fileFor()
    if (!app.isPackaged || !ports.restart || !file || !ports.enabled() || state.lastResult === 'unreadable' ||
        !isOfferSeen(seen, entry) || inPlaceRefusal(readInPlaceFacts(file, source))) {
      tell()
      return snap()
    }
    installer ??= createUpdateInstaller({
      ...ports.restart,
      source,
      cacheDirName: 'slidewell-updater',
      cacheBase: join(dataDir, 'updater-cache'),
      configDir: join(dataDir, 'updater'),
      fixtureOrigin: fixture ? localFeed.origin : null,
      offerEligible: (candidate) => {
        const selected = fileFor()
        return ports.enabled() && state.lastResult !== 'unreadable' && candidate.version === offer()?.version &&
          selected?.url === candidate.url && selected.sha512 === candidate.sha512 &&
          selected.size === candidate.size && selected.bundleId === candidate.bundleId
      },
      changed: tell,
      log: (message) => console.log(`[updates] ${message}`)
    })
    void installer.start(entry, file)
    return snap()
  })
  install('updates:cancel', () => { installer?.cancel(); return snap() })
  install('updates:restart', () => { installer?.restart(); return snap() })

  if (source !== 'development') checker.start()
  return {
    stop: checker.stop,
    beforeQuit: () => installer?.beforeQuit(),
    settingChanged() {
      const next = ports.enabled()
      const nextAlpha = alphaOn()
      if (next !== enabled || nextAlpha !== alpha) {
        const previousVersion = channels && channelOffer(channels, alpha).version
        const nextVersion = channels && channelOffer(channels, nextAlpha).version
        if (!next || previousVersion !== nextVersion) installer?.cancel()
        enabled = next
        alpha = nextAlpha
        checker.settingChanged()
      }
    },
    runCommand(id: string): void {
      if (id === CHECK_UPDATES) {
        void check().then((snapshot) => ports.tellMain('updates:answer', snapshot))
      } else if (id === WHATS_NEW) {
        checker.dismissWhatsNew()
        ports.tellMain('updates:show-notes', notes())
      }
    }
  }
}

function onSlideWellSite(link: string): boolean {
  const url = new URL(link)
  return url.origin === new URL(UPDATE_IDENTITY.feedUrl).origin && url.pathname.startsWith('/slidewell/')
}

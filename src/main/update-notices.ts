import { app, net, session, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  copySource, createUpdateChecker, feedRequest, readUpdateState,
  validateFeed, type FeedAnswer, type UpdateSnapshot, type WhatsNewItem
} from '@app-patterns/updates'
import { createElectronFeedFetcher, createUpdateLinkOpener } from '@app-patterns/updates/electron'
import { CHECK_UPDATES, UPDATE_IDENTITY, WHATS_NEW } from '../shared/update-identity'

const shippedNotes: Record<string, readonly WhatsNewItem[]> = {
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
  appHandle(channel: string, handler: (event: IpcMainInvokeEvent) => unknown): void
  broadcast(channel: string, value: unknown): void
  tellMain(channel: string, value: unknown): void
  enabled(): boolean
  hadConfiguration: boolean
}

function testFeed(): URL | null {
  // Only the hidden, unpackaged test app with an explicit temporary profile can use a loopback feed.
  if (app.isPackaged || process.env.SLIDEWELL_E2E_HIDDEN !== '1' || !process.env.SLIDEWELL_DATA_DIR) return null
  try {
    const url = new URL(process.env.SLIDEWELL_E2E_UPDATES_FEED ?? '')
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/updates.json' &&
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
  const source = copySource({ packaged: app.isPackaged || localFeed !== null, store: process.mas === true, running })
  const fetchReleaseFeed = createElectronFeedFetcher(UPDATE_IDENTITY, { net, session })
  const statePath = join(app.getPath('userData'), 'update-notices.json')
  let state = readUpdateState(undefined, feedUrl)
  try {
    state = readUpdateState(JSON.parse(readFileSync(statePath, 'utf8')), feedUrl)
    if (state.latest && !hasSlideWellLinks(state.latest)) state.latest = undefined
  } catch { /* state can be rebuilt */ }
  let enabled = ports.enabled()
  const checker = createUpdateChecker({
    identity: UPDATE_IDENTITY,
    running,
    source,
    platform: process.platform,
    arch: process.arch,
    fetchFeed: async () => {
      const answer = await (localFeed ? fetchTestFeed(localFeed) : fetchReleaseFeed())
      if (!answer.ok) return answer
      const validated = validateFeed(answer.text, feedUrl)
      if (!validated.ok) return answer
      return hasSlideWellLinks(validated.latest)
        ? answer : { ok: false, reason: 'unreadable' }
    },
    readState: () => state,
    writeState(next) {
      state = next
      const temp = `${statePath}.${randomUUID()}.tmp`
      try {
        writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
        renameSync(temp, statePath)
      } catch {
        console.warn('[updates] Could not save update notice state.')
      }
    },
    enabled: ports.enabled,
    isBusy: () => false,
    hasNotes: (version) => Boolean(shippedNotes[version]?.length),
    hadConfiguration: () => ports.hadConfiguration,
    now: Date.now,
    changed: (snapshot) => ports.broadcast('updates:changed', snapshot)
  })

  const open = createUpdateLinkOpener({
    async openExternal(url) {
      if (url !== UPDATE_IDENTITY.storeUrl && !onSlideWellSite(url)) throw new Error('Off-site update link')
      if (localFeed) console.log('[updates] Test browser link:', url)
      else await shell.openExternal(url)
    }
  }, UPDATE_IDENTITY, () => checker.snapshot().state.latest, process.platform)
  const install = ports.appHandle
  const notes = () => ({ version: running, items: shippedNotes[running] ?? [] })
  install('updates:get', () => checker.snapshot())
  install('updates:check', () => checker.checkNow())
  install('updates:not-now', () => checker.notNow())
  install('updates:skip', () => {
    const offered = checker.snapshot().mark
    return offered ? checker.skip(offered.version) : checker.snapshot()
  })
  install('updates:stop-skipping', () => checker.stopSkipping())
  install('updates:download', () => open('download'))
  install('updates:release-notes', () => open('notes', checker.snapshot().state.latest?.version))
  install('updates:store', () => source === 'store' && open('store'))
  install('updates:whats-new', () => { checker.dismissWhatsNew(); return notes() })

  if (source !== 'development') checker.start()
  return {
    stop: checker.stop,
    settingChanged() {
      const next = ports.enabled()
      if (next !== enabled) {
        enabled = next
        checker.settingChanged()
      }
    },
    runCommand(id: string): void {
      if (id === CHECK_UPDATES) {
        void checker.checkNow().then((snapshot: UpdateSnapshot) => ports.tellMain('updates:answer', snapshot))
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

function hasSlideWellLinks({ notes, download }: { notes: string; download: { mac: string; windows: string } }): boolean {
  return [notes, download.mac, download.windows].every(onSlideWellSite)
}

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { compareVersions, type UpdateSnapshot } from '@app-patterns/updates'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installUpdateNotices } from '../src/main/update-notices'
import { UPDATE_IDENTITY } from '../src/shared/update-identity'

const electron = vi.hoisted(() => ({
  app: { getVersion: vi.fn(), getPath: vi.fn(), isPackaged: true },
  net: { request: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) }
}))
vi.mock('electron', () => electron)

const site = 'https://techczech.github.io/slidewell/'
const feed = (version = '0.4.0', download = site) => JSON.stringify({
  schema: 1,
  latest: {
    version, released: '2026-11-21', summary: ['Search results open faster.'],
    notes: site + 'whats-new.html', download: { mac: download, windows: download }
  }
})
const scratch: string[] = []
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  electron.app.isPackaged = true
  vi.clearAllMocks()
  vi.useRealTimers()
})

function setup({ version = '0.4.0-alpha.19', enabled = true, hadConfiguration = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-updates-'))
  scratch.push(dir)
  electron.app.getVersion.mockReturnValue(version)
  electron.app.getPath.mockReturnValue(dir)
  const headers: Record<string, string> = {}
  electron.session.fromPartition.mockReturnValue({ isolated: true })
  let reply: string | null = feed()
  electron.net.request.mockImplementation(() => {
    const request = Object.assign(new EventEmitter(), {
      setHeader(name: string, value: string) { headers[name] = value },
      abort: vi.fn(),
      end() {
        queueMicrotask(() => {
          if (reply === null) request.emit('error', new Error('Offline'))
          else {
            const response = Object.assign(new EventEmitter(), { statusCode: 200 })
            request.emit('response', response)
            response.emit('data', Buffer.from(reply))
            response.emit('end')
          }
        })
      }
    })
    return request
  })
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
  const tellMain = vi.fn()
  const notices = installUpdateNotices({
    appHandle: (id, handler) => void handlers.set(id, handler),
    broadcast: vi.fn(),
    tellMain,
    enabled: () => enabled,
    hadConfiguration
  })
  stops.push(notices.stop)
  const invoke = <T = UpdateSnapshot>(id: string) => handlers.get('updates:' + id)!({} as IpcMainInvokeEvent) as T
  return { invoke, headers, tellMain, notices, replyWith: (body: string | null) => { reply = body } }
}

describe('SlideWell update notices', () => {
  it('compares releases and prereleases in semantic version order', () => {
    expect(compareVersions('0.4.1', '0.4.0')).toBeGreaterThan(0)
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareVersions('0.3.9', '0.4.0')).toBeLessThan(0)
    expect(compareVersions('0.4.0-alpha.19', '0.4.0')).toBeLessThan(0)
  })

  it('uses a bare GET and opens the validated download page only on request', async () => {
    const { invoke, headers } = setup()
    const result = await invoke<Promise<UpdateSnapshot>>('check')
    expect(result.mark?.version).toBe('0.4.0')
    expect(electron.net.request).toHaveBeenCalledWith({
      url: UPDATE_IDENTITY.feedUrl, method: 'GET', credentials: 'omit', redirect: 'error', session: { isolated: true }
    })
    expect(headers).toEqual({ 'User-Agent': 'SlideWell', Accept: 'application/json' })
    expect(electron.session.fromPartition).toHaveBeenCalledWith(expect.not.stringMatching(/^persist:/), { cache: false })
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
    expect(await invoke<Promise<boolean>>('download')).toBe(true)
    expect(electron.shell.openExternal).toHaveBeenCalledWith(site)
  })

  it('suppresses skipped and snoozed versions but marks the next release', async () => {
    const { invoke, replyWith } = setup()
    const check = () => invoke<Promise<UpdateSnapshot>>('check')
    await check()
    expect(invoke('not-now').mark).toBeNull()
    expect((await check()).mark?.version).toBe('0.4.0')
    expect(invoke('skip').mark).toBeNull()
    expect((await check()).mark).toBeNull()
    replyWith(feed('0.4.1'))
    expect((await check()).mark?.version).toBe('0.4.1')
  })

  it('leaves the status bar quiet when offline or when a feed links elsewhere', async () => {
    const { invoke, replyWith } = setup()
    replyWith(null)
    const offline = await invoke<Promise<UpdateSnapshot>>('check')
    expect(offline.state.lastResult).toBe('unreachable')
    expect(offline.mark).toBeNull()
    replyWith(feed('0.4.1', 'https://techczech.github.io/another-project/'))
    const offSite = await invoke<Promise<UpdateSnapshot>>('check')
    expect(offSite.state.lastResult).toBe('unreadable')
    expect(offSite.mark).toBeNull()
    expect(await invoke<Promise<boolean>>('download')).toBe(false)
  })

  it('waits before the first automatic check, then waits a day', async () => {
    vi.useFakeTimers()
    setup()
    await vi.advanceTimersByTimeAsync(119_000)
    expect(electron.net.request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(electron.net.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(86_399_000)
    expect(electron.net.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(electron.net.request).toHaveBeenCalledTimes(2)
  })

  it('checks by hand with the daily setting off, and keeps a development run offline', async () => {
    vi.useFakeTimers()
    const { invoke } = setup({ enabled: false })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(electron.net.request).not.toHaveBeenCalled()
    expect((await invoke<Promise<UpdateSnapshot>>('check')).state.lastResult).toBe('newer')
    electron.net.request.mockClear()
    electron.app.isPackaged = false
    const dev = setup()
    expect((await dev.invoke<Promise<UpdateSnapshot>>('check')).source).toBe('development')
    expect(electron.net.request).not.toHaveBeenCalled()
  })

  it('shows shipped notes after an upgrade and clears the mark when opened', () => {
    const upgrade = setup({ hadConfiguration: true })
    expect(upgrade.invoke('get').whatsNew?.version).toBe('0.4.0-alpha.19')
    expect(upgrade.invoke<UpdateNotes>('whats-new').items.length).toBeGreaterThan(0)
    expect(upgrade.invoke('get').whatsNew).toBeNull()
    expect(setup().invoke('get').whatsNew).toBeNull()
  })
})

type UpdateNotes = { items: unknown[] }

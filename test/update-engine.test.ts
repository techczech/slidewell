import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUpdateEngine, type EnginePorts, type Offer } from '../src/main/update-engine'
import { createRestartWork } from '../src/main/restart-work'
import { updateRequestAllowed } from '../src/main/update-download-filter'

const offer: Offer = {
  version: '1.1.0', released: '2026-11-22', url: 'https://github.com/techczech/slidewell/fixture.zip',
  sha512: '', size: 10, bundleId: 'net.dominiklukes.slidewell'
}

function setup(overrides: Partial<EnginePorts> = {}) {
  const native = new EventEmitter()
  const quit = vi.fn()
  const handOver = vi.fn(async () => undefined)
  const asked = vi.fn(() => { native.emit('update-downloaded') })
  const downloader = { check: vi.fn(async () => true), retrieve: vi.fn(async () => '/tmp/only-a-test-path') }
  const releaseFiles = vi.fn()
  const engine = createUpdateEngine({
    platform: 'darwin', gate: () => null, blockers: () => [],
    downloader: () => downloader, verify: async () => null, handOver,
    native: () => Object.assign(native, { checkForUpdates: asked, quitAndInstall: quit }),
    closeWindows: async () => true, openWindows: () => 0,
    drainWriteQueues: async () => true, writeQueuesBusy: () => [],
    withdrawNative: async () => ({ found: false, gone: true, after: 'absent' }),
    releaseFiles, changed: () => {}, log: () => {}, ...overrides
  })
  return { engine, quit, asked, handOver, downloader, releaseFiles, native }
}

describe('explicit update and restart', () => {
  it('does no work before Update, then reaches native install after windows and writes finish', async () => {
    const order: string[] = []
    const t = setup({
      closeWindows: async () => { order.push('close'); return true },
      drainWriteQueues: async () => { order.push('flush'); return true },
      handOver: async () => { order.push('hand-over') }
    })
    expect(t.downloader.retrieve).not.toHaveBeenCalled()
    expect(t.asked).not.toHaveBeenCalled()
    await t.engine.start(offer)
    await vi.waitFor(() => expect(t.quit).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['close', 'flush', 'hand-over'])
  })

  it('holds a verified download behind active work until an explicit restart', async () => {
    let working = true
    const t = setup({ blockers: () => working ? ['work'] : [] })
    await t.engine.start(offer)
    expect(t.engine.state().phase).toBe('waiting')
    t.engine.restart()
    expect(t.handOver).not.toHaveBeenCalled()
    working = false
    expect(t.asked).not.toHaveBeenCalled()
    t.engine.restart()
    await vi.waitFor(() => expect(t.quit).toHaveBeenCalledTimes(1))
  })

  it('never hands a cancelled download to macOS, including a late completion', async () => {
    let finish!: (path: string) => void
    const retrieve = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const t = setup({ downloader: () => ({ check: async () => true, retrieve }) })
    const attempt = t.engine.start(offer)
    await vi.waitFor(() => expect(retrieve).toHaveBeenCalledTimes(1))
    t.engine.cancel()
    finish('/tmp/only-a-test-path')
    await attempt
    expect(t.engine.state().phase).toBe('idle')
    expect(t.handOver).not.toHaveBeenCalled()
    expect(t.releaseFiles).toHaveBeenCalledTimes(1)
  })

  it.each(['mismatch', 'wrong-version', 'signature'] as const)('refuses a %s failure before native hand-over', async (reason) => {
    const t = setup({ verify: async () => reason })
    await t.engine.start(offer)
    expect(t.engine.state()).toMatchObject({ phase: 'failed', reason })
    expect(t.handOver).not.toHaveBeenCalled()
  })

  it('never arms ShipIt if a close or settings write fails', async () => {
    for (const failed of [{ closeWindows: async () => false }, { drainWriteQueues: async () => false }]) {
      const recovered = vi.fn()
      const t = setup({ ...failed, commitAbandoned: recovered })
      await t.engine.start(offer)
      await vi.waitFor(() => expect(recovered).toHaveBeenCalled())
      expect(t.engine.state()).toMatchObject({ phase: 'failed', reason: 'save' })
      expect(t.handOver).not.toHaveBeenCalled()
    }
  })

  it('tracks unfinished work and locks its entry points once the restart begins', async () => {
    const work = createRestartWork()
    let finish!: () => void
    const job = work.run(() => new Promise<void>((resolve) => { finish = resolve }))
    expect(work.freeze()).toBe(false)
    finish()
    await job
    expect(work.freeze()).toBe(true)
    expect(() => work.run(() => 'never starts')).toThrow('restarting')
    work.release()
    expect(work.run(() => 'finished')).toBe('finished')
  })

  it('limits downloads and redirects to the GitHub release and asset hosts', () => {
    expect(updateRequestAllowed(offer.url)).toBe(true)
    expect(updateRequestAllowed('https://release-assets.githubusercontent.com/file?short-lived=1')).toBe(true)
    for (const url of ['http://github.com/file', 'https://127.0.0.1/file', 'https://github.com.evil.test/file', 'https://github.com:8443/file']) {
      expect(updateRequestAllowed(url)).toBe(false)
    }
  })
})

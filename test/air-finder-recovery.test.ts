import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createCatalogue } from '../src/main/air-finder/catalogue-client'
import { startFinderAtLaunch } from '../src/main/air-finder/host'

const workers = vi.hoisted(() => ({ started: [] as TestWorker[] }))

class TestWorker extends EventEmitter {
  postMessage = vi.fn()
  terminate = vi.fn(async () => { this.emit('exit', 1); return 1 })
}

vi.mock('node:worker_threads', async importOriginal => ({
  ...await importOriginal<typeof import('node:worker_threads')>(),
  Worker: class {
    constructor() {
      const worker = new TestWorker()
      workers.started.push(worker)
      return worker
    }
  }
}))

afterEach(() => {
  vi.useRealTimers()
  workers.started.length = 0
})

test('rejects pending reads on worker death, then uses the replacement without replaying requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const catalogue = await createCatalogue({
    libraryId: 'synthetic', archiveRoot: root, wellRoot: root, presentations: ['fixture'], wellImages: []
  })
  try {
    const [first] = workers.started
    const pending = expect(catalogue.words('before exit')).rejects.toThrow('unavailable')
    first.emit('error', new Error('synthetic failure'))
    first.emit('exit', 1)
    await pending
    await expect(catalogue.words('during back-off')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(249)
    expect(workers.started).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers.started).toHaveLength(2)
    const second = workers.started[1]
    expect(second.postMessage).not.toHaveBeenCalled()
    const recovering = catalogue.generation()
    const [{ id }] = second.postMessage.mock.calls[0]
    first.emit('message', { id, value: 'stale' })
    second.emit('message', { id, value: 'current' })
    await expect(recovering).resolves.toBe('current')
  } finally {
    await catalogue.close()
  }
  await vi.advanceTimersByTimeAsync(60_000)
  expect(workers.started).toHaveLength(2)
})

test('the launch warning is delivered once when repeated exits exhaust back-off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fr-'))
  const config = join(root, 'finder.json')
  await writeFile(config, JSON.stringify({
    libraryId: 'synthetic', socketPath: join(root, 'finder.sock'), browserPort: 8870,
    presentations: ['fixture'], wellImages: []
  }), { mode: 0o600 })
  const warn = vi.fn()
  const roots = { archiveRoot: () => root, wellRoot: () => root }
  const server = await startFinderAtLaunch(['--air-finder-config=' + config], roots, {
    ready: () => false, query: async () => []
  }, warn)
  if (!server) throw new Error('Synthetic finder failed to start: ' + warn.mock.calls.flat().join(' '))
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (const delay of [250, 1_000, 4_000]) {
      const count = workers.started.length
      workers.started.at(-1)!.emit('exit', 1)
      expect(warn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(delay)
      expect(workers.started).toHaveLength(count + 1)
    }
    workers.started.at(-1)!.emit('exit', 1)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('stopped repeatedly'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(workers.started).toHaveLength(4)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

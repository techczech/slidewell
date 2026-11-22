import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSourceWatcher, type WatchedSource } from '../src/main/source-watcher'
import { isVaultChangeRelevant } from '../src/main/talk-usage'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watch: vi.fn()
}))

describe('createSourceWatcher', () => {
  const source = __dirname
  let watcher: ReturnType<typeof createSourceWatcher>

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    watcher.close()
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  // Drive the native event boundary directly. FSEvents can coalesce, delay or omit
  // events in the test runner. The hidden Electron spec exercises real capture watching.
  function start(accept: WatchedSource['accept'], debounceMs: number, maxWaitMs?: number) {
    const changes = vi.fn()
    const native = Object.assign(new EventEmitter(), {
      close() { native.removeAllListeners() },
      ref() { return native },
      unref() { return native }
    })
    vi.mocked(watch).mockImplementation((_path, _options, listener) => {
      native.on('change', listener!)
      return native
    })
    watcher = createSourceWatcher(changes, debounceMs, maxWaitMs)
    watcher.setSources([{ path: source, recursive: true, accept }])
    expect(watch).toHaveBeenCalledWith(source, { recursive: true, persistent: false }, expect.any(Function))
    return { changes, emit: (event: string, name: string) => native.emit('change', event, name) }
  }

  it('ignores events the accept filter rejects', () => {
    const { changes, emit } = start((rel) => rel.endsWith('-outline.md'), 150)
    emit('rename', 'cache/busy.json')
    emit('change', 'notes.md')
    vi.runAllTimers()
    expect(changes).not.toHaveBeenCalled()

    emit('rename', 'a-outline.md')
    vi.runAllTimers()
    expect(changes).toHaveBeenCalledExactlyOnceWith(source)
  })

  it('fires within maxWait even when events never stop', () => {
    const { changes, emit } = start((rel) => rel.endsWith('-outline.md'), 400, 900)
    for (let elapsed = 0; elapsed <= 800; elapsed += 100) {
      emit('change', 'b-outline.md')
      vi.advanceTimersByTime(100)
      if (elapsed < 800) expect(changes).not.toHaveBeenCalled()
    }
    expect(changes).toHaveBeenCalledExactlyOnceWith(source)
  })

  it('with the vault filter: a pool image added or removed triggers, a pool subfolder does not', () => {
    const { changes, emit } = start(isVaultChangeRelevant, 150, 2000)
    emit('rename', '_assets/sub/img-1234567.webp')
    emit('rename', '_assets/notes.txt')
    vi.runAllTimers()
    expect(changes).not.toHaveBeenCalled()

    emit('rename', '_assets/img-aaaaaaa.webp') // add
    vi.runAllTimers()
    expect(changes).toHaveBeenCalledExactlyOnceWith(source)

    emit('rename', '_assets/img-aaaaaaa.webp') // remove
    vi.runAllTimers()
    expect(changes.mock.calls).toEqual([[source], [source]])
  })

  it('with the vault filter: re-pointing a symlinked pool triggers', () => {
    const { changes, emit } = start(isVaultChangeRelevant, 150, 2000)
    emit('rename', '_assets') // replacing the symlink changes the vault entry itself
    vi.runAllTimers()
    expect(changes).toHaveBeenCalledExactlyOnceWith(source)
  })
})

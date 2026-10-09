import { describe, it, expect } from 'vitest'
import { WebGpuEmbedder, checkReply, type EmbedHost, type HostEvents, type HostFactory } from '../src/main/picture-search/webgpu-embedder'

const inputs = {
  queryIds: () => Int32Array.from([2, 5, 1]),
  image: async () => ({ pv: new Float32Array(4), dims: [1, 1, 4], pos: new BigInt64Array(2), posDims: [1, 1, 2], ids: Int32Array.from([2, 1]) })
}
const within = <T>(p: Promise<T>, ms = 1000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('still pending')), ms))])

/** A fake hidden window: `script` decides what it does on open and on each command. */
function fakeHost(script: { onOpen?: (ev: HostEvents) => void; onCmd?: (ev: HostEvents, id: number, name: string) => void }): { factory: HostFactory; destroyed: () => number } {
  let destroyed = 0
  const factory: HostFactory = (ev) => {
    setTimeout(() => script.onOpen?.(ev), 0)
    const host: EmbedHost = {
      send: (id, name) => setTimeout(() => script.onCmd?.(ev, id, name), 0),
      destroy: () => destroyed++
    }
    return host
  }
  return { factory, destroyed: () => destroyed }
}

describe('WebGpuEmbedder with a fake window', () => {
  it('a window that dies before it is ready rejects the waiting call (no hang)', async () => {
    const h = fakeHost({ onOpen: (ev) => ev.onGone('stopped (crashed)') })
    const e = new WebGpuEmbedder('/Volumes/Data/model', h.factory, { inputs })
    await expect(within(e.embedText('robots'))).rejects.toThrow(/crashed/)
    await expect(within(e.embedImage('/Volumes/Data/a.webp'))).rejects.toThrow(/crashed/)
  })

  it('a window that dies mid-call rejects that call, and the next call opens a fresh window', async () => {
    let opens = 0
    let crash = true
    const factory: HostFactory = (ev) => {
      opens++
      setTimeout(() => ev.onReady({ ok: true }), 0)
      return {
        send: (id, name) =>
          setTimeout(() => {
            if (name === 'info') return ev.onReply(id, { ok: true, value: { webgpu: true } })
            if (name === 'load') return ev.onReply(id, { ok: true, value: {} })
            if (crash) return ev.onGone('stopped (oom)')
            ev.onReply(id, { ok: true, value: Float32Array.from([1, 0]) })
          }, 0),
        destroy: () => undefined
      }
    }
    const e = new WebGpuEmbedder('/Volumes/Data/model', factory, { inputs, dim: 2 })
    await expect(within(e.embedText('robots'))).rejects.toThrow(/oom/)
    crash = false
    expect(Array.from(await within(e.embedText('robots')))).toEqual([1, 0])
    expect(opens).toBe(2)
    e.dispose()
  })

  it('destroys the window exactly once on a load failure and on a crash, and retries do not pile up windows', async () => {
    for (const reason of ['could not load (ERR_FAILED)', 'stopped (crashed)']) {
      const h = fakeHost({ onOpen: (ev) => ev.onGone(reason) })
      const e = new WebGpuEmbedder('/Volumes/Data/model', h.factory, { inputs, dim: 2 })
      await expect(within(e.embedText('a'))).rejects.toThrow()
      await expect(within(e.embedText('b'))).rejects.toThrow() // a retry opens (and loses) a second window
      await new Promise((r) => setTimeout(r, 10))
      expect(h.destroyed()).toBe(2) // one destroy per window opened
      e.dispose()
      expect(h.destroyed()).toBe(2) // nothing left to destroy
    }
  })

  it('malformed messages from the page reject the matching call and never throw', async () => {
    const replies: unknown[] = [null, { ok: true, value: Float32Array.from([1, 2, 3]) }, { ok: true, value: [1, 0] }, { ok: false, error: 42 }, 'junk']
    let k = 0
    let gotEvents: HostEvents | null = null
    const factory: HostFactory = (ev) => {
      gotEvents = ev
      setTimeout(() => ev.onReady({ ok: true }), 0)
      return {
        send: (id, name) =>
          setTimeout(() => {
            if (name === 'info') return ev.onReply(id, { ok: true, value: { webgpu: true } })
            if (name === 'load') return ev.onReply(id, { ok: true, value: {} })
            ev.onReply('not-an-id', { ok: true }) // no matching id: dropped
            ev.onReply(9999, null) // unknown id: dropped
            ev.onReply(id, replies[k++])
          }, 0),
        destroy: () => undefined
      }
    }
    const e = new WebGpuEmbedder('/Volumes/Data/model', factory, { inputs, dim: 2 })
    await expect(within(e.embedText('x'))).rejects.toThrow(/malformed/)
    await expect(within(e.embedText('x'))).rejects.toThrow(/unexpected reply/) // wrong dimension
    await expect(within(e.embedText('x'))).rejects.toThrow(/unexpected reply/) // not a Float32Array
    await expect(within(e.embedText('x'))).rejects.toThrow(/reported an error/) // error is not a string
    await expect(within(e.embedText('x'))).rejects.toThrow(/malformed/)
    expect(() => gotEvents!.onReply(undefined, undefined)).not.toThrow()
    e.dispose()
  })

  it('ready(null) fails start-up instead of throwing; a page that never answers times out', async () => {
    const bad = fakeHost({ onOpen: (ev) => ev.onReady(null) })
    const e1 = new WebGpuEmbedder('/Volumes/Data/model', bad.factory, { inputs, dim: 2 })
    await expect(within(e1.embedText('x'))).rejects.toThrow(/failed to start/)
    expect(bad.destroyed()).toBe(1)

    const silent = fakeHost({ onOpen: () => undefined }) // never sends ready
    const e2 = new WebGpuEmbedder('/Volumes/Data/model', silent.factory, { inputs, dim: 2, timeouts: { startMs: 50 } })
    await expect(within(e2.embedText('x'))).rejects.toThrow(/did not start/)
    expect(silent.destroyed()).toBe(1)

    const hung = fakeHost({
      onOpen: (ev) => ev.onReady({ ok: true }),
      onCmd: (ev, id, name) => {
        if (name === 'info') ev.onReply(id, { ok: true, value: { webgpu: true } })
        else if (name === 'load') ev.onReply(id, { ok: true, value: {} })
        // 'text' never answered (e.g. the page navigated away without telling anyone)
      }
    })
    const e3 = new WebGpuEmbedder('/Volumes/Data/model', hung.factory, { inputs, dim: 2, timeouts: { callMs: 50 } })
    await expect(within(e3.embedText('x'))).rejects.toThrow(/did not answer "text"/)
    expect(hung.destroyed()).toBe(1)
  })

  it('checkReply accepts only the agreed shapes', () => {
    const f32 = (v: unknown): boolean => v instanceof Float32Array
    expect(checkReply({ ok: true, value: new Float32Array(2) }, f32).ok).toBe(true)
    expect(checkReply({ ok: false, error: 'GPU lost' }, f32)).toEqual({ ok: false, error: 'GPU lost' })
    expect(checkReply(undefined, f32).ok).toBe(false)
    expect(checkReply({ ok: 'yes' }, f32).ok).toBe(false)
  })
})

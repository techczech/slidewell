import { describe, it, expect } from 'vitest'
import { WebGpuEmbedder, type EmbedHost, type HostEvents, type HostFactory } from '../src/main/picture-search/webgpu-embedder'

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
    const e = new WebGpuEmbedder('/Volumes/Data/model', factory, { inputs })
    await expect(within(e.embedText('robots'))).rejects.toThrow(/oom/)
    crash = false
    expect(Array.from(await within(e.embedText('robots')))).toEqual([1, 0])
    expect(opens).toBe(2)
    e.dispose()
  })
})

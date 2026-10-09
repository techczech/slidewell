import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LunaHttpError, pool, postLuna, redact, type HttpPost, type HttpResponse } from '../src/main/sorter/cloud/client'

const KEY = 'sk-test-FAKEKEY0123456789abcdefWXYZ'
const res = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
})
/** A transport that replays `replies` in order and records each call. */
function replay(replies: Array<HttpResponse | Error>): { http: HttpPost; calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  let i = 0
  return {
    calls,
    http: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body })
      const r = replies[Math.min(i++, replies.length - 1)]
      if (r instanceof Error) throw r
      return r
    }
  }
}
const noSleep = async (): Promise<void> => undefined
const ok = { status: 'completed', output: [] }

describe('postLuna', () => {
  it('posts JSON with the key as a Bearer token to the Responses endpoint', async () => {
    const t = replay([res(200, ok)])
    expect(await postLuna({ a: 1 }, { key: KEY, http: t.http, sleep: noSleep })).toEqual(ok)
    expect(t.calls[0].url).toBe('https://api.openai.com/v1/responses')
    expect(t.calls[0].headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` })
    expect(JSON.parse(t.calls[0].body)).toEqual({ a: 1 })
  })

  it('retries 429 and 5xx with backoff, honouring Retry-After', async () => {
    const waits: number[] = []
    const t = replay([res(429, {}, { 'retry-after': '3' }), res(503, {}), res(200, ok)])
    await postLuna({}, { key: KEY, http: t.http, sleep: async (ms) => void waits.push(ms), random: () => 0.5 })
    expect(t.calls).toHaveLength(3)
    expect(waits).toEqual([3000, 2000])
  })

  it('gives up after maxAttempts with the last error', async () => {
    const t = replay([res(500, {})])
    await expect(postLuna({}, { key: KEY, http: t.http, sleep: noSleep, maxAttempts: 3 })).rejects.toMatchObject({ kind: 'server', status: 500 })
    expect(t.calls).toHaveLength(3)
  })

  it('a rejected key is not retried', async () => {
    const t = replay([res(401, readFileSync(join(__dirname, 'fixtures', 'luna', 'error-401.json'), 'utf8'))])
    const e = await postLuna({}, { key: KEY, http: t.http, sleep: noSleep }).catch((x) => x)
    expect(e).toBeInstanceOf(LunaHttpError)
    expect(e.kind).toBe('auth')
    expect(e.message).not.toMatch(/sk-/)
    expect(t.calls).toHaveLength(1)
  })

  it('a network failure (offline) is retried, then reported as offline', async () => {
    const t = replay([new TypeError('net::ERR_INTERNET_DISCONNECTED')])
    await expect(postLuna({}, { key: KEY, http: t.http, sleep: noSleep, maxAttempts: 2 })).rejects.toMatchObject({ kind: 'offline' })
    expect(t.calls).toHaveLength(2)
  })

  it('times out a request that never answers', async () => {
    const hang: HttpPost = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    await expect(postLuna({}, { key: KEY, http: hang, sleep: noSleep, maxAttempts: 1, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('a 400 error message is shortened and has any key removed', async () => {
    const t = replay([res(400, { error: { message: `Bad image for key ${KEY} (sk-proj-abc****wxyz)` } })])
    const e = await postLuna({}, { key: KEY, http: t.http, sleep: noSleep }).catch((x) => x)
    expect(e.kind).toBe('bad-request')
    expect(e.message).toContain('Bad image')
    expect(e.message).not.toContain(KEY)
    expect(e.message).not.toMatch(/sk-/)
  })
})

describe('redact', () => {
  it('removes the key, masked keys and bearer tokens', () => {
    expect(redact(`a ${KEY} b`, KEY)).toBe('a [key] b')
    expect(redact('Incorrect API key provided: sk-test-****WXYZ.')).toBe('Incorrect API key provided: [key]')
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [key]')
  })
})

describe('pool', () => {
  it('runs at most `limit` at a time and stops starting new ones when told', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      done.push(n)
      running--
    })
    expect(peak).toBe(2)
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6])
    const seen: number[] = []
    await pool([1, 2, 3, 4], 1, async (n) => void seen.push(n), () => seen.length >= 2)
    expect(seen).toEqual([1, 2])
  })
})

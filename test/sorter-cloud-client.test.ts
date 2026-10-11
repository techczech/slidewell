import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipRedacted, LunaHttpError, pool, postCloud, postLuna, redact, type HttpPost, type HttpResponse } from '../src/main/sorter/cloud/client'
import { HAIKU_PROVIDER, LUNA_PROVIDER } from '../src/main/sorter/cloud/provider'

const KEY = 'sk-test-FAKEKEY0123456789abcdefWXYZ'
const res = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
})
/** A transport that replays `replies` in order and records each call. */
function replay(replies: Array<HttpResponse | Error>): { http: HttpPost; calls: Array<{ url: string; headers: Record<string, string>; body: string; redirect: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string; redirect: string }> = []
  let i = 0
  return {
    calls,
    http: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body, redirect: init.redirect })
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

// made-up keys in Anthropic's shape (typed prefix sk-ant-api03-); neither is a real key
const ANT_KEY = 'sk-ant-api03-FAKEKEY0123456789abcdefWXYZ-synthetic'
const antOk = { type: 'message', role: 'assistant', content: [], stop_reason: 'tool_use' }

describe('postCloud to Anthropic (Haiku)', () => {
  it('posts JSON to the Messages endpoint with the key in x-api-key and the version header, never as a Bearer token', async () => {
    const t = replay([res(200, antOk)])
    expect(await postCloud({ a: 1 }, { key: ANT_KEY, http: t.http, wire: HAIKU_PROVIDER, sleep: noSleep })).toEqual(antOk)
    expect(t.calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(t.calls[0].headers).toEqual({ 'Content-Type': 'application/json', 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' })
    expect(JSON.stringify(t.calls[0].headers)).not.toMatch(/Bearer|Authorization/i)
    expect(t.calls[0].body).not.toContain(ANT_KEY)
  })

  it('each provider’s request goes to its own address and asks the transport not to follow redirects', async () => {
    const t = replay([res(200, ok)])
    await postLuna({}, { key: KEY, http: t.http, sleep: noSleep })
    await postCloud({}, { key: KEY, http: t.http, wire: LUNA_PROVIDER, sleep: noSleep })
    await postCloud({}, { key: ANT_KEY, http: t.http, wire: HAIKU_PROVIDER, sleep: noSleep })
    expect(t.calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages'])
    expect(t.calls.map((c) => c.redirect)).toEqual(['error', 'error', 'error'])
    expect(t.calls[2].headers.Authorization).toBeUndefined()
    expect(t.calls[0].headers['x-api-key']).toBeUndefined()
  })

  it('a rejected key is not retried and the message names Anthropic, with no key in it', async () => {
    const t = replay([res(401, readFileSync(join(__dirname, 'fixtures', 'haiku', 'error-401.json'), 'utf8'))])
    const e = await postCloud({}, { key: ANT_KEY, http: t.http, wire: HAIKU_PROVIDER, sleep: noSleep }).catch((x) => x)
    expect(e).toBeInstanceOf(LunaHttpError)
    expect(e).toMatchObject({ kind: 'auth', message: 'Anthropic did not accept the API key' })
    expect(t.calls).toHaveLength(1)
  })

  it('429 and 529 (overloaded) are retried with backoff; the last error names Anthropic', async () => {
    const waits: number[] = []
    const t = replay([res(429, {}, { 'retry-after': '2' }), res(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), res(200, antOk)])
    await postCloud({}, { key: ANT_KEY, http: t.http, wire: HAIKU_PROVIDER, sleep: async (ms) => void waits.push(ms), random: () => 0.5 })
    expect(waits).toEqual([2000, 2000])
    const down = replay([res(529, {})])
    await expect(postCloud({}, { key: ANT_KEY, http: down.http, wire: HAIKU_PROVIDER, sleep: noSleep, maxAttempts: 2 })).rejects.toMatchObject({ kind: 'server', status: 529, message: 'Anthropic had a server error (529)' })
  })

  it('a 400 error message is shortened and has the key removed, whole, masked or as a header', async () => {
    const t = replay([res(400, { type: 'error', error: { type: 'invalid_request_error', message: `Bad image for ${ANT_KEY}, masked sk-ant-api03-FAK...etic, header x-api-key: ${ANT_KEY.slice(0, 14)}` } })])
    const e = await postCloud({}, { key: ANT_KEY, http: t.http, wire: HAIKU_PROVIDER, sleep: noSleep }).catch((x) => x)
    expect(e.kind).toBe('bad-request')
    expect(e.message).toContain('Anthropic refused the request (400): Bad image for [key], masked [key], header x-api-key: [key]')
    expect(e.message).not.toMatch(/sk-ant|FAKEKEY/)
  })
})

describe('redact', () => {
  it('removes the key, masked keys and bearer tokens', () => {
    expect(redact(`a ${KEY} b`, KEY)).toBe('a [key] b')
    expect(redact('Incorrect API key provided: sk-test-****WXYZ.')).toBe('Incorrect API key provided: [key].')
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [key]')
    expect(redact('echosk-proj-SYNTH0123456789abcdef')).toBe('echo[key]') // a key glued to a word
    expect(redact('x', null)).toBe('x')
    // ordinary words ending in "sk-" stay intact; a 20+ character key glued to a word does not
    expect(redact('A risk-free, task-based view; echosk-proj-SYNTHabcdefghij0123456789 end')).toBe('A risk-free, task-based view; echo[key] end')
  })

  it('leaves ordinary words alone: no digit, or no masked run of asterisks', () => {
    const plain = 'A task-based-classification diagram and a risk-free** chart.'
    expect(redact(plain)).toBe(plain)
    expect(redact('Incorrect API key provided: sk-proj-********************abcd')).toBe('Incorrect API key provided: [key]')
    expect(redact('echosk-proj-SYNTH0a1b2c3d4e5f6g7h8i9')).toBe('echo[key]')
  })

  it('removes Anthropic keys: whole, glued to a word, cut short, and masked the ways an API echoes them', () => {
    expect(redact(`a ${ANT_KEY} b`)).toBe('a [key] b') // by shape alone, without being given the key
    expect(redact(`a ${ANT_KEY} b`, ANT_KEY)).toBe('a [key] b')
    expect(redact(`echo${ANT_KEY} end`)).toBe('echo[key] end')
    expect(redact('prefix only: sk-ant-api03-AbC end')).toBe('prefix only: [key] end') // a key cut short
    expect(redact('sk-ant-admin01-SYNTHabc and sk-ant-oat01-SYNTHabc')).toBe('[key] and [key]')
    expect(redact('masked sk-ant-api03-AbC...wxYZ end')).toBe('masked [key] end')
    expect(redact('masked sk-ant-api03-…wxYZ end')).toBe('masked [key] end')
    expect(redact('masked sk-ant-api03-****wxYZ end')).toBe('masked [key] end')
    expect(redact('masked sk-ant-api03-AbC**********************wxYZ end')).toBe('masked [key] end')
    expect(redact('masked sk-ant-...wxYZ end')).toBe('masked [key] end')
    expect(redact('masked sk-ant-…wxYZ end')).toBe('masked [key] end')
    expect(redact('masked sk-ant-****wxYZ end')).toBe('masked [key] end')
    expect(redact('invalid x-api-key: abc123DEF, retry')).toBe('invalid x-api-key: [key], retry')
    expect(redact('{"x-api-key":"abc123DEF"}')).toBe('{"x-api-key":"[key]"}')
    expect(redact('invalid x-api-key')).toBe('invalid x-api-key') // Anthropic's own 401 wording has no key in it
  })

  it('removes keys of both providers from one text, given either, both or neither', () => {
    const text = `OpenAI ${KEY} then Anthropic ${ANT_KEY} then Bearer ${KEY}`
    for (const keys of [[], [KEY], [ANT_KEY], [KEY, ANT_KEY], [null, undefined]]) {
      const out = redact(text, ...keys)
      expect(out).toBe('OpenAI [key] then Anthropic [key] then Bearer [key]')
    }
  })

  it('still leaves ordinary hyphenated words alone, including ones that run into "ant"', () => {
    for (const plain of [
      'A task-based-classification diagram and a risk-free** chart.',
      'A desk-ant-farm photo and a risk-ant-colony diagram.',
      'The mask-anti-glare coating; a task-antipattern list; brisk-antics.',
      'A disk-ant-proof box... and more.',
      'Ask-anthropic-about-it is not a key, nor is flask-ant-v2.'
    ]) {
      expect(redact(plain), plain).toBe(plain)
    }
  })

  it('clipRedacted: an Anthropic key fragment cut at the edge cannot survive either', () => {
    expect(clipRedacted('x'.repeat(190) + 'sk-ant-api03-SYNTH', 200)).toBe('x'.repeat(190) + '[key]')
    expect(clipRedacted('x'.repeat(194) + ANT_KEY, 200)).toBe('x'.repeat(194) + '[key]')
  })

  it('clipRedacted: a key fragment cut at the edge cannot survive', () => {
    expect(clipRedacted('x'.repeat(186) + 'sk-proj-SYNTH0123456789', 200)).toBe('x'.repeat(186) + '[key]')
    expect(clipRedacted('short and plain', 200)).toBe('short and plain')
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

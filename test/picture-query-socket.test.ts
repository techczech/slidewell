import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPictureQueryServer, parseRequest, type Hit, type PictureQueryEngine, type ProbeSocket, type QueryServer } from '../src/main/picture-search/query-socket'

// A fake engine: fixed ranked hits; records what it was asked.
function fakeEngine(hits: Hit[] = [], ready = true): PictureQueryEngine & { asked: Array<{ text: string; limit: number }> } {
  const asked: Array<{ text: string; limit: number }> = []
  return { asked, ready: () => ready, query: async (text, limit) => (asked.push({ text, limit }), hits.slice(0, limit)) }
}

/** A raw client: send these bytes (optionally nothing), collect everything until the server closes. */
function talk(path: string, payload: string | Buffer | null, opts: { endAfterWrite?: boolean } = {}): Promise<{ reply: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const s = connect({ path })
    let reply = ''
    const t = setTimeout(() => {
      s.destroy()
      resolve({ reply, closed: false })
    }, 3000)
    s.on('connect', () => {
      if (payload !== null) s.write(payload)
      if (opts.endAfterWrite) s.end()
    })
    s.on('data', (d) => (reply += d.toString('utf8')))
    s.on('close', () => {
      clearTimeout(t)
      resolve({ reply, closed: true })
    })
    s.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

const ask = (path: string, text: string, limit = 40): Promise<{ reply: string; closed: boolean }> =>
  talk(path, JSON.stringify({ v: 1, op: 'picture-query', text, limit }) + '\n')

let base: string
let dir: string
let sock: string
let server: QueryServer | null
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'swq-')))
  dir = join(base, 'ud')
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  sock = join(dir, 'picture-query.sock')
  server = null
})
afterEach(async () => {
  await server?.close()
  rmSync(base, { recursive: true, force: true })
})

async function start(engine: PictureQueryEngine, extra: Partial<Parameters<typeof startPictureQueryServer>[0]> = {}): Promise<QueryServer> {
  const res = await startPictureQueryServer({ socketPath: sock, engine, ...extra })
  if (!res.ok) throw new Error(res.reason)
  server = res.server
  return res.server
}

/** A socket left behind by a process that died without cleaning up. */
function makeStaleSocket(path: string): void {
  const r = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`])
  expect(r.signal).toBe('SIGKILL')
  expect(lstatSync(path).isSocket()).toBe(true)
}

describe('picture query endpoint (contract v1, Unix socket)', () => {
  it('answers a valid query with ranked ids and scores only, clamped and capped', async () => {
    const engine = fakeEngine([
      { id: 'well:d00d001', score: 0.81 },
      { id: 'triage:aaaa11112222', score: 0.62 },
      { id: 'slide:AI tools#3', score: -0.1 },
      { id: 'slide:Seals#1', score: 0.2 }
    ])
    await start(engine)
    const { reply, closed } = await ask(sock, 'robots\tin a classroom', 3)
    expect(closed).toBe(true)
    expect(reply.endsWith('\n')).toBe(true)
    expect(JSON.parse(reply)).toEqual({
      v: 1,
      ok: true,
      hits: [
        { id: 'well:d00d001', score: 0.81 },
        { id: 'triage:aaaa11112222', score: 0.62 },
        { id: 'slide:AI tools#3', score: 0 }
      ]
    })
    expect(engine.asked).toEqual([{ text: 'robots in a classroom', limit: 3 }])
    const big = await ask(sock, 'boats', 100000)
    expect(JSON.parse(big.reply).ok).toBe(true)
    expect(engine.asked[1].limit).toBe(200)
  })

  it('creates the socket 0600 inside a folder made 0700, and unlinks it on close', async () => {
    const s = await start(fakeEngine())
    expect(lstatSync(sock).isSocket()).toBe(true)
    expect(lstatSync(sock).mode & 0o777).toBe(0o600)
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    await s.close()
    server = null
    expect(existsSync(sock)).toBe(false)
  })

  it('refuses an oversized request, malformed JSON, a wrong shape and a slow client without crashing', async () => {
    await start(fakeEngine([{ id: 'well:abc1234', score: 0.5 }]), { readTimeoutMs: 150 })
    const bad = { v: 1, ok: false, reason: 'bad-request' }
    const huge = await talk(sock, 'x'.repeat(5000))
    expect(huge.closed).toBe(true)
    expect(JSON.parse(huge.reply)).toEqual(bad)
    const hugeLine = await talk(sock, JSON.stringify({ v: 1, op: 'picture-query', text: 'a'.repeat(4200), limit: 5 }) + '\n')
    expect(JSON.parse(hugeLine.reply)).toEqual(bad)
    const junk = await talk(sock, '{not json\n')
    expect(JSON.parse(junk.reply)).toEqual(bad)
    const shape = await talk(sock, JSON.stringify({ v: 2, op: 'picture-query', text: 'boats' }) + '\n')
    expect(JSON.parse(shape.reply)).toEqual(bad)
    const t0 = Date.now()
    const slow = await talk(sock, '{"v":1,"op":"pic') // never finishes its line
    expect(slow.closed).toBe(true)
    expect(JSON.parse(slow.reply)).toEqual(bad)
    expect(Date.now() - t0).toBeLessThan(2000)
    const hungUp = await talk(sock, '{"v":1', { endAfterWrite: true })
    expect(JSON.parse(hungUp.reply)).toEqual(bad)
    // still serving afterwards
    expect(JSON.parse((await ask(sock, 'boats')).reply)).toEqual({ v: 1, ok: true, hits: [{ id: 'well:abc1234', score: 0.5 }] })
  })

  it("gives the contract's model-not-ready answer when the engine is not ready or fails, busy when it stalls", async () => {
    await start(fakeEngine([], false))
    expect(JSON.parse((await ask(sock, 'boats')).reply)).toEqual({ v: 1, ok: false, reason: 'model-not-ready' })
    await server!.close()
    server = null

    await start({ ready: () => true, query: async () => { throw new Error('picture search model is not ready') } })
    expect(JSON.parse((await ask(sock, 'boats')).reply)).toEqual({ v: 1, ok: false, reason: 'model-not-ready' })
    await server!.close()
    server = null

    await start({ ready: () => true, query: () => new Promise(() => undefined) }, { answerTimeoutMs: 100 })
    expect(JSON.parse((await ask(sock, 'boats')).reply)).toEqual({ v: 1, ok: false, reason: 'busy' })
  })

  it('answers busy past the in-flight cap', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    await start({ ready: () => true, query: async () => (await gate, [{ id: 'well:abc1234', score: 0.4 }]) }, { maxInFlight: 1 })
    const first = ask(sock, 'one')
    await new Promise((r) => setTimeout(r, 50))
    expect(JSON.parse((await ask(sock, 'two')).reply)).toEqual({ v: 1, ok: false, reason: 'busy' })
    release()
    expect(JSON.parse((await first).reply).ok).toBe(true)
  })

  it('accepts any query whose request fits in 4 KB (a 2,000-character text)', async () => {
    const engine = fakeEngine([{ id: 'well:abc1234', score: 0.5 }])
    await start(engine)
    const text = 'robot '.repeat(334).slice(0, 2000)
    expect(text.length).toBe(2000)
    expect(JSON.parse((await ask(sock, text)).reply)).toEqual({ v: 1, ok: true, hits: [{ id: 'well:abc1234', score: 0.5 }] })
    expect(engine.asked[0].text).toBe(text.trim())
  })

  it('keeps a stalled query\'s slot until the engine settles: no pile-up past maxInFlight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    await start(
      { ready: () => true, query: async () => (calls++, await gate, [{ id: 'well:abc1234', score: 0.4 }]) },
      { maxInFlight: 1, answerTimeoutMs: 50 }
    )
    const busy = { v: 1, ok: false, reason: 'busy' }
    expect(JSON.parse((await ask(sock, 'one')).reply)).toEqual(busy) // timed out, still running
    for (const t of ['two', 'three', 'four']) expect(JSON.parse((await ask(sock, t)).reply)).toEqual(busy)
    expect(calls).toBe(1)
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse((await ask(sock, 'five')).reply).ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('refuses to start, and leaves the socket alone, when the probe fails for any reason but refused/absent', async () => {
    makeStaleSocket(sock)
    const before = lstatSync(sock).ino
    const logged: string[] = []
    const emfile = (): ProbeSocket => {
      const e = new EventEmitter() as EventEmitter & { destroy: () => void }
      e.destroy = () => undefined
      setImmediate(() => e.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' })))
      return e
    }
    const res = await startPictureQueryServer({ socketPath: sock, engine: fakeEngine(), probeConnect: emfile, log: (m) => logged.push(m) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/EMFILE/)
    expect(logged.join(' ')).toMatch(/EMFILE/)
    expect(lstatSync(sock).ino).toBe(before)
  })

  it('replaces a stale socket of ours', async () => {
    makeStaleSocket(sock)
    const before = lstatSync(sock).ino
    await start(fakeEngine([{ id: 'well:abc1234', score: 0.3 }]))
    expect(lstatSync(sock).ino).not.toBe(before)
    expect(JSON.parse((await ask(sock, 'boats')).reply).ok).toBe(true)
  })

  it('leaves a live socket (another SlideWell) serving and does not start', async () => {
    const first = await start(fakeEngine([{ id: 'well:1111111', score: 0.9 }]))
    const res = await startPictureQueryServer({ socketPath: sock, engine: fakeEngine([{ id: 'well:2222222', score: 0.9 }]) })
    expect(res.ok).toBe(false)
    expect(JSON.parse((await ask(sock, 'boats')).reply).hits[0].id).toBe('well:1111111')
    await first.close()
    server = null
  })

  it('refuses a plain file or a symlink at the path and leaves it alone', async () => {
    writeFileSync(sock, 'not a socket')
    const res = await startPictureQueryServer({ socketPath: sock, engine: fakeEngine() })
    expect(res.ok).toBe(false)
    expect(readFileSync(sock, 'utf8')).toBe('not a socket')
    rmSync(sock)

    const target = join(base, 'elsewhere')
    writeFileSync(target, 'keep')
    symlinkSync(target, sock)
    const res2 = await startPictureQueryServer({ socketPath: sock, engine: fakeEngine() })
    expect(res2.ok).toBe(false)
    expect(lstatSync(sock).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })

  it('refuses a socket folder that is a symlink', async () => {
    const real = join(base, 'real')
    mkdirSync(real)
    const linked = join(base, 'linked')
    symlinkSync(real, linked)
    const res = await startPictureQueryServer({ socketPath: join(linked, 'picture-query.sock'), engine: fakeEngine() })
    expect(res.ok).toBe(false)
    expect(existsSync(join(real, 'picture-query.sock'))).toBe(false)
  })

  it('parses requests strictly: text required and capped, limit clamped', () => {
    expect(parseRequest('{"v":1,"op":"picture-query","text":"boats"}')).toEqual({ ok: true, text: 'boats', limit: 60 })
    expect(parseRequest('{"v":1,"op":"picture-query","text":"boats","limit":0}')).toEqual({ ok: true, text: 'boats', limit: 1 })
    expect(parseRequest('{"v":1,"op":"picture-query","text":"   "}').ok).toBe(false)
    expect(parseRequest('{"v":1,"op":"picture-query","text":"boats","limit":"9"}').ok).toBe(false)
    expect(parseRequest('{"v":1,"op":"other","text":"boats"}').ok).toBe(false)
    expect(parseRequest('[1]').ok).toBe(false)
  })
})

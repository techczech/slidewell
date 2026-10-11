/**
 * SlideWell's local picture-search query endpoint (ticket 10): TalkWeaver asks, SlideWell answers.
 * Server side of CONTRACT v1, whose reference is TalkWeaver's client
 * (talk-weaver src/main/image-search/slidewell-query.ts). Match it exactly:
 *
 *   Transport  Unix domain socket <userData>/picture-query.sock (no network address at all).
 *   Framing    One request per connection: one line of JSON ending '\n'; one line back; close.
 *              Requests over 4 KB are refused.
 *   Request    {"v":1,"op":"picture-query","text":"<words>","limit":<1..200>}
 *   Response   {"v":1,"ok":true,"hits":[{"id":"<id>","score":<0..1>}, ...]}   ranked, best first
 *              {"v":1,"ok":false,"reason":"model-not-ready"|"busy"|"bad-request"}
 *   Privacy    Ids and scores only (never paths or picture bytes). No query text is logged.
 *
 * Who may connect. Node cannot ask the kernel for the peer's uid (no getpeereid/LOCAL_PEERCRED
 * without a native module), so access rests on the file system: the socket is created 0600 (umask
 * set around bind) inside a directory this user owns and that is made 0700. Only this user can
 * reach it; no other machine can, since a Unix socket has no network address.
 *
 * Start-up is careful with whatever already sits at the path: a socket owned by this user that no
 * one answers is stale and replaced; a live one (another SlideWell) is left serving; anything else
 * (a file, a symlink, another user's socket) is refused and left alone, and no endpoint starts.
 */
import { chmodSync, lstatSync, unlinkSync, type Stats } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

export const PICTURE_QUERY_SOCKET = 'picture-query.sock'
export const MAX_REQUEST_BYTES = 4096
export const MAX_QUERY_CHARS = 1000
export const MAX_LIMIT = 200
export const DEFAULT_LIMIT = 60
const MAX_ID_CHARS = 512
/** macOS sun_path is 104 bytes including the terminating NUL. */
const MAX_SOCKET_PATH_BYTES = 103

export type Hit = { id: string; score: number }
export type Refusal = 'model-not-ready' | 'busy' | 'bad-request'

/** What the endpoint needs from the picture-search engine. A throw from query() means unavailable. */
export interface PictureQueryEngine {
  /** The model is verified and there is an index to search. Checked before every query. */
  ready(): boolean
  /** Text → ranked ids with cosine scores, best first, at most `limit`. Read-only. */
  query(text: string, limit: number): Promise<Hit[]>
}

export type QueryServerOptions = {
  socketPath: string
  engine: PictureQueryEngine
  /** How long a client has to send its request line. */
  readTimeoutMs?: number
  /** How long the engine has to answer before the client gets 'busy'. */
  answerTimeoutMs?: number
  /** Queries running at once; one more is answered 'busy'. */
  maxInFlight?: number
  /** Open connections at once; Node drops the rest. */
  maxConnections?: number
  /** Called with a short message (never query text) when something is refused or fails. */
  log?: (msg: string) => void
}

export type QueryServer = {
  readonly socketPath: string
  /** Stop listening and unlink the socket (only if it is still the one this server created). */
  close(): Promise<void>
}

export type StartResult = { ok: true; server: QueryServer } | { ok: false; reason: string }

type Parsed = { ok: true; text: string; limit: number } | { ok: false }

/** Validate one request line against contract v1. */
export function parseRequest(line: string): Parsed {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return { ok: false }
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false }
  const m = msg as { v?: unknown; op?: unknown; text?: unknown; limit?: unknown }
  if (m.v !== 1 || m.op !== 'picture-query' || typeof m.text !== 'string') return { ok: false }
  const text = m.text.replace(/[\u0000-\u001f]/g, ' ').trim()
  if (!text || text.length > MAX_QUERY_CHARS) return { ok: false }
  let limit = DEFAULT_LIMIT
  if (m.limit !== undefined) {
    if (typeof m.limit !== 'number' || !Number.isFinite(m.limit)) return { ok: false }
    limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(m.limit)))
  }
  return { ok: true, text, limit }
}

/** One response line: ids and scores only, scores clamped to 0..1, at most `limit` hits. */
export function encodeHits(hits: Hit[], limit: number): string {
  const out: Hit[] = []
  for (const h of hits) {
    if (out.length >= limit) break
    if (!h || typeof h.id !== 'string' || !h.id || h.id.length > MAX_ID_CHARS) continue
    if (typeof h.score !== 'number' || !Number.isFinite(h.score)) continue
    out.push({ id: h.id, score: Math.max(0, Math.min(1, h.score)) })
  }
  return JSON.stringify({ v: 1, ok: true, hits: out }) + '\n'
}

export function encodeRefusal(reason: Refusal): string {
  return JSON.stringify({ v: 1, ok: false, reason }) + '\n'
}

function ownUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Does anyone answer on this socket? (connect succeeds = a live server.) */
function probe(path: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ path })
    const done = (live: boolean): void => {
      clearTimeout(t)
      s.destroy()
      resolve(live)
    }
    const t = setTimeout(() => done(true), timeoutMs) // a hung peer is not provably stale: leave it
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}

/** Make the socket's directory private: a real directory (not a symlink) owned by this user, 0700. */
function securePrivateDir(dir: string): string | null {
  const st = lstatOrNull(dir)
  if (!st) return 'socket folder does not exist'
  if (!st.isDirectory()) return 'socket folder is not a directory'
  const uid = ownUid()
  if (uid !== null && st.uid !== uid) return 'socket folder is owned by another user'
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  if ((lstatSync(dir).mode & 0o777) !== 0o700) return 'socket folder could not be made private'
  return null
}

/** Clear the way for the socket: nothing there, or a stale socket of ours (removed). */
async function clearStale(path: string): Promise<string | null> {
  const st = lstatOrNull(path)
  if (!st) return null
  if (!st.isSocket()) return 'something other than a socket is at the socket path; left alone'
  const uid = ownUid()
  if (uid !== null && st.uid !== uid) return 'the socket at the path belongs to another user; left alone'
  if (await probe(path)) return 'another SlideWell is already answering on the socket'
  // re-check right before unlinking: still the same socket inode
  const again = lstatOrNull(path)
  if (!again) return null
  if (!again.isSocket() || again.ino !== st.ino || again.dev !== st.dev) return 'the socket path changed during start-up; left alone'
  unlinkSync(path)
  return null
}

/** Listen with umask 0177 so the socket is born 0600 (bind happens synchronously inside listen). */
function listenPrivate(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => reject(e)
    server.once('error', onError)
    let old: number | null = null
    try {
      old = process.umask(0o177)
    } catch {
      old = null // umask unavailable (worker thread): the chmod below and the 0700 folder still hold
    }
    try {
      server.listen(path, () => {
        server.off('error', onError)
        resolve()
      })
    } finally {
      if (old !== null) process.umask(old)
    }
  })
}

/**
 * Start the endpoint. Never throws: a refusal (unsafe path, live peer, bind failure) is returned and
 * SlideWell carries on without it (TalkWeaver then searches words only).
 */
export async function startPictureQueryServer(opts: QueryServerOptions): Promise<StartResult> {
  const log = opts.log ?? (() => undefined)
  const readTimeoutMs = opts.readTimeoutMs ?? 2000
  const answerTimeoutMs = opts.answerTimeoutMs ?? 15000
  const maxInFlight = opts.maxInFlight ?? 4
  const path = opts.socketPath
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) return { ok: false, reason: 'socket path too long' }
  try {
    const dirProblem = securePrivateDir(dirname(path))
    if (dirProblem) return { ok: false, reason: dirProblem }
    const staleProblem = await clearStale(path)
    if (staleProblem) return { ok: false, reason: staleProblem }
  } catch (e) {
    return { ok: false, reason: `socket preparation failed: ${(e as Error).message}` }
  }

  let inFlight = 0
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (sock) => {
    sockets.add(sock)
    let buf = Buffer.alloc(0)
    let answered = false
    const finish = (line: string): void => {
      if (answered) return
      answered = true
      clearTimeout(readTimer)
      if (sock.destroyed) return
      sock.end(line)
      setTimeout(() => sock.destroy(), 1000).unref() // a client that never reads cannot hold it open
    }
    const readTimer = setTimeout(() => {
      log('picture query: client sent no request in time')
      finish(encodeRefusal('bad-request'))
    }, readTimeoutMs)
    sock.on('error', () => {
      clearTimeout(readTimer)
      sock.destroy()
    })
    sock.on('close', () => {
      clearTimeout(readTimer)
      sockets.delete(sock)
    })
    sock.on('end', () => {
      if (!answered && buf.indexOf(10) < 0) finish(encodeRefusal('bad-request')) // hung up without a full line
    })
    sock.on('data', (chunk: Buffer) => {
      if (answered) return
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(10)
      if ((nl < 0 && buf.length > MAX_REQUEST_BYTES) || nl >= MAX_REQUEST_BYTES) {
        log('picture query: request over 4 KB refused')
        return finish(encodeRefusal('bad-request'))
      }
      if (nl < 0) return
      clearTimeout(readTimer)
      sock.pause()
      const req = parseRequest(buf.subarray(0, nl).toString('utf8'))
      if (!req.ok) {
        log('picture query: malformed request refused')
        return finish(encodeRefusal('bad-request'))
      }
      let ready = false
      try {
        ready = opts.engine.ready()
      } catch {
        ready = false
      }
      if (!ready) return finish(encodeRefusal('model-not-ready'))
      if (inFlight >= maxInFlight) return finish(encodeRefusal('busy'))
      inFlight++
      let settled = false
      const answerTimer = setTimeout(() => {
        if (settled) return
        settled = true
        inFlight--
        log('picture query: engine did not answer in time')
        finish(encodeRefusal('busy'))
      }, answerTimeoutMs)
      Promise.resolve()
        .then(() => opts.engine.query(req.text, req.limit))
        .then(
          (hits) => {
            if (settled) return
            settled = true
            inFlight--
            clearTimeout(answerTimer)
            finish(encodeHits(Array.isArray(hits) ? hits : [], req.limit))
          },
          (e) => {
            if (settled) return
            settled = true
            inFlight--
            clearTimeout(answerTimer)
            log(`picture query: engine unavailable (${(e as Error)?.name ?? 'error'})`)
            finish(encodeRefusal('model-not-ready'))
          }
        )
    })
  })
  server.maxConnections = opts.maxConnections ?? 16
  server.on('error', (e) => log(`picture query: server error ${(e as NodeJS.ErrnoException).code ?? ''}`))

  try {
    await listenPrivate(server, path)
  } catch (e) {
    return { ok: false, reason: `could not listen: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }
  }
  // belt and braces: the mode must be 0600 whatever the umask did
  let mine: Stats
  try {
    chmodSync(path, 0o600)
    mine = lstatSync(path)
    if (!mine.isSocket() || (mine.mode & 0o777) !== 0o600) throw new Error('socket mode is not 0600')
  } catch (e) {
    server.close()
    return { ok: false, reason: (e as Error).message }
  }

  let closed: Promise<void> | null = null
  return {
    ok: true,
    server: {
      socketPath: path,
      close(): Promise<void> {
        if (closed) return closed
        // unlink first and synchronously (quit may not wait), and only our own socket
        try {
          const st = lstatOrNull(path)
          if (st && st.isSocket() && st.ino === mine.ino && st.dev === mine.dev) unlinkSync(path)
        } catch {
          /* already gone */
        }
        closed = new Promise<void>((resolve) => server.close(() => resolve()))
        for (const s of sockets) s.destroy()
        return closed
      }
    }
  }
}

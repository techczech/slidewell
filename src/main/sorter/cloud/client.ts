/**
 * The HTTP side of the cloud step: one POST to the Responses API with a per-request timeout and
 * retry with backoff on 429, 5xx, timeouts and network failures; a small concurrency pool; and
 * redaction, so no error message or log line can carry the API key.
 *
 * The transport is injected (HttpPost): the app passes Electron's net.fetch, tests pass recorded or
 * synthetic responses. Nothing here reads a key from anywhere; the caller hands it in per call.
 */
import { LUNA } from './luna'

export type HttpResponse = { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type HttpPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<HttpResponse>

export type LunaErrorKind = 'offline' | 'auth' | 'rate' | 'server' | 'bad-request' | 'timeout' | 'cancelled'

export class LunaHttpError extends Error {
  constructor(
    message: string,
    readonly kind: LunaErrorKind,
    readonly status?: number
  ) {
    super(message)
    this.name = 'LunaHttpError'
  }
}

/** Remove the key and anything shaped like an OpenAI key (also masked ones such as sk-pro****abcd). */
export function redact(text: string, key?: string | null): string {
  let out = String(text ?? '')
  if (key && key.length >= 4) out = out.split(key).join('[key]')
  return out.replace(/\bsk-[A-Za-z0-9_*\-.]{3,}/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]')
}

export type PostOptions = {
  key: string
  http: HttpPost
  endpoint?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxAttempts?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  /** Told about each retry (attempt number, why, wait); never given the key or a body. */
  onRetry?: (attempt: number, why: string, waitMs: number) => void
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LunaHttpError('cancelled', 'cancelled'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new LunaHttpError('cancelled', 'cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Seconds or an HTTP date in Retry-After, as milliseconds (capped at 60 s); null when absent. */
function retryAfterMs(h: string | null): number | null {
  if (!h) return null
  const s = Number(h)
  if (Number.isFinite(s)) return Math.min(60_000, Math.max(0, s * 1000))
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.min(60_000, Math.max(0, t - Date.now())) : null
}

/** The error message OpenAI put in a JSON error body, redacted and short; '' when none. */
function apiMessage(text: string, key: string): string {
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } })?.error?.message
    return typeof m === 'string' ? redact(m, key).slice(0, 200) : ''
  } catch {
    return ''
  }
}

/**
 * POST one body; returns the parsed JSON on 2xx. Retries 429 / 5xx / timeout / network failure with
 * exponential backoff (1 s, 2 s, 4 s … with jitter, or Retry-After). Throws LunaHttpError otherwise.
 */
export async function postLuna(body: unknown, o: PostOptions): Promise<unknown> {
  const attempts = Math.max(1, o.maxAttempts ?? LUNA.maxAttempts)
  const sleep = o.sleep ?? defaultSleep
  const random = o.random ?? Math.random
  const payload = JSON.stringify(body)
  let last: LunaHttpError = new LunaHttpError('Luna could not be reached', 'offline')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (o.signal?.aborted) throw new LunaHttpError('cancelled', 'cancelled')
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, o.timeoutMs ?? LUNA.timeoutMs)
    const onAbort = (): void => ctl.abort()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    let wait: number | null = null
    try {
      const res = await o.http(o.endpoint ?? LUNA.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.key}` },
        body: payload,
        signal: ctl.signal
      })
      const text = await res.text()
      if (res.status >= 200 && res.status < 300) {
        try {
          return JSON.parse(text)
        } catch {
          throw new LunaHttpError('Luna sent a reply that was not JSON', 'server', res.status)
        }
      }
      if (res.status === 401 || res.status === 403) throw new LunaHttpError('OpenAI did not accept the API key', 'auth', res.status)
      if (res.status === 429 || res.status >= 500) {
        last = new LunaHttpError(res.status === 429 ? 'OpenAI is rate-limiting requests' : `OpenAI had a server error (${res.status})`, res.status === 429 ? 'rate' : 'server', res.status)
        wait = retryAfterMs(res.headers.get('retry-after'))
      } else {
        const m = apiMessage(text, o.key)
        throw new LunaHttpError(`OpenAI refused the request (${res.status})${m ? `: ${m}` : ''}`, 'bad-request', res.status)
      }
    } catch (e) {
      if (e instanceof LunaHttpError && e !== last) throw e
      if (!(e instanceof LunaHttpError)) {
        if (o.signal?.aborted) throw new LunaHttpError('cancelled', 'cancelled')
        last = timedOut ? new LunaHttpError('Luna took too long to answer', 'timeout') : new LunaHttpError('Luna could not be reached (offline?)', 'offline')
      }
    } finally {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
    }
    if (attempt < attempts) {
      const backoff = wait ?? Math.round(1000 * 2 ** (attempt - 1) * (0.75 + 0.5 * random()))
      o.onRetry?.(attempt, last.kind, backoff)
      await sleep(backoff, o.signal)
    }
  }
  throw last
}

/** Run `fn` over `items` with at most `limit` at a time. Stops starting new ones once `stop()` is true. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length && !stop()) {
      const i = next++
      await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

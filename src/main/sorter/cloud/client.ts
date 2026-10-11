/**
 * The HTTP side of the cloud step: one POST to the provider's API (OpenAI's Responses API for Luna,
 * Anthropic's Messages API for Haiku; the Wire says where and with which headers) with a per-request
 * timeout and retry with backoff on 429, 5xx, timeouts and network failures; a small concurrency
 * pool; and redaction, so no error message or log line can carry an API key of either provider.
 *
 * The transport is injected (HttpPost): the app passes Electron's net.fetch, tests pass recorded or
 * synthetic responses. Nothing here reads a key from anywhere; the caller hands it in per call.
 * Every request asks the transport not to follow redirects (`redirect: 'error'`): a request carries
 * the key in a header and pictures in its body, and neither may travel on to another address.
 */
import { LUNA } from './luna'

export type HttpResponse = { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type HttpPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<HttpResponse>

/** Where one provider's requests go and how they carry the key; the names are for error messages. */
export type Wire = {
  endpoint: string
  headers(key: string): Record<string, string>
  /** 'OpenAI' | 'Anthropic' */
  company: string
  /** 'Luna' | 'Haiku' */
  name: string
  timeoutMs: number
  maxAttempts: number
}

export const LUNA_WIRE: Wire = {
  endpoint: LUNA.endpoint,
  headers: (key) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }),
  company: 'OpenAI',
  name: 'Luna',
  timeoutMs: LUNA.timeoutMs,
  maxAttempts: LUNA.maxAttempts
}

export type LunaErrorKind = 'offline' | 'auth' | 'rate' | 'server' | 'bad-request' | 'timeout' | 'cancelled' | 'revoked'

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

/**
 * Remove the given keys and anything shaped like an API key of either provider.
 *
 * Both (OpenAI sk-…, sk-proj-…; Anthropic sk-ant-api03-…): 20+ key characters after sk- with at
 * least one digit among them (also one glued to a preceding word such as echosk-proj-…, hence no
 * leading word boundary; dots, asterisks and an ellipsis inside it count, so a long key masked in the
 * middle goes whole, tail included), or a masked one:
 *   - 2+ key characters, a run of 2+ asterisks, 2+ alphanumerics (sk-test-****WXYZ, sk-ant-****WXYZ);
 *   - 2+ dots or an ellipsis straight after a hyphen, then 2+ alphanumerics (sk-...WXYZ, sk-proj-…WXYZ);
 *   - key characters with a digit somewhere, 2+ dots or an ellipsis, 2+ key characters (sk-ab12…WXYZ).
 * Ordinary words ending in "sk-" (task-based-classification, risk-free**, task-based...or) have none
 * of these shapes and are left alone.
 *
 * Anthropic only, applied first so that the general patterns cannot take the front of a masked
 * Anthropic key and leave its tail, because its keys carry a typed prefix no ordinary word has:
 *   - sk-ant-<kind><nn>- (sk-ant-api03-, sk-ant-admin01-, sk-ant-oat01-) and whatever key characters
 *     follow, however few: a key cut short, or masked with dots, an ellipsis or asterisks
 *     (sk-ant-api03-AbC...wxYZ, sk-ant-api03-…wxYZ);
 *   - sk-ant- masked without the kind: key characters, then 2+ dots, an ellipsis or 2+ asterisks,
 *     then 2+ key characters (sk-ant-...wxYZ).
 * A word such as desk-ant-farm or risk-ant-colony has neither a kind with two digits nor a mask.
 *
 * And the two header forms a key travels in: "Bearer <key>" and "x-api-key: <key>".
 */
export function redact(text: string, ...keys: Array<string | null | undefined>): string {
  let out = String(text ?? '')
  for (const key of keys) if (key && key.length >= 4) out = out.split(key).join('[key]')
  return out
    .replace(/sk-ant-[a-z]{2,8}\d{2}-[A-Za-z0-9_\-*.…]*/g, '[key]')
    .replace(/sk-ant-[A-Za-z0-9_\-]*(?:\.{2,}|…|\*{2,})[A-Za-z0-9_\-]{2,}/g, '[key]')
    .replace(/sk-(?=[A-Za-z0-9_*\-.…]*\d)[A-Za-z0-9_*\-.…]{20,}/g, '[key]')
    .replace(/sk-[A-Za-z0-9_\-.]{2,}\*{2,}[A-Za-z0-9]{2,}/g, '[key]')
    .replace(/sk-(?:[A-Za-z0-9_]+-)*(?:\.{2,}|…)[A-Za-z0-9]{2,}/g, '[key]')
    .replace(/sk-(?=[A-Za-z0-9_\-.…]*\d)[A-Za-z0-9_\-]+(?:\.{2,}|…)[A-Za-z0-9_\-]{2,}/g, '[key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[key]')
}

/**
 * Shorten text that has already been redacted. A key fragment cut off at the edge would no longer
 * match any key shape, so an sk- tail left there is replaced too.
 */
export function clipRedacted(text: string, max: number): string {
  return text.slice(0, max).replace(/sk-[A-Za-z0-9_\-]*$/, '[key]')
}

export type PostOptions = {
  key: string
  http: HttpPost
  /** The provider to post to. postLuna fixes it to LUNA_WIRE. */
  wire: Wire
  signal?: AbortSignal
  timeoutMs?: number
  maxAttempts?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  /** Told about each retry (attempt number, why, wait); never given the key or a body. */
  onRetry?: (attempt: number, why: string, waitMs: number) => void
  /**
   * Called before every attempt, the first and each retry. Returns the body and key for this attempt
   * (they replace `body` and `key`), or 'skip' when nothing is left to send (postCloud then returns
   * null without a request). May throw (e.g. LunaHttpError 'revoked') to stop with no request.
   */
  before?: (attempt: number) => { body: unknown; key: string } | 'skip'
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

/** The error message the provider put in a JSON error body (both use error.message), redacted and short; '' when none. */
function apiMessage(text: string, key: string): string {
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } })?.error?.message
    return typeof m === 'string' ? redact(m, key).slice(0, 200) : ''
  } catch {
    return ''
  }
}

/**
 * POST one body; returns the parsed JSON on 2xx (null when `before` said 'skip'). Retries 429 / 5xx / timeout / network failure with
 * exponential backoff (1 s, 2 s, 4 s … with jitter, or Retry-After). Throws LunaHttpError otherwise.
 */
export async function postCloud(body: unknown, o: PostOptions): Promise<unknown> {
  const { company, name } = o.wire
  const attempts = Math.max(1, o.maxAttempts ?? o.wire.maxAttempts)
  const sleep = o.sleep ?? defaultSleep
  const random = o.random ?? Math.random
  let last: LunaHttpError = new LunaHttpError(`${name} could not be reached`, 'offline')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (o.signal?.aborted) throw new LunaHttpError('cancelled', 'cancelled')
    let key = o.key
    let payload: string
    if (o.before) {
      const b = o.before(attempt)
      if (b === 'skip') return null
      key = b.key
      payload = JSON.stringify(b.body)
    } else payload = JSON.stringify(body)
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, o.timeoutMs ?? o.wire.timeoutMs)
    const onAbort = (): void => ctl.abort()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    let wait: number | null = null
    try {
      const res = await o.http(o.wire.endpoint, {
        method: 'POST',
        headers: o.wire.headers(key),
        body: payload,
        signal: ctl.signal,
        redirect: 'error'
      })
      const text = await res.text()
      if (res.status >= 200 && res.status < 300) {
        try {
          return JSON.parse(text)
        } catch {
          throw new LunaHttpError(`${name} sent a reply that was not JSON`, 'server', res.status)
        }
      }
      if (res.status === 401 || res.status === 403) throw new LunaHttpError(`${company} did not accept the API key`, 'auth', res.status)
      if (res.status === 429 || res.status >= 500) {
        last = new LunaHttpError(res.status === 429 ? `${company} is rate-limiting requests` : `${company} had a server error (${res.status})`, res.status === 429 ? 'rate' : 'server', res.status)
        wait = retryAfterMs(res.headers.get('retry-after'))
      } else {
        const m = apiMessage(text, key)
        throw new LunaHttpError(`${company} refused the request (${res.status})${m ? `: ${m}` : ''}`, 'bad-request', res.status)
      }
    } catch (e) {
      if (e instanceof LunaHttpError && e !== last) throw e
      if (!(e instanceof LunaHttpError)) {
        if (o.signal?.aborted) throw new LunaHttpError('cancelled', 'cancelled')
        last = timedOut ? new LunaHttpError(`${name} took too long to answer`, 'timeout') : new LunaHttpError(`${name} could not be reached (offline?)`, 'offline')
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

/** postCloud to OpenAI's Responses API (Luna). */
export function postLuna(body: unknown, o: Omit<PostOptions, 'wire'>): Promise<unknown> {
  return postCloud(body, { ...o, wire: LUNA_WIRE })
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

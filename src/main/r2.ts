/**
 * R2 (Cloudflare) storage client for SlideWell — the S3 API via aws4fetch (SigV4 over fetch),
 * far lighter than the full AWS SDK and uses the fetch already in the Electron main process.
 * Increment 1 (spec 2026-06-24): config + credentials + connection test. Read-through/write
 * land in later increments. Keys mirror the local store tree: `<prefix>/<store>/<relPath>`.
 */
import { AwsClient } from 'aws4fetch'

export type R2Settings = { accountId: string; endpoint?: string; bucket: string; prefix: string }
export type R2Creds = { accessKeyId: string; secretAccessKey: string }

/** The R2 S3 endpoint — explicit override, else derived from the account id. */
export function r2Endpoint(cfg: { accountId: string; endpoint?: string }): string {
  return (cfg.endpoint?.trim() || `https://${cfg.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '')
}

/** Object key mirroring the local tree: `<prefix>/<store>/<relPath>`, single slashes, no leading slash. */
export function r2KeyFor(prefix: string, store: string, relPath: string): string {
  return [prefix, store, relPath]
    .map((s) => String(s).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** A minimal R2 object client: url/head/get/put/list, all SigV4-signed. */
export function makeR2(cfg: R2Settings, creds: R2Creds): {
  url: (key: string) => string
  head: (key: string) => Promise<Response>
  get: (key: string) => Promise<Response>
  put: (key: string, body: Uint8Array | Buffer, contentType?: string) => Promise<Response>
  del: (key: string) => Promise<Response>
  list: (prefix: string, max?: number) => Promise<Response>
} {
  const aws = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region: 'auto', service: 's3' })
  const base = `${r2Endpoint(cfg)}/${cfg.bucket}`
  const url = (key: string): string => `${base}/${key}`
  return {
    url,
    head: (key) => aws.fetch(url(key), { method: 'HEAD' }),
    get: (key) => aws.fetch(url(key), { method: 'GET' }),
    put: (key, body, contentType) => aws.fetch(url(key), { method: 'PUT', body, headers: contentType ? { 'content-type': contentType } : {} }),
    del: (key) => aws.fetch(url(key), { method: 'DELETE' }),
    list: (prefix, max = 1000) => aws.fetch(`${base}?list-type=2&max-keys=${max}&prefix=${encodeURIComponent(prefix)}`, { method: 'GET' })
  }
}

/** Verify creds + bucket reachability by listing one object under the prefix. */
export async function testR2(cfg: R2Settings, creds: R2Creds): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await makeR2(cfg, creds).list(r2KeyFor(cfg.prefix, '', ''), 1)
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

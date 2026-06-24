# R2 Storage — Increment 1: R2 client + Settings credentials

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use `- [ ]`.

**Goal:** Give SlideWell a working, authenticated R2 client and a Settings panel to enter/store/test R2 credentials — no store behaviour change yet.

**Architecture:** A small `src/main/r2.ts` wraps R2's S3 API via `aws4fetch` (SigV4 over `fetch`). Non-secret R2 config (account id / endpoint / bucket / prefix) lives in `userData/config.json`; the access key + secret are encrypted with Electron `safeStorage` (OS keychain) and stored base64 in config. Settings gains an "R2 (cloud storage)" section with a Test-connection button.

**Tech Stack:** Electron main, `aws4fetch`, `safeStorage`, vitest.

## Global Constraints
- IPC types in `src/preload/index.ts` are the single source of truth; mirror in `sw-mock.ts`.
- Secrets never hardcoded; the secret is **write-only** across IPC (never returned to the renderer) and stored via `safeStorage`.
- Default: R2 unconfigured → everything behaves exactly as today (no behaviour change this increment).
- Real verification = vitest (pure parts) + `npm run build` (esbuild) + manual Test-connection; per-project `tsc -p` shows no new errors beyond the known `well.ts:108` / web `TS6307` baselines.
- R2 endpoint default: `https://<accountId>.r2.cloudflarestorage.com`; bucket default `ppt-archive-media` (existing).

---

### Task 1: `aws4fetch` dep + pure key/endpoint helpers (TDD)

**Files:** Create `src/main/r2.ts`; Create `test/r2.test.ts`; Modify `package.json`.

**Produces:**
- `r2Endpoint(cfg: { accountId: string; endpoint?: string }): string`
- `r2KeyFor(prefix: string, store: string, relPath: string): string` — joins + normalizes to `<prefix>/<store>/<relPath>` with single slashes, no leading slash.

- [ ] **Step 1** `npm install aws4fetch` (commit lockfile).
- [ ] **Step 2** Write `test/r2.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { r2Endpoint, r2KeyFor } from '../src/main/r2'
describe('r2Endpoint', () => {
  it('derives the R2 S3 endpoint from the account id', () => {
    expect(r2Endpoint({ accountId: 'abc123' })).toBe('https://abc123.r2.cloudflarestorage.com')
  })
  it('honours an explicit endpoint override', () => {
    expect(r2Endpoint({ accountId: 'abc', endpoint: 'https://x.example.com' })).toBe('https://x.example.com')
  })
})
describe('r2KeyFor', () => {
  it('joins prefix/store/relPath with single slashes, no leading slash', () => {
    expect(r2KeyFor('slidewell', 'archive', 'extracted/d/renders/s.webp')).toBe('slidewell/archive/extracted/d/renders/s.webp')
  })
  it('tolerates stray slashes and empty prefix', () => {
    expect(r2KeyFor('/slidewell/', 'well', '/images/a.webp')).toBe('slidewell/well/images/a.webp')
    expect(r2KeyFor('', 'well', 'images/a.webp')).toBe('well/images/a.webp')
  })
})
```
- [ ] **Step 3** `npx vitest run test/r2.test.ts` → FAIL (module missing).
- [ ] **Step 4** Implement the pure helpers in `r2.ts` (plus the client/IO functions in Task 2):
```ts
export function r2Endpoint(cfg: { accountId: string; endpoint?: string }): string {
  return (cfg.endpoint?.trim() || `https://${cfg.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '')
}
export function r2KeyFor(prefix: string, store: string, relPath: string): string {
  return [prefix, store, relPath].map((s) => String(s).replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
}
```
- [ ] **Step 5** `npx vitest run` → PASS. Commit.

---

### Task 2: R2 client + connection test (`r2.ts`)

**Files:** Modify `src/main/r2.ts`.

**Produces:**
- `type R2Settings = { accountId: string; endpoint?: string; bucket: string; prefix: string }`
- `type R2Creds = { accessKeyId: string; secretAccessKey: string }`
- `makeR2(cfg: R2Settings, creds: R2Creds)` → `{ url(key), head(key), get(key), put(key, body, contentType?), list(prefix, max?) }` built on `aws4fetch`'s `AwsClient`.
- `testR2(cfg: R2Settings, creds: R2Creds): Promise<{ ok: boolean; error?: string }>` — `list('', 1)`, ok on HTTP 200.

- [ ] **Step 1** Implement (no unit test — network I/O; covered by manual Test + a gated integration test later):
```ts
import { AwsClient } from 'aws4fetch'
export type R2Settings = { accountId: string; endpoint?: string; bucket: string; prefix: string }
export type R2Creds = { accessKeyId: string; secretAccessKey: string }
export function makeR2(cfg: R2Settings, creds: R2Creds) {
  const aws = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region: 'auto', service: 's3' })
  const base = `${r2Endpoint(cfg)}/${cfg.bucket}`
  const url = (key: string): string => `${base}/${key}`
  return {
    url,
    head: (key: string) => aws.fetch(url(key), { method: 'HEAD' }),
    get: (key: string) => aws.fetch(url(key), { method: 'GET' }),
    put: (key: string, body: Uint8Array | Buffer, contentType?: string) =>
      aws.fetch(url(key), { method: 'PUT', body, headers: contentType ? { 'content-type': contentType } : {} }),
    list: (prefix: string, max = 1000) => aws.fetch(`${base}?list-type=2&max-keys=${max}&prefix=${encodeURIComponent(prefix)}`, { method: 'GET' })
  }
}
export async function testR2(cfg: R2Settings, creds: R2Creds): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await makeR2(cfg, creds).list(r2KeyFor(cfg.prefix, '', ''), 1)
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
```
- [ ] **Step 2** `npm run build` green. Commit.

---

### Task 3: Config + safeStorage creds + IPC (`index.ts`)

**Files:** Modify `src/main/index.ts`.

**Produces (IPC):** `settings:get-r2` → `{ accountId, endpoint, bucket, prefix, hasCreds }` (no secret); `settings:set-r2` `(patch: { accountId?, endpoint?, bucket?, prefix?, accessKeyId?, secretAccessKey? }) → { ok }`; `settings:test-r2 → { ok, error? }`.

- [ ] **Step 1** `Config` type gains `r2?: { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyIdEnc?: string; secretEnc?: string }`. Import `safeStorage` from electron; import `testR2, type R2Settings, type R2Creds` from `./r2`.
- [ ] **Step 2** Helpers:
```ts
function r2Settings(): R2Settings {
  const r = readConfig().r2 ?? {}
  return { accountId: r.accountId ?? '', endpoint: r.endpoint, bucket: r.bucket || 'ppt-archive-media', prefix: r.prefix || 'slidewell' }
}
function r2Creds(): R2Creds | null {
  const r = readConfig().r2 ?? {}
  if (!r.accessKeyIdEnc || !r.secretEnc || !safeStorage.isEncryptionAvailable()) return null
  try {
    return {
      accessKeyId: safeStorage.decryptString(Buffer.from(r.accessKeyIdEnc, 'base64')),
      secretAccessKey: safeStorage.decryptString(Buffer.from(r.secretEnc, 'base64'))
    }
  } catch { return null }
}
```
- [ ] **Step 3** Handlers (place near `settings:choose-others-folder`):
```ts
ipcMain.handle('settings:get-r2', () => {
  const s = r2Settings()
  return { accountId: s.accountId, endpoint: s.endpoint ?? '', bucket: s.bucket, prefix: s.prefix, hasCreds: Boolean(r2Creds()) }
})
ipcMain.handle('settings:set-r2', (_e, patch: { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string }) => {
  const r = { ...(readConfig().r2 ?? {}) }
  if (patch.accountId !== undefined) r.accountId = patch.accountId.trim()
  if (patch.endpoint !== undefined) r.endpoint = patch.endpoint.trim()
  if (patch.bucket !== undefined) r.bucket = patch.bucket.trim()
  if (patch.prefix !== undefined) r.prefix = patch.prefix.trim()
  if (patch.accessKeyId && patch.secretAccessKey && safeStorage.isEncryptionAvailable()) {
    r.accessKeyIdEnc = safeStorage.encryptString(patch.accessKeyId).toString('base64')
    r.secretEnc = safeStorage.encryptString(patch.secretAccessKey).toString('base64')
  }
  writeConfig({ r2: r })
  return { ok: true }
})
ipcMain.handle('settings:test-r2', async () => {
  const creds = r2Creds()
  if (!creds) return { ok: false, error: 'No credentials saved' }
  return testR2(r2Settings(), creds)
})
```
- [ ] **Step 4** `npm run build` green; `tsc -p tsconfig.node.json --noEmit` no new errors. Commit.

---

### Task 4: Preload + mock

**Files:** Modify `src/preload/index.ts`, `src/renderer/src/sw-mock.ts`.

- [ ] **Step 1** Add to `settings` in preload:
```ts
getR2: (): Promise<{ accountId: string; endpoint: string; bucket: string; prefix: string; hasCreds: boolean }> => ipcRenderer.invoke('settings:get-r2'),
setR2: (patch: { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string }): Promise<{ ok: boolean }> => ipcRenderer.invoke('settings:set-r2', patch),
testR2: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('settings:test-r2'),
```
- [ ] **Step 2** Mirror in `sw-mock.ts` settings: `getR2: async () => ({ accountId: '', endpoint: '', bucket: 'ppt-archive-media', prefix: 'slidewell', hasCreds: false }), setR2: async () => ({ ok: true }), testR2: async () => ({ ok: false, error: 'mock' })`.
- [ ] **Step 3** `npm run build` green. Commit.

---

### Task 5: Settings UI — R2 account section

**Files:** Modify `src/renderer/src/App.tsx` (SettingsPanel).

- [ ] **Step 1** In `SettingsPanel`, add state + load of `getR2()`, controlled inputs for accountId / endpoint / bucket / prefix / accessKeyId / secretAccessKey (secret + key are write-only: blank placeholder shows "saved" when `hasCreds`), a **Save** button (`setR2`), and a **Test connection** button (`testR2`) with a status line. Add as a new `settings-section` "R2 (cloud storage)".
- [ ] **Step 2** `npm run build` green; `npx vitest run` green. Commit.

---

### Task 6: Verify + changelog

- [ ] `npm run build`, `npx vitest run` green; `tsc -p` baselines only.
- [ ] Manual: launch, enter creds, Test connection → ✓ (against the real `ppt-archive-media` bucket).
- [ ] `_CHANGELOG/changes/r2-client-and-credentials.md` + regen index. Commit.

## Self-Review
- Spec coverage: increment-1 scope = R2 client + creds + Settings + test. ✓ (read-through, write, DB versioning are increments 2-4, out of scope here.)
- Placeholder scan: none; all code shown. ✓
- Type consistency: `R2Settings`/`R2Creds`/`r2KeyFor`/`r2Endpoint`/`makeR2`/`testR2` consistent across tasks; IPC shapes match preload. ✓
- Secret hygiene: secret write-only across IPC, `safeStorage`-encrypted, never returned. ✓

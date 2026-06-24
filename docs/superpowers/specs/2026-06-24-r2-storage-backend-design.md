# Per-store storage backend: Local or R2 (R2 as canonical, cached locally)

**Status:** design — pending review, then plan + build (incremental).
**Repo:** slidewell (execution). Direction layer: presentation-system (ADR-0010 storage classes + content-addressed R2; this warrants a new ADR — call it **ADR-0032**).

## Problem

Dominik works across two machines — a **MacBook Pro** (work; where most work happens; can't hold the full heavy archive) and an always-on **Mac mini** (home; has space) — plus wants durable off-machine storage so he doesn't lose data. He wants to **choose, per store, whether SlideWell uses local files or R2 cloud storage**, with R2 able to be the *canonical* home (not just a mirror). The same switch makes SlideWell usable by **people without his hardware**: pick R2 and get a cloud-backed app with no mini/Tailscale.

Today every store is local-only; the `swarchive://` read path serves local files exclusively; nothing in the app talks to R2 (R2 exists only as `ppt-archive`'s manual content-addressed handout uploader, ADR-0010).

## Decisions (from the 2026-06-24 brainstorm)

- **Per-store backend.** Each store — **archive**, **others-library**, **well** — is independently **Local** or **R2**. (Conversions output is throwaway; excluded.)
- **R2 = canonical when selected.** The durable source of truth for that store's media is R2; local disk holds a copy governed by a **cache policy**.
- **Cache policy (per machine, per R2 store):** **Full mirror** (keep everything locally — fast, fully offline, complete copy; the Pro and mini use this) or **Bounded** (LRU up to a size cap; fetch the rest on demand — space-tight machines / other users).
- **Indexes stay local.** A store's SQLite search index (`registry/*.db`, `well.db`, `triage.db`) is **never** streamed from R2 (can't query SQLite over object storage). For the archive/others, the index is **rebuildable** locally; for the well, the index is **authoritative** and gets **versioned backup** to R2. Only **heavy binary media** (renders, embedded images, media-store, well images) is the R2-canonical + cached part.
- **R2 layout = path-mirrored.** Keys mirror the local store tree by relative path under a per-store prefix (e.g. `archive/extracted/<id>/renders/slide_07.webp`, `well/images/<slug>--<id>.webp`). Uniform fetch for renders + media + well (renders aren't content-hash-addressed in their path, so a content-hash scheme can't resolve them).
- **Auth:** private bucket + S3 credentials, entered in Settings, stored **encrypted via Electron `safeStorage`** (OS keychain) so it survives a Finder-launched app.
- **`well.db`/`triage.db` durability:** versioned R2 backup — timestamped objects + a `latest`, pulled on app start, pushed on change; **one-writer-at-a-time**; every version retained; a restore-a-version picker. (No multi-writer merge.)

## Non-goals

- No streaming of SQLite indexes from R2 (indexes are local).
- No real-time multi-writer DB sync (one-writer-at-a-time + versioned recovery instead).
- No change to **Local** mode (fully backward compatible — today's behaviour, R2 untouched).
- Not removing `ppt-archive`'s existing content-addressed `media/<sha>` handout objects (different consumer; left as-is).
- Conversions output stays a throwaway local save.

## Architecture

### Config (`userData/config.json`)
```ts
storage: {
  archive: { backend: 'local' | 'r2', cache: 'full' | { boundedGB: number } },
  others:  { backend: 'local' | 'r2', cache: 'full' | { boundedGB: number } },
  well:    { backend: 'local' | 'r2', cache: 'full' | { boundedGB: number } }
}
r2: { accountId, endpoint, bucket, prefix }   // + accessKeyId/secretAccessKey via safeStorage (encrypted)
```
Defaults: all `backend: 'local'` (no behaviour change until opted in).

### Modules
- **`src/main/r2.ts`** — S3-compatible R2 client (`@aws-sdk/client-s3`). Creds decrypted from `safeStorage`. `getObject(key)`, `putObject(key, data)`, `headObject(key) → bool`, `listVersions(prefix)`. Pure I/O; no app logic.
- **`src/main/storage.ts`** — the backend resolver + cache. Maps a store + local path → `{ localPath, r2Key }`; `resolve(store, localPath)` returns a servable local path: cache-hit → it; else fetch from R2 → write to the local cache → return it. Owns cache accounting + LRU eviction (bounded) with **verify-before-evict** (`headObject` confirms R2 has it). Full-mirror never evicts.
- **`src/main/index.ts`** — `swarchive://` handler calls `storage.resolve(...)`; settings IPC (backends, cache, creds, sync, restore); write hooks.
- **Write hooks** in `ingest.ts` / `convert.ts` (no — convert is throwaway) / `well.ts`: after a media file is produced in an **R2-backed** store, `putObject` it (confirm) before it's considered durable.

### Read path
`swarchive://` → `storage.resolve(store, absPath)`:
1. Local file present → serve.
2. Missing + store is R2-backed → `r2.getObject(key)` → write into the local cache dir → serve. Bounded cache may evict LRU (only files confirmed in R2).
3. R2 unreachable / object missing → 404 placeholder (never crash; search still lists, thumbnails show a placeholder).

### Write path
Import / add-to-well into an R2-backed store: write locally **and** `putObject` to R2; the write is "durable" only after R2 confirms. The other machine pulls on next sync/startup (full mirror) or on demand (bounded).

### `well.db` / `triage.db`
On change → push `well/db/well-<ISO>.db` (+ overwrite `well/db/well-latest.db`); same for triage. On start → pull `*-latest.db` if newer than local (one-writer-at-a-time; compare a stored marker). Settings → "Restore a version" lists timestamped objects.

### Settings UI (per store)
For archive / others / well: a **Backend** toggle (Local · R2) and, when R2, a **Cache** control (Full mirror · Bounded [N] GB). Plus a global **R2 account** section (account id / endpoint / bucket / prefix / access key / secret — secret write-only, stored via `safeStorage`), a **Sync now** action, **cache size + Clear cache**, and **well DB version restore**.

## Safety rules (this is a data-durability feature)
- **A local file is deleted only after `headObject` confirms R2 has it** (verify-before-evict). Full-mirror never evicts.
- **Writes upload to R2 and confirm before being treated as durable** — a failed upload surfaces an error; the local copy is kept.
- **`well.db`/`triage.db` are versioned**, never destructively overwritten — any version is restorable.
- **Local mode is untouched** — opting a store into R2 is explicit; nothing uploads or evicts in Local mode.
- With R2 + Pro full-mirror + mini full-mirror you have **three copies**; a solo user has R2 + their cache.

## Error handling
- Missing/invalid creds → R2 stores behave as Local-empty with a clear Settings banner; no crashes.
- Offline → cache serves what it has; misses show placeholders; writes queue or error visibly (no silent loss).
- Eviction never runs without a successful `headObject`.

## Testing
- **Unit (`storage.ts`):** path↔key mapping; resolve() cache-hit vs miss (mock r2); bounded-cache eviction picks LRU and **only** evicts verified-in-R2 files; full-mirror never evicts.
- **Unit (`r2.ts`):** key building; head/get/put against a mocked S3 client.
- **Unit:** `well.db` versioned push/pull selection (timestamp compare).
- **Integration (dependency-gated, real bucket):** put → head → get round-trip; a render fetched from R2 renders via `swarchive://`.

## ADR-0032 (to draft in presentation-system)
"SlideWell storage backend is per-store and pluggable (Local | R2); R2 is canonical when selected, with a local full-mirror or bounded cache; SQLite indexes stay local; the well's DBs get versioned R2 backup." Builds on ADR-0010 (storage classes, content-addressed R2), ADR-0026 (layered authority), ADR-0031 (Others' Library).

## Files
- **new** `src/main/r2.ts`, `src/main/storage.ts`
- **edit** `src/main/index.ts` (config + swarchive resolver + settings IPC + DB backup/restore), `src/main/ingest.ts` + `src/main/well.ts` (write hooks), `src/preload/index.ts` (types + methods), `src/renderer/src/App.tsx` (Settings UI), `src/renderer/src/sw-mock.ts`
- **edit** `package.json` (`@aws-sdk/client-s3`)
- presentation-system: ADR-0032 + CONTEXT note (separate, flagged for review)

## Build order (each increment ships independently)
1. **R2 client + creds** — `r2.ts`, Settings R2-account section (`safeStorage`), "Test connection". No store behaviour change.
2. **Per-store backend setting + read-through cache** — `storage.ts`, Settings per-store Backend/Cache controls, `swarchive://` resolves via R2 for R2-backed stores. (Display from R2.)
3. **Write path + sync** — import/add-to-well upload to R2; "Sync now" mirrors a store; bounded-cache eviction.
4. **`well.db`/`triage.db` versioned backup + restore.**

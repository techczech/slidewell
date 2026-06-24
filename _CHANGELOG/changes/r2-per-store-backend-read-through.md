---
title: "R2 storage — increment 2: per-store backend toggle + read-through cache + sync"
id: r2-per-store-backend-read-through
date: 2026-06-24
type: change
status: shipped
tags: [r2, storage, cloudflare, read-through, cache, sync, settings, adr-0032]
---

# R2 storage — increment 2: per-store backend toggle + read-through cache + sync

Second slice of the per-store Local|R2 backend (spec `docs/superpowers/specs/2026-06-24-r2-storage-backend-design.md`). Each store can now be set to **R2**, its media uploaded, and fetched on demand — so a space-tight machine can display media it doesn't hold locally.

- **`src/main/storage.ts`** — the engine. `pickStore` (which store root contains a path; exact dir boundary) + `keyForPath` (path-mirrored `<prefix>/<store>/<relPath>`) are pure + unit-tested. `fetchFromR2` downloads on miss into the local store dir (which doubles as the cache — full-mirror keeps everything). `syncDirToR2` mirrors a store's **media** (images/renders/video; `.db`/`.json` stay local) to R2, idempotently (HEAD then PUT).
- **`swarchive://`** now resolves **local-or-R2**: local file if present, else for an R2-backed store fetch it from R2 and serve. **Never deletes anything** (no eviction yet — full-mirror semantics; bounded-cache eviction is a later sub-increment).
- **`src/main/r2.ts`** — added `del` (for cleanup / future delete).
- **Settings** — a "Per-store backend" section: Archive / Others' Library / Well each toggle **Local | R2**, with a **Sync to R2** button (enabled once R2 creds are saved).

**Verified**: build + 25 vitest green; per-project `tsc` only the known `well.ts:108` + web `TS6307` baselines. Live R2 round-trip against the real `ppt-archive-media` bucket (throwaway `slidewell-selftest` prefix): upload → delete local → refetch → **bytes match**, then cleaned up.

Next: write-on-add (uploads as you add to the well) + bounded-cache eviction (verify-before-evict); then `well.db`/`triage.db` versioned backup.

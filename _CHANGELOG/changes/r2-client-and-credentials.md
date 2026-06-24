---
title: "R2 storage backend — increment 1: client + credentials + Settings"
id: r2-client-and-credentials
date: 2026-06-24
type: change
status: shipped
tags: [r2, storage, cloudflare, settings, safestorage, credentials, adr-0032]
---

# R2 storage backend — increment 1: client + credentials + Settings

First slice of the per-store Local|R2 storage backend (spec `docs/superpowers/specs/2026-06-24-r2-storage-backend-design.md`; pending ADR-0032). Lands the R2 client and a Settings panel to enter, store, and **test** R2 credentials. **No store behaviour change yet** — stores stay Local until later increments wire read-through/write.

- **`src/main/r2.ts`** — R2 S3 client via **`aws4fetch`** (SigV4 over `fetch`; far lighter than the AWS SDK, uses the main-process `fetch`). Pure helpers `r2Endpoint` / `r2KeyFor` (unit-tested, 4 cases); `makeR2` (url/head/get/put/list) and `testR2` (lists one object to verify creds + bucket).
- **Credentials** — non-secret config (account id / endpoint / bucket / prefix) in `userData/config.json`; the **access key + secret are encrypted with Electron `safeStorage`** (OS keychain) and are **write-only across IPC** (never returned to the renderer).
- **IPC** — `settings:get-r2` (config + `hasCreds`, no secret), `settings:set-r2` (save config; update creds only when both supplied), `settings:test-r2`.
- **Settings UI** — an "R2 (cloud storage)" section: account id, bucket (default `ppt-archive-media`), key prefix (default `slidewell`), optional endpoint, S3 access key + secret (write-only, placeholder shows "saved"), **Save** + **Test connection** with a status line.

**Verified**: `npm run build` green; 21/21 vitest (incl. the new `r2.test.ts`); per-project `tsc` shows only the pre-existing `well.ts:108` + web `TS6307` baselines. Live connection test is the in-app button against the real `ppt-archive-media` bucket (creds from BWS; not pulled here).

Next increments: per-store backend toggle + read-through cache; write path + sync; `well.db` versioned backup.

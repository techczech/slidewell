---
title: "Performance follow-ups from the 2026-10-01 review"
id: performance-review-2026-10
date: 2026-10-01
type: backlog
status: proposed
priority: medium
tags: [performance, search, triage, thumbnails, sqlite]
refs: [keep-from-raycast-and-local-descriptions]
---

# Performance follow-ups (2026-10-01 review)

Read-only review findings not fixed in `keep-from-raycast-and-local-descriptions` (inbox watcher,
stale triage rows and triage double-OCR were fixed there). Ranked by impact.

1. **Deck-meta cache thrash with library = all** — `deckmeta.ts`: one memo + one cache file shared by
   both stores, so alternating mine/others re-parses every `presentation.json` on each search. Key by root.
2. **N+1 sqlite3 spawns in image search** — `archive.ts` `searchImages`: one `COUNT(DISTINCT …)` process
   per row (up to 120 per keystroke). One `GROUP BY sha256 … IN (…)` query instead.
3. **Thumbnails serve full-size originals** — grids decode full Retina PNGs; `swthumb://` is registered
   but unhandled. Serve sharp-resized WebP thumbs cached by hash.
4. **Triage scan is serial, one spawn per row** — bounded pool (3–4) for hash + OCR; batch inserts in
   transactions.
5. **Every triage keypress re-runs the main search** behind the panel (`onChanged` → refresh). Refresh
   only after import/paste or on close.
6. **Config re-read synchronously on every `swarchive` request** — cache config in memory, invalidate
   in `writeConfig`.
7. **Well writes are 4–5 spawns per image; vault scan is N+1** — single-transaction upsert; load ids once.
8. **`ensureTriage` on every decision** — memoise per well root.
9. **Search stages awaited serially** — `Promise.all` mine/others/well; FTS index for `ocr_assets`
   (currently `LIKE '%t%'`).
10. **Swift OCR fallback recompiles per image** — `swiftc` once into userData.
11. **Triage bulk actions** — "exclude all undecided in view / older than N days"; debounced folder watch.

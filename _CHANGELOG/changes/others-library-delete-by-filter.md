---
title: "Others' Library: delete-by-filter + stale-cache and owner-filter fixes"
id: others-library-delete-by-filter
date: 2026-06-23
type: change
status: shipped
tags: [others-library, delete, purge, filter, search, cache, bug, adr-0031]
---

# Others' Library: delete-by-filter + stale-cache and owner-filter fixes

A single **Delete** that removes whatever the current filter/search selects (ADR-0031), replacing separate clear-all + per-author purge. Filter to an author → delete their decks; search a term → delete those; no filter → delete the whole library.

- **`🗑 Delete matching…`** appears in the Others' Library view (`library = Others`). It resolves the matching deck set (deck-level filters via `listDecks`, narrowed by free-text), shows an OS confirm with the real count, deletes those decks' `extracted/` folders, then **rebuilds the index** from what remains (`runIngest` `reindex` mode). Scoped to the Others' Library only — never the personal archive or the original files.
- **Fix — stale deck-meta cache:** `loadDeckMeta` held a process-lifetime in-memory memo that mtime-invalidation can't bust on DELETE (removing a deck bumps no mtime), so deletes (and imports) wouldn't show until an app restart. Added `invalidateDeckMeta()`, called after every import/delete.
- **Fix — owner × library:** querying the others store with the default `owner: 'mine'` excluded every others deck (`ownership: others`) → empty results. Owner is now neutralized to `all` for others-store queries (author is the lens there, per the grill).

**Verified**: 2-deck others store, delete one by filter → the deck is gone from `extracted/` + registry and the survivor's 48 slides remain searchable.

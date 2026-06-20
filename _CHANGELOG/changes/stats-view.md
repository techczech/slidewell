---
title: "Stats view: PowerPoint Through the Ages (Raycast stats, native)"
id: stats-view
date: 2026-06-20
type: change
status: shipped
tags: [stats, timeline, analytics]
---

# Stats view

A 📊 Stats button opens a "PowerPoint Through the Ages" panel replicating the Raycast stats command, rendered natively.

- **`src/main/stats.ts`** — the Raycast stats engine ported verbatim (computation only): year/seasonality/size/category aggregation, distinct-talk clustering (same normalised title ± slide tolerance), date-confidence (bulk re-save segregation), master/library-deck exclusion, superlatives, and the lifetime-slides-shown headline. `archiveStats` builds `StatsDeck[]` from the deck index (ownership=mine, like Raycast) + content slide counts + the images.db image count.
- **Native rendering**: headline totals, lifetime fun-fact, decks/slides-per-year bars, seasonality, size buckets, top-categories + busiest-months tables, superlatives, and most-duplicated talks — as HTML bars/tables (not monospace markdown).
- `DeckMeta` regained `created`/`modified` (cache v2) so the date-confidence heuristic works.

Verified (`npm run test:smoke`): the panel opens and renders year bars (statsOk); all prior features green.

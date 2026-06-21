---
title: "Triage: keep 6-up grid when grouping by date + add pagination"
id: triage-group-grid-and-pagination
date: 2026-06-21
type: change
status: shipped
tags: [triage, ui, grid, pagination, adr-0029]
refs: [triage-grid-fit-keys-date-sort]
---

# Triage grid columns under grouping + pagination

- **Group-by-date collapsed to a 1-column list.** The grid used `repeat(6, 1fr)`, and `1fr` is `minmax(auto, 1fr)` — the tracks can't shrink below each card's content (a long nowrap filename), so at the real window width six tracks overflowed and the layout fell back to one wide column. Fixed with **`repeat(6, minmax(0, 1fr))`** + `min-width: 0` on `.triage-card`, so it's always six equal, shrinkable columns (a diagnostic showed it was already 6-up at a wide window — the bug only bit at narrower widths). Now identical in flat and grouped modes.
- **Pagination.** `listTriage` gained `limit`/`offset`; the panel pages 150 at a time with a Prev / Next footer (range + total), `[` / `]` shortcuts, and auto-scroll-to-top + selection reset on page change. A filter/search/sort change resets to page 1. Needed for the 8k-screenshot folder — the grid no longer tries to mount hundreds of full-res images at once.

Verified: `e2e/triage.mjs` now asserts the grouped grid keeps **6 column tracks** (`groupCols === 6`) alongside the card-height guard; full flow + smoke green. Reinstalled to `/Applications/SlideWell.app`.

---
title: "Triage grid: no-crop 6-up tiles, select/unselect keys, date sort + grouping"
id: triage-grid-fit-keys-date-sort
date: 2026-06-21
type: change
status: shipped
tags: [triage, ui, keyboard, grid, sort, adr-0029]
refs: [screenshot-video-triage]
---

# Triage grid fit + keys + date sort

Feedback after first use of the Triage screen.

- **No cropping, uniform tiles.** Thumbnails were `object-fit: cover`, slicing wide screenshots into thin strips. Now `contain` on a letterboxed tile — the whole image shows, every tile the same size. Grid is a fixed **6 across** (`repeat(6, 1fr)`).
- **Keys remapped** to a select/keep flow: **Space** = select (keep → include), **U** = unselect (reset), **X** = exclude, **⌘Y** = see full (preview), Enter also previews, **←→** move, **↑↓** move a row (±6), **⌘V** paste. Decisions now update the card **in place** (badge changes, grid doesn't reshuffle) so a just-selected item stays visible to unselect.
- **Sort + group by date.** A sort control (Recently scanned · Date newest · Date oldest) ordered by file mtime (capture time), and a **Group by date** toggle that buckets the grid under sticky day headers. `listTriage` gained a `sort` param; `TriageItem` carries `mtime` + `date` (YYYY-MM-DD).

Verified: `e2e/triage.mjs` extended — fixtures get distinct mtimes and the test asserts `date` is populated and date-asc/desc order flips (`datesOk`, `dateSortFlips`); full flow + smoke green. Reinstalled to `/Applications/SlideWell.app`.

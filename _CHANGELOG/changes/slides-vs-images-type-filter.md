---
title: "Type filter: Slides vs Images (find the picture, not the slide)"
id: slides-vs-images-type-filter
date: 2026-06-19
type: change
status: shipped
tags: [filters, images, search, type]
---

# Type filter: Slides vs Images

A **Type** control (Slides | Images) separates whole slides from the pictures embedded in them.

- **Slides** (default): whole-slide results, as before.
- **Images**: the images *extracted from* decks (media.db, tagged **IMG**) **plus** the well's images (**WELL**) — as standalone cards, so you can find a specific picture independent of the slide it sits on. `searchImages` now browses (most-text-first) when there's no query, not just LIKE-on-tokens.

Crosses with the existing **Source** scope (All/Archive/Well): e.g. Type=Images + Source=Well = just your stashed/added images. Image cards carry the right actions (copy WebP/PNG, copy OCR text, copy `r2://` / `img-` reference, reveal, see-in-context for archive images); copy-structure is hidden (not a slide).

**Verified** (`npm run test:smoke`): Type=Images returns 180 cards (120 archive IMG + 60 well WELL); Slides view unchanged (46 grouped). Build clean. (Fixed a converter that read the wrong ImageHit fields and silently dropped archive images.)

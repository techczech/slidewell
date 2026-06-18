---
title: "Full search surface: filters, actions, clustering, lightbox"
id: search-filters-actions-clustering
date: 2026-06-19
type: change
status: shipped
tags: [search, filters, clustering, actions, lightbox, raycast-parity]
---

# Full search surface: filters, actions, clustering, lightbox

Reimplemented the Raycast slide-search feature set as a proper desktop surface — with **separate** filter controls instead of Raycast's single combined `searchBarAccessory` dropdown (that was a Raycast limitation, not a design choice).

**Ported (faithful) from `raycast-slide-search`:**
- `src/main/deckmeta.ts` — per-deck metadata (date / title / filename / ownership / category) read from each `presentation.json`, cached on disk and mtime-invalidated (ownership.py + category.py + datemeta.ts ports).
- `src/main/searchlib.ts` — query-token parsing (`year:`/`after:`/`before:`/`deck:`/`cat:`/`owner:`), date/owner/category filtering, and near-identical clustering (exact normalised text + Jaccard ≥ 0.9).
- `searchArchive()` orchestrates parse → FTS → deck-meta filter → enrich → cluster.

**Filters** (own controls in a filter bar): Owner (My decks / All owners / Other authors / Unattributed), Date (All / 2023–present / 2017–2022 / pre-2017 / individual years), Category (dynamic, with counts), Slides (content-only / incl. structural), and a Group-near-identical toggle. Power tokens still work in the search box and AND with the bar.

**Actions** (right-click or ⋯ on any result): Open full size (lightbox), Copy image (WebP→PNG so it pastes anywhere), Copy text, Copy structure (the slide's `presentation.json` node as JSON), Copy reference (`[use: ppt:…]`), Reveal in Finder, Expand cluster, Show details (metadata panel).

**Grouping**: near-identical slides collapse into one card with a "▸ N near-identical in M decks" badge; Expand opens the members; the flat list is one toggle away.

**Lightbox**: click a thumbnail → full-size render with ←/→ navigation and Esc.

**Verified** (`npm run test:smoke`): "dyslexia" → 60 raw hits collapse to 46 grouped (10 cluster badges); 4 filter selects + toggle present; action menu lists all 8 actions; lightbox opens; changing the Date filter re-runs the query. Build clean (tsc + electron-vite). Image-search-FTS upgrade and Quick Look remain on the list.

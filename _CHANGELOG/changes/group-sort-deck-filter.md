---
title: "Group by presentation, nested sort, and a Deck filter"
id: group-sort-deck-filter
date: 2026-06-20
type: change
status: shipped
tags: [grouping, sort, deck-filter, browse]
---

# Group by presentation, nested sort, and a Deck filter

- **Group by presentation** (toggle): results render as per-deck sections (sticky deck-title + date + slide count headers). Nested sort: groups order by the chosen Sort key, slides **within** a group always order by slide number.
- **Sort** (control): Newest / Oldest / Title A–Z. Applies to the flat grid, or to the group order when grouped. Pure re-render (no re-query).
- **Deck filter**: a searchable Deck picker (all decks, newest-first) that scopes results to a presentation by name — the UI form of the `deck:` token, ANDed with any typed `deck:` and the other filters. Works for slides and images.
- The lightbox steps through whatever is shown, in the grouped/sorted order.

Verified (`npm run test:smoke`): grouping produces per-deck sections; sort-by-title re-renders cleanly; deck picker present; filter bar intact (4 selects + Category/Deck searchable + scope/type/toggles); images (180) and all prior features green.

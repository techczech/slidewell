---
title: "Default browse (newest-first), searchable Category, see-in-context"
id: browse-searchable-category-context
date: 2026-06-19
type: change
status: shipped
tags: [browse, filters, category, deck-context, ux]
---

# Default browse (newest-first), searchable Category, see-in-context

Three search-UX requests, shipped together.

- **Default browse, newest-first** — no query needed. `archiveResults()` branches: ≥2 chars of free text → FTS search; otherwise `browseArchive()` lists slides filtered by Date/Category/Owner/Slides, **newest deck first**. Picking a year or category with no query now shows *all* matching slides (not a "type to search" prompt). Verified: launch shows 221 newest slides; a query narrows to its results.
- **Searchable Category** — the Category filter is now a filterable combobox (type to narrow the category list with counts), not a fixed native dropdown.
- **See in context (whole deck)** — a new per-result action + `archive:deck-slides` IPC opens every slide of that presentation **in slide order** (numbered) in a modal; click any to open the lightbox.

Verified (`npm run test:smoke`): default browse 221 slides; searchable Category present; "See in context" in the 10-action menu; search → 46 grouped ("Dyslexia simulation"); lightbox + filter re-run green. Build clean.

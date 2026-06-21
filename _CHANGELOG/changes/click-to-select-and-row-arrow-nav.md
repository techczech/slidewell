---
title: "Click selects (double-click opens); ↑/↓ move by a grid row"
id: click-to-select-and-row-arrow-nav
date: 2026-06-21
type: change
status: shipped
tags: [grid, keyboard, navigation, lightbox]
refs: [keyboard-inspector-palette]
---

# Click-to-select + row-wise arrow navigation

Two grid-interaction fixes.

- **A single click now only selects a slide.** Previously clicking a card's thumbnail launched the slideshow immediately. The thumbnail no longer opens on a single click; the card selects on click and opens full size on **double-click** (an "extra click"), matching the keyboard path (Enter) and the palette/menu "Open full size" action.
- **↑/↓ move by a visual row, not by one item.** Both pairs of arrows behaved like ←/→. ←/→ now step one card; ↑/↓ jump a whole row. `moveByRow()` reads the live card geometry (`getBoundingClientRect`), so it respects the current column count and crosses presentation-group boundaries naturally, picking the card on the adjacent row whose horizontal centre is nearest.
- While the lightbox is open it owns ←/→ (its own listener); the global movement keys (←/→/↑/↓, Enter) are now gated on `!lightbox` so they no longer move the hidden grid behind the slideshow.

Help overlay updated (← → "Previous / next", ↑ ↓ "Up / down a row", Enter · dbl-click "Open full size").

Verified (Playwright): new `clickSelectsOk` (single click selects, no lightbox; double-click opens) and `rowNavOk` (→ steps by 1, ↓ jumps a full row) both pass; full smoke green. Rebuilt and reinstalled to `/Applications/SlideWell.app`.

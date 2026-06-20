---
title: "Keyboard layer: selection, ⌘K palette, inspector sidebar, titlebar actions"
id: keyboard-inspector-palette
date: 2026-06-20
type: change
status: shipped
tags: [keyboard, command-palette, inspector, sidebar, ux]
---

# Keyboard layer + unified inspector + ⌘K palette

A full keyboard layer over the gallery, plus a unified metadata sidebar for slides/images/decks.

- **Selection + arrow navigation**: ←/→/↑/↓ move a highlighted selection across the grid (scrolls into view); Enter opens it full size (decks: opens the deck). Clicking a card selects it.
- **Inspector sidebar (I / Space)**: a metadata sidebar that **follows the selection** — arrow through slides with it open and it updates live. Unified across slides/images (deck, file, slide #, date, category, used-in-decks, kind, reference, preview + copy/reveal/in-context actions) and decks (the existing deck sidebar). Sits below the titlebar so the titlebar actions stay clickable.
- **⌘K command palette**: Raycast-style — opens the action list for the current selection, type to filter, ↑/↓ + Enter to run (open full size, copy image/PNG/text/structure/reference, reveal, see-in-context, inspector).
- **Shortcuts for everything**: `/`·⌘F focus search; `1·2·3` Slides/Images/Decks; `G` group-by-presentation; `C` cluster; `S` stats; `O` import; `Esc` closes the topmost overlay; `?` shows the keyboard-help overlay.
- **Titlebar actions**: moved Stats / Import (+ a ⌨ help button) into the titlebar, freeing the filter-bar row.
- **Role = Incl. structural** includes title/opening slides (the content-role clause is dropped) — confirmed.

Verified (`npm run test:smoke`): selection, inspector, ⌘K palette, help overlay, role-all, titlebar buttons, and all prior features green.

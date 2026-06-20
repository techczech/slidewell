---
title: "Fix inspector asset off-by-one; ⌘K over lightbox; palette shortcuts; group siblings"
id: inspector-assets-offbyone-palette-shortcuts
date: 2026-06-20
type: change
status: shipped
tags: [inspector, image-assets, command-palette, keyboard, lightbox, grouping]
refs: [inspector-json-and-assets, keyboard-inspector-palette]
---

# Inspector/palette fixes (off-by-one, lightbox ⌘K, shortcuts, group siblings)

Four reported issues, all shipped together.

- **Image assets showed the previous slide.** `image_locations.slide_order` is offset from `slide_locations.slide_order` and the base is inconsistent across decks, so resolving assets by location drifted by one. `slideImages()` now walks the slide's **own presentation.json node** (the same node `slideStructure()` serialises as the inspector JSON), collecting `type === 'image'` `src` values and resolving them under `extracted/<deck>/`. Assets can no longer drift from the displayed JSON.
- **⌘K in the slideshow targeted the grid selection, not the image on screen.** Introduced a single lightbox-aware `activeItem` (= `lightbox.list[index]` when the slideshow is open, else the grid selection). The palette, ⌘C/⌘⇧C, and the letter shortcuts all act on `activeItem`; ⌘K now also opens *over* the lightbox, and "See in context" closes the lightbox first.
- **Palette actions now list their keyboard shortcuts** (↵, I, ⌘C, ⌘⇧C, T, J, R, F, X), wired as real global keys and mirrored in the help overlay. ⌘C copies WebP (TalkWeaver), ⌘⇧C copies PNG; ⌘C yields to a live text selection so native copy still works in the JSON block.
- **Group siblings in the inspector.** When grouping by presentation, the inspector shows the other slides of that group as a clickable 16:9 thumbnail strip (click to jump). Sidebar widened 320 → 420 px.

Verified (Playwright): full smoke green; `paletteOk` now requires shortcut chips, new `lightboxPaletteOk` gates ⌘K-over-lightbox. Rebuilt and reinstalled to `/Applications/SlideWell.app`.

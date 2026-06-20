---
title: "Slide inspector shows full JSON + related image assets"
id: inspector-json-and-assets
date: 2026-06-20
type: change
status: shipped
tags: [inspector, json, image-assets, sidebar]
---

# Slide inspector: full JSON + related image assets

For a selected slide, the inspector sidebar now shows the slide's **full structured JSON** (its presentation.json node) in a scrollable block, plus a thumbnail row of the **image assets embedded on that slide**.

- `archive.slideImages(deck, slideOrder)` (new) → embedded images from images.db `image_locations`, resolved to files; `imagePath` gained a content-addressed `media-store/<sha>.<ext>` probe (tries common extensions) so assets resolve even when the original filename/ext is missing.
- `SlideInspector` fetches the JSON (`slideStructure`) and assets on selection and renders them; image-kind items still show their OCR text.

Verified (Playwright): selecting a slide and opening the inspector renders ~600 chars of JSON and 2 asset thumbnails; full smoke green.

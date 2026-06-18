---
title: "The image well (added images + auto-enrichment)"
id: image-well-added-images
date: 2026-06-18
type: backlog
status: proposed
priority: high
tags: [well, image-node, enrichment, ocr, embeddings]
---

# The image well (added images + auto-enrichment)

Let the user add net-new images (`provenance=added`) the well is authoritative for: paste, drag-drop, and screenshot capture. On add, auto-enrich via Core A — OCR (macOS Vision), AI description + tags, and embedding — so the image is instantly findable. Store as Image Nodes named `{slug}--{hash}.ext` with a sidecar (`alt`, `caption`, `source`, `tags`, `notes`, `provenance`). No folders: organisation is tags + search only. Enrichment defaults to local AI (MLX / LM Studio) for privacy; cloud is opt-in. See CONTEXT.md `Added image`, ADR-0020/0026.

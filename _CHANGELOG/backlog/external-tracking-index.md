---
title: "External tracking index (lineage, drift, versioning)"
id: external-tracking-index
date: 2026-06-18
type: backlog
status: proposed
priority: medium
tags: [adr-0026, hashing, lineage, versioning]
---

# External tracking index (lineage, drift, versioning)

Implement the ADR-0026 tracking layer: a lightweight, approximate, git-referenced index over every slide SlideWell sees — `{slide_id, full_hash, partial_hash, source_file, last_seen_commit, image_node_ids[]}`. Full hash for dedup; partial/locality-sensitive hash (SimHash/MinHash over normalised text + structure) for drift and `{#id}`-recovery; image-node ids so image swaps register as drift. Lineage edges recorded authoritatively at reuse time, inferred from partial-hash similarity otherwise. Reference git commits (don't re-derive exhaustively); mismatches acceptable. Off the deterministic build path (ADR-0023). Provenance never written back to the Outline.

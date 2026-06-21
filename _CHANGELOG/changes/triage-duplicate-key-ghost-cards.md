---
title: "Triage: fix ghost cards from duplicate-content React keys"
id: triage-duplicate-key-ghost-cards
date: 2026-06-21
type: change
status: shipped
tags: [triage, react, bug, duplicates, adr-0029]
refs: [triage-group-grid-and-pagination]
---

# Triage ghost cards (duplicate content → colliding React keys)

A few cards rendered full-width / out of order and didn't respond to Select/Exclude. Cause: the grid keyed cards by `it.hash` — the **content** hash — but a screenshots folder has byte-identical duplicates, so two files produced the same hash and therefore the same React `key`. React can't reconcile colliding keys: it keeps stale/ghost nodes that paint in the wrong place and whose click handlers are detached.

- Added a unique-per-file `relPath` to the wire `TriageItem` and key the grid by it (`key={it.relPath}`) in both flat and grouped renders. The content `hash` stays the **decision** key, so byte-identical files still share an include/exclude decision (intended).
- Made the group-by-date sticky header `top: 0` (was `-1rem`, which could clip the first group's header so its cards looked headerless).

Verified: `e2e/triage.mjs` now seeds a duplicate (`two.png` == `dup.png`, same bytes) and asserts 3 distinct files → **3 cards** with **2 distinct hashes** (the collision would have rendered 2), plus that excluding one duplicate excludes both (`excludedCount === 2`, shared decision). Full flow + smoke green. Reinstalled to `/Applications/SlideWell.app`.

Note: this is a per-running-instance render bug — a rebuild doesn't update an already-open app, so a full relaunch (⌘Q) is needed to pick it up.

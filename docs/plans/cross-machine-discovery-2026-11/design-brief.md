---
title: Cross-machine discovery — design brief
date: 2026-11-17
register: FOR AGENTS
status: exploration; no design locked
authority: Dominik, 2026-11-17 08:25; research and design only
---

# Purpose and scope

Let Dominik find and reuse old slides, images and related text from a small-disk MacBook Air. Keep bulk originals and embedding execution on a personal library host. Compare architectures and three discovery directions. No app implementation, deployments or network configuration. Requested report is the review artefact; do not stop for preliminary design approval or claim a lock.

# Commitments

- C1: The Air does not need the complete archive or models.
- C2: Each hit retains provenance, library scope and available reuse actions.
- C3: Offline availability is explicit. Selected material becomes local before insertion is reported complete.
- C4: Suggestions never insert, overwrite or reorganise anything automatically.
- C5: Groups are reversible views, tags or saved searches; never new storage folders.
- C6: Personal and Oxford material remain in separate authority boundaries.

# Proposed journeys and screen contracts

Viewer throughout: Dominik preparing a talk on the Air; already knows the topic and remembers fragments of past talks. Mock content is invented demonstration data, never a claim about the actual corpus.

## A — Find across the library

- Surface: dedicated window, results left (~70%), provenance/detail right (~30%).
- Purpose: find a usable slide or picture from remembered words, meaning or a seed image.
- Arrival: search across the library; expects slides, images and optional related text.
- Sees: identity and library connection in title bar; one combined search/mode toolbar; results; inspector with source and availability.
- Steps: choose Words / Meaning / Picture; query; select result; More like this; save for offline or prepare reuse; inspector shows completion.
- States: results, empty, loading, host unavailable, cached-only, denied scope, download in progress, ready.
- Right when: a chosen item is pinned locally with its source, and can be reused without downloading the archive.
- Extras: connection/model setup in Settings, not primary chrome. Sharing is a separate explicit action.

## B — Find while writing

- Surface: TalkWeaver docked panel at the cursor, Outline work area left; no autonomous editing.
- Purpose: suggest relevant existing slides and images while Dominik drafts a slide.
- Arrival: an unsaved or saved slide in a local Outline; expects suggestions relevant to the selected slide, not every keystroke.
- Sees: local Outline; related-material panel; why each suggestion appears; source, variants and insertion action.
- Steps: select slide; request/enable suggestions; select candidate; preview provenance; insert materialised copy at cursor; undo is available.
- States: suggestions, paused, none, stale request, host offline, asset downloading, inserted, source changed.
- Right when: one chosen slide/image is materialised locally, inserted once, and the Outline stays canonical.
- Extras: preferences in Settings; no chat input, no permanent help block.

## C — Rediscover in groups

- Surface: dedicated window with thematic lanes / contact sheets and a comparison area; different geometry from A.
- Purpose: rediscover related material across years, duplicates and variants without filing it into folders.
- Arrival: uncertain what to search for; expects themes, dates and source decks.
- Sees: suggested groups, representative slide/image thumbnails, counts and source context.
- Steps: open theme; expand variants; compare; name a saved search or add a tag; pin selected material for a talk.
- States: overview, expanded group, comparison, ungrouped, offline cached groups, uncertain similarity.
- Right when: a useful group can be revisited as a saved view and selected material is pinned, with no files moved.
- Extras: inferred group labels are suggestions; membership does not rewrite human tags.

# Mockup and packaging contract

Use exploration/code-approaches + exploration/visual-designs pattern: visible alternatives with trade-offs and real click-through state. Self-contained final report, all copy canonical in Markdown (inline HTML allowed), separate CSS/JS, packaged at build. Three directions differ in geometry and task sequence. Blue, warm paper, grey, teal and restrained amber permitted; no purple or pink. Application panels, bounded regions, at most two top bars, keyboard-accessible native controls, no external fonts/CDNs or network calls. Large named direction badge. Cards use invented miniature slide designs, not private source content. Partial design explorations; no production keyboard or settings completeness claim.

# Authority corrections already found

ADR-0032 is the accepted Slide Ledger decision, not an R2 decision. It amends ADR-0026: Vault `_SLIDE-VERSIONS/` stores authoritative history; SlideWell indexes it. Outline IDs are `{id=…}`. Do not carry the stale RESUME description into a proposed design.

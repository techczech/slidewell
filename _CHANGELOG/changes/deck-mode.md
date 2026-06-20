---
title: "Deck mode: browse presentations by title slide + metadata sidebar"
id: deck-mode
date: 2026-06-20
type: change
status: shipped
tags: [deck-mode, browse, sidebar, metadata]
---

# Deck mode: browse presentations by title slide

A third Type — **Decks** — beside Slides and Images. Shows one card per presentation using its **title-slide render** (slide 0; these exist as renders even though they're filtered out of *content* search as opening slides). Honours the same Date / Owner / Category / Deck filters and the Sort control.

Clicking a deck opens a **metadata sidebar**: date (+ source), folder/category, filename, slide count, section count, owner, source path — with **See all slides** (jumps to that deck's slides in order via the see-in-context filter) and **Reveal in Finder**.

Backend: `listDecks` (deck cards + slide counts via one GROUP BY) and `deckDetail` (reads the deck's presentation.json for section/slide counts). Verified (`npm run test:smoke`): deck cards render and the sidebar opens; all prior features green.

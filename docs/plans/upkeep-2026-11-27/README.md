---
title: SlideWell upkeep tickets, 27 November 2026
register: FOR AGENTS
date: 2026-11-27
---

# SlideWell upkeep tickets, 27 November 2026

The source baseline is `d9df3f4`. The pass covers the new Air finder, Triage placeholder reconciliation and capture-folder refusal. Each branch starts from `origin/main`. Use synthetic data in disposable profiles.

- [01 — Separate Triage scanning from decisions and import](tickets/01-separate-triage-scanning.md)
- [02 — Exercise capture-folder refusal through the app](tickets/02-capture-folder-refusal-journey.md)
- [03 — Follow a staged placeholder into the well](tickets/03-placeholder-promotion.md)
- [04 — Refuse an unverified finder download](tickets/04-finder-download-verification.md)

## Test consolidation

After the capture-folder journey exercises both storage aliases, drop the parameterised fake-IPC test that adds those same aliases in `capture-rescan.test.ts`. The hidden app journey can observe the warning and read back the watched folders through the actual preload and Settings store. Keep the fake-IPC cases for the separate primary-folder and replacement handlers. Keep the CLI store test for `capture.triageRoot`, which reaches the write rule through a different route.

The Air finder browser journey already covers layout, Words, Meaning, Related, preview, verified download and offline feedback. Keep the HTTP tests for catalogue scope, stale references, source identity and launch configuration. Those cover refusals and lifecycle paths the browser journey does not cross. Preview and catalogue-worker changes are under review in [PR 32](https://github.com/techczech/slidewell/pull/32).

## Owner decision

Should capture sources overlapping storage be refused when a watched folder contains a library root, is inside a library root, or becomes the same folder after a library move? The current rule rejects a new selection that resolves to the well or archive root itself. It intentionally leaves prior configurations usable and permits some nested paths. Changing that policy could stop valid watched folders. Leave product behaviour alone until the intended rule is settled.

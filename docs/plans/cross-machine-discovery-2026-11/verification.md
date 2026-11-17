---
title: Verification record
date: 2026-11-17
register: FOR AGENTS
status: report checks passed; app build not run
---

### Actual verification

- **Packaged report:** Python-Markdown build succeeded; strict single-HTML audit reports no structural blockers or warnings. No external scripts, styles, fonts, runtime data fetches or adjacent assets. External links are citations only. Final file is about 0.14 MB.
- **Source round trip:** changed one recommendation phrase in `report.md`, rebuilt and confirmed it appeared in HTML, restored the source and confirmed a byte-identical rebuild. Markdown drives the output; it is not a detached export.
- **Browser journeys:** `verify-report.cjs` passed from `file://` in bundled headless Chromium at 1280, 728 and 390 CSS pixels. Words/Meaning/Picture mode, selection, related view, empty result, denied scope, host-offline state, pin/preparation, materialise → offline insert → undo, pause, group expansion, variant comparison, saved search, pinning and resets were exercised. No page JavaScript errors and no HTTP(S) resource requests occurred.
- **Visual inspection:** inspected actual captures of all three directions at desktop and phone widths. Fixed long-hash page overflow, mobile thumbnail overlap in A and clipped theme previews in C. Re-ran browser checks after repairs. Screenshots were confirming scratch and removed after inspection; the clickable HTML is the retained design artefact.
- **Browser availability change:** a later default launch failed because expected headless-shell revision 1223 was no longer in the cache. The cache then held revision 1228; the final check selected that existing headless test binary explicitly. No browser download or configuration change was made. Earlier successful checks and this launch failure are distinct outcomes.
- **Scoring:** two fresh same-model seats; every criterion and option scored. Weighted arithmetic independently recomputed. No owner acceptance, quality benchmark, cost measurement or iterative optimisation implied.
- **Application build — NOT RUN:** requested `agent-run --scope changed --timeout 300 --wait 30 -- npm run build`. Runner returned **75**, `NOT RUN: machine busy`, while another TalkWeaver verification held the shared slot. No bypass or retry. This is an execution limit, not a product failure or a passing build. No application source changed, no app launched, installed or released by this task.

Research and design deliverables are verified at the report level. App/runtime compatibility, real remote retrieval quality/latency, full library equality, Mini serving readiness, Cloudflare origin authorisation and production offline/retry guarantees remain build gates. Mockups simulate those behaviours with invented material.

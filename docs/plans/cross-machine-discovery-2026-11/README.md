---
title: Cross-machine discovery report sources
date: 2026-11-17
register: FOR AGENTS
status: research and design only
---

# Rebuild

From the SlideWell repository root:

```sh
python3 docs/plans/cross-machine-discovery-2026-11/build-report.py
```

Requires Python 3 and Python-Markdown (already available on the authoring machine). No application dependencies or network required. `report.html` is the single delivered page. `report.md` is the main narrative source, `scores.md` the score summary, and `direction-{a,b,c}.md` the canonical mockup copy. Inline HTML in Markdown supplies the app frames. CSS and JavaScript are separate author-time sources and embedded by the builder. No adjacent file is fetched at runtime.

# Records

- `design-brief.md`: authority, journeys, screen contracts and commitments before mockups; no design lock.
- `architecture-options.md`: neutral options, estimates, observed facts and fixed rubric before judges.
- `judge-one.md`, `judge-two.md`: independent same-model seats, reasons and objections.
- `source-manifest.json`: repository heads and hashes of selected source files; not a completeness claim.
- `research/`: Scout evidence capture, aggregate measurements and provenance only.
- `verification.md`: actual checks, report/source rebuild proof and limits.

User authorised docs-only commit/push to main. Repository is public: exclude personal corpus excerpts, credentials, Tailscale addresses, private settings and unrelated operational records. No app change or service deployment is included. Report registration uses the existing ReportScout service; no new server is started.

ReportScout registration names `report.md` as the main editable source. Edits targeting the other Markdown fragments are kept aside by ReportScout for an agent to reconcile; do not promise automatic writes into those files. Read `report-scout feedback <report.html>` and reread sources before regenerating a future revision.

The browser verifier requires this repository's existing Playwright dependency and its bundled headless Chromium. It starts no server. `node docs/plans/cross-machine-discovery-2026-11/verify-report.cjs` removes its scratch on completion. `--screenshots` retains captures temporarily in `.verification/` for visual inspection; remove that owned folder after inspection, never commit it.

If the local Playwright browser cache has been replaced since dependency installation, use an existing test browser explicitly with `REPORT_CHROMIUM=/absolute/path/to/chrome-headless-shell node docs/plans/cross-machine-discovery-2026-11/verify-report.cjs`. Never point this at the user's normal browser/profile. The final check used the already-installed headless-shell revision 1228 after expected revision 1223 disappeared from the cache during the session; no browser was downloaded.

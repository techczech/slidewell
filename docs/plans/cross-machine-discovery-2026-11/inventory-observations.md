---
title: Inventory observations, 17 November 2026
date: 2026-11-17
register: FOR AGENTS
kind: evidence
scope: aggregate metadata only; no corpus content or credentials
---

# Method

Approximately 08:28–08:46 UTC. Local source reads; app Info.plist versions; allowlisted library-path config fields; stat, du -sk; SQLite schemas/counts; bounded read-only SSH to personal Mini and Air. No network/configuration changes. Initial Air hostname resolution failed; existing Tailscale peer metadata supplied its current address and SSH then worked. Addresses omitted from this public artefact.

# Allocated space

Raw `du -sk` values; KiB, not bytes. Totals overlap nested files. External originals not measured.

| Machine | Path shorthand | KiB |
|---|---|---:|
| Pro | Core A extracted | 13612848 |
| Pro | Core A media-store | 1813476 |
| Pro | Core A registry | 215648 |
| Pro | SlideWell tree | 428016 |
| Pro | SlideWell models | 888992 |
| Pro | MediaWell data / models / vaults | 8660 / 6957636 / 1268 |
| Pro | Highlight Scout config/index tree | 351032 |
| Pro | All Scout indexes | 873580 |
| Pro | highlights archive / seed | 657648 / 231196 |
| Pro | Talk checkout / its Git metadata | 29547988 / 6452920 |
| Mini | Core A extracted / media-store / registry | 10507492 / 9983180 / 218916 |
| Mini | Talk checkout / SlideWell tree | 9668432 / 24 |
| Air | Talk checkout / SlideWell tree | 9583888 / 40 |

Available KiB from `df -k`: Mini external volume 672762104; Air system volume 9012980. Free space is volatile; do not treat it as a reserved budget.

# Index snapshots

- Pro slides.db: 120545280 bytes; 52030 slides, 1050 presentations. images.db: 27967488 bytes, 14700 image rows. media.db: 72306688 bytes.
- Pro picture-search.db: 319295488 bytes. Ordinary read-only open initially failed (SQLite side-file requirement); verified no WAL file existed, then used immutable/main-file reading without side writes. 76280 vectors: slide 61661, triage 12923, well-image 1696. Model `onnx-community/embeddinggemma-2-ONNX`, revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`, dim 768, normalised float32 LE. This is not a coverage percentage or current-visibility count.
- Scout vector main files: highlights 115757056 bytes; talks 102653952 bytes. WAL files existed; no immutable vector row counts inferred.
- Pro Highlight Scout path allowlist: current archive and seed locations as in report; `r2_enabled=false`. No credentials read.
- Mini default picture-search.db absent; slides.db 109813760 bytes. No content-equality claim.

# App presence

| Machine | SlideWell | TalkWeaver | Highlight Scout | MultiWell |
|---|---|---|---|---|
| Pro | 0.4.0-alpha.19 | 0.45.0-alpha.3 | 0.6.0-preview.13 | 0.4.0-alpha.11 |
| Mini | 0.3.0 | 0.42.0-alpha.19 | 0.5.4 | not found at checked names |
| Air | 0.3.0 | 0.45.1, running | 0.5.5 | not found at checked names |

No corresponding apps running on Mini in bounded process check. No conventional Core A on Air. Installed SlideWell/source parity unverified: checkout package 0.4.0-alpha.15. Shared Oxford Studio inspected through catalogue/runbook only. Mini T3 link reachable at observation; no library-service proof.

# Source and interpretation

Repository heads/file hashes: `source-manifest.json`. T3 source head `8760d063e903406c8e8f695b0852c0a15fc1e00f`, MIT copyright T3 Tools Inc. Runtime directory names 0.1.7–0.1.9 inspected. Accepted Slide Ledger ADR-0032 supersedes stale RESUME ownership/ID wording. No model inference, quality experiment, remote bucket inventory, full cross-Mac audit or full original-file size measurement performed.

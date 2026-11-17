---
title: Independent architecture scoring — judge one
date: 2026-11-17
register: FOR AGENTS
status: complete
mode: score
source: architecture-options.md
evaluation_order: [F, E, H]
independent_of_option_authorship: true
---

Judgement: **H first, 8.15/10**. E 6.50; F 6.40. E/F difference is too small to support a confident preference. Scores assess the proposed architectures against the frozen rubric; they are not measured product performance or implementation validation.

| Criterion | Weight | F: selective replicas | E: cloud read model | H: host service |
|---|---:|---:|---:|---:|
| Immediate useful Air discovery | 30% | 6 | 5 | 8 |
| Small Air footprint | 20% | 6 | 9 | 9 |
| Data authority and privacy fit | 25% | 7 | 6 | 9 |
| Seamless use and availability | 15% | 7 | 8 | 6 |
| Effort and reversibility | 10% | 6 | 5 | 8 |
| **Weighted overall** | **100%** | **6.40** | **6.50** | **8.15** |

### F — per-Mac selective replicas

- Immediate usefulness, 6: existing query engines help, but safe snapshots, manifests, demand fetching and Air model provisioning remain prerequisites; lexical packs provide narrower discovery.
- Air footprint, 6: selective stores avoid full originals, matching the rubric anchor, but local query models, vectors and multiple stores remain. Reported 8.6 GiB free makes the unmeasured working-set size material; the packet does not prove it will exceed that space.
- Authority/privacy, 7: single writer and snapshot distribution preserve ownership; distributing personal indexes/media through R2/Git/OneDrive still needs an explicit disclosure and access boundary, not specified here.
- Seamless availability, 7: local selected content survives host/network loss; freshness, demand-only originals and per-Mac model compatibility limit that benefit. Automatic routing and recovery are underspecified.
- Effort/reversibility, 6: sources and existing engines survive, but snapshot lifecycle, synchronisation and eviction become ongoing infrastructure on each Mac. The 10–18-hour estimate is not a demonstrated build result.

### E — cloud read model

- Immediate usefulness, 5: new publishing/serving infrastructure plus a compatible cloud query embedding runtime are prerequisites. Keeping separate vector spaces is sound, but does not itself make them queryable in cloud.
- Air footprint, 9: remote querying/media and small packs remove the need for a global Air corpus or model; cache bounds are proposed rather than tested.
- Authority/privacy, 6: canonical local writers remain clear, and generations expose staleness, but personal cloud publication requires owner consent and concrete access/retention rules. These are unresolved rather than implicit permission.
- Seamless availability, 8: a fully published generation could survive host sleep and serve across machines. Score is conditional on every serving dependency moving to cloud; publication lag and offline limitations preclude 9.
- Effort/reversibility, 5: originals remain recoverable, but several managed stores, a publisher and model-runtime decision add migration and consistency work before useful service. Neither costs nor the 18–30-hour estimate are validated.

### H — host service over current stores

- Immediate usefulness, 8: read adapters and one finder can exploit existing slide/picture indexes without Air corpus provisioning. Installed/source mismatch, unknown coverage and adapter compatibility prevent the rubric's near-ready 9.
- Air footprint, 9: remote search and media-by-ID support a bounded chosen cache without global vectors/models on Air; actual cache enforcement remains unproven.
- Authority/privacy, 9: existing writers remain authoritative; personal host, opt-in stores, private transport and approved-only share snapshots explicitly fit the stated boundaries. This is architectural fit, not a verified security implementation.
- Seamless availability, 6: stable identity and capabilities help, but host sleep, failed mounts and differing routes remain explicit constraints. A tunnel cannot restore a stopped search service.
- Effort/reversibility, 8: one incremental read facade preserves sources and permits staged clients. Host migration/reconciliation and several adapters still require work; the 6–10-hour finder estimate is not measured delivery evidence.

### Pairwise comparisons

- **H over F, +1.75**: H addresses the small Air and near-term discovery priorities without replicating query environments. F wins offline access to selected content. A demonstrated compact multimodal Air pack could narrow this gap; none is supplied.
- **H over E, +1.65**: H can reuse local indexed data and avoids cloud publication consent/runtime prerequisites. E wins host-independent published availability only after all query dependencies operate in cloud.
- **E versus F, +0.10**: effectively tied. E trades new cloud work and disclosure decisions for a smaller Air and published availability; F trades repeated local management for stronger offline use. This score difference should not decide that trade-off.

### Strongest objection to H

The remote experience fails precisely when the personal host sleeps or its archive volume is unavailable. The packet supplies no measured host uptime or evidence that Mini already has equivalent indexed coverage. If routine Air use occurs with Pro asleep and Mini not yet reconciled, H's apparently quick finder may not deliver dependable discovery; E's host-independent serving could outweigh its greater initial work.

### Evidence limits and assumptions

- Treat the packet's counts, versions and free-space figures as reported observations, not independently verified measurements. Row/vector counts do not prove current corpus coverage or retrieval relevance.
- All agent-hour ranges are estimates with differing stage boundaries and stated exclusions. Do not turn their ratios into measured productivity claims.
- H assumes existing stores can be safely and usefully queried through adapters despite installed/source mismatch; schema/runtime compatibility, read consistency and mount behaviour are not demonstrated.
- E assumes a compatible, affordable cloud query-model path. No supplied measurement establishes latency, retrieval quality, costs or a working query runtime.
- F assumes a useful combination of indexes, models, selected media and temporary snapshot space can fit Air's available disk. No pack-size or peak-space budget establishes that.
- No option has measured end-to-end latency, owner relevance judgement or demonstrated recovery. Scores above 6 for proposed benefits remain conditional, not acceptance evidence.

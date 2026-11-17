---
title: Independent architecture assessment — judge two
date: 2026-11-17
register: FOR AGENTS
status: assessment
source: architecture-options.md
evaluation_order: [E, H, F]
method: fixed-rubric-weighted-arithmetic
---

# Verdict

H leads: **8.15/10**. F: **6.30/10**. E: **6.25/10**. The F/E gap is negligible judgement noise; H's lead reflects the rubric's emphasis on immediate Air discovery, footprint and existing authority. These are architecture judgements, not measured implementation results or an owner decision.

Independent seat; did not author the options. Assessed only the supplied packet, in E, H, F order. No private corpus, code, network or performance validation.

# Scores

## E — Cloud read model

| Criterion | Weight | Score /10 | Reason |
|---|---:|---:|---|
| Immediate useful Air discovery | 30% | 5 | Compatible cloud query embedding, publication and lexical serving remain prerequisites; no demonstrated end-to-end query path. |
| Small Air footprint | 20% | 9 | Cloud serving needs no full Air corpus or query model; bounded selected packs fit the stated goal. |
| Data authority and privacy fit | 25% | 6 | Local canonical writers and versioned publication are clear, but personal-corpus cloud approval and publication scope remain unresolved. |
| Seamless use and availability | 15% | 7 | A complete cloud serving path could survive host sleep; model runtime, publication freshness and offline recovery are still design dependencies. |
| Effort and reversibility | 10% | 4 | Several new serving components and embedding compatibility work precede value; preserved canonical sources help rollback. |

Weighted overall: `5×0.30 + 9×0.20 + 6×0.25 + 7×0.15 + 4×0.10 = 6.25`.

## H — Host service over current stores

| Criterion | Weight | Score /10 | Reason |
|---|---:|---:|---|
| Immediate useful Air discovery | 30% | 8 | Read adapters can expose existing indexed data without relocating it first; installed/source parity and useful coverage are unproven, preventing a 9. |
| Small Air footprint | 20% | 9 | Host-side search and media-by-ID leave only a bounded chosen cache on Air. |
| Data authority and privacy fit | 25% | 9 | Existing writers retain authority, adapters are read-only, the host is personal, and extra stores are opt-in; boundaries are explicit at architecture level. |
| Seamless use and availability | 15% | 6 | Stable identity and scoped endpoints help client use, but Pro sleep and Mini mount/host readiness remain direct search outages; Cloudflare cannot remove them. |
| Effort and reversibility | 10% | 8 | Thin finder and adapters can deliver incrementally while preserving sources; heterogeneous stores and later desktop integrations still require real work. |

Weighted overall: `8×0.30 + 9×0.20 + 9×0.25 + 6×0.15 + 8×0.10 = 8.15`.

## F — Per-Mac selective replicas

| Criterion | Weight | Score /10 | Reason |
|---|---:|---:|---|
| Immediate useful Air discovery | 30% | 6 | Existing local queries are reusable, but consistent snapshots, model manifests and selection rules must work before the replicated corpus is trustworthy. |
| Small Air footprint | 20% | 5 | Selection limits media, but vectors, query models and multiple stores compete with only about 8.6 GiB free; no measured complete pack budget is supplied. |
| Data authority and privacy fit | 25% | 8 | A single writer and backup snapshots preserve canonical authority; distribution through the chosen sync service still needs explicit corpus scope and compatible generations. |
| Seamless use and availability | 15% | 6 | Local packs improve offline use, especially lexical retrieval, but freshness and model management repeat per Mac; offline multimodal capability is unspecified. |
| Effort and reversibility | 10% | 6 | Reusing queries helps, but WAL-safe snapshots, cache pinning and cross-store synchronisation are several new mechanisms; replicas remain disposable. |

Weighted overall: `6×0.30 + 5×0.20 + 8×0.25 + 6×0.15 + 6×0.10 = 6.30`.

# Pairwise assessment

- **H over E:** same small Air footprint, with fewer prerequisites for exposing existing slides and less personal content published into cloud stores. E has the stronger potential answer to host sleep, conditional on independent cloud query embedding and a complete published generation. If host-down access becomes the dominant requirement and cloud publication is approved, E deserves a fresh comparison.
- **H over F:** central adapters avoid fitting multiple query runtimes and corpus replicas onto the constrained Air and avoid repeating freshness management. F wins for selected offline browsing and lexical discovery. The packet does not establish that F can deliver useful offline multimodal retrieval within Air's available disk.
- **F versus E:** effectively tied under this rubric. F's authority fit and reuse offset E's smaller Air footprint and potential availability. There is insufficient evidence to rank their implementation outcomes confidently.

# Strongest objection to H

H makes remote discovery depend on a personal machine whose sustained availability is unverified. Pro is temporary; Mini has an older app and no picture-search DB at its default location. A web finder can work during a demonstration yet fail during drafting when the host sleeps or its volume is unavailable. Tailscale plus Cloudflare supplies routes, not a second working search host. If outages coincide with real Air use, H misses the central user need despite its rubric lead.

# Evidence limits and unsupported assumptions

- Packet-reported observations: installed versions, disk figures, store counts and vector dimensions. Not independently verified by this seat. Vector count does not prove current corpus coverage, accessible media or relevant results.
- All agent-hour ranges are estimates. No measured implementation velocity, query latency, result relevance, outage frequency or provider costs support numerical forecasts.
- H assumes safe concurrent read adapters, compatible query embedding and useful existing indexes can be exposed by a bounded build. Neither installed/source parity nor multi-store query behaviour has been demonstrated here.
- E's host-down benefit is conditional: compatible cloud query embedding, scoped approval, media publication and consistent serving generations must all exist. The packet does not demonstrate provider/model compatibility or production costs.
- F's small-footprint claim needs a byte budget covering indexes, query runtime/model, selected media and temporary update space. Available disk alone cannot establish fit; sync generation consistency and offline multimodal relevance remain untested.
- Rich related suggestions, grouping quality and seamless TalkWeaver integration are proposed outcomes in all three options, not validated capabilities. Separate vector spaces require evaluated fusion; matching dimensions alone would not establish compatibility.
- This seat has inherited workspace instructions and entry-point context. It has no previous judge scores or option-authoring history; it is not a completely empty-context model call. Same-model seat agreement remains weaker evidence than cross-family review.

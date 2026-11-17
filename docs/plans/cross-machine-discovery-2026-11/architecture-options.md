---
title: Architecture options and scoring packet
date: 2026-11-17
register: FOR AGENTS
status: proposal
---

# Authority and observed facts

Dominik wants remote personal slide/image/text discovery from Air, Tailscale plus Cloudflare, related suggestions during TalkWeaver drafting, groups without filing, no complete Air archive. Research/design only today. Outline remains canonical, Vault holds Slide Ledger; SlideWell owns well/extractions and heavy picture work. Oxford shared Studio cannot receive personal context. No live changes authorised by this report.

Pro has SlideWell 0.4.0-alpha.19 installed, code checkout package 0.4.0-alpha.15; installed/source parity not established. Pro's picture DB has 76,280 main-file vectors (61,661 slide, 12,923 triage, 1,696 well-image), EmbeddingGemma 2 ONNX fp16, 768d; archive slides.db contains 52,030 rows/1,050 presentations. These counts do not establish current coverage. ~14.9 GiB archive derived stores; ~28.2 GiB talk checkout including ~6.2 GiB Git. Personal Mini has ~642 GiB free on external volume, older SlideWell 0.3.0 and no picture-search DB at its default location; Core A extraction/media stores exist but differ in sizes from Pro. Air has ~8.6 GiB available, TalkWeaver 0.45.1 running, older SlideWell 0.3.0, no Core A at conventional path; talk checkout ~9.1 GiB. MultiWell has configured remote inference but local per-vault SQLite indexes. Highlight Scout has separate MiniLM vectors; scores/spaces cannot simply be combined with Gemma. Current Cloudflare R2 code serves/syncs files, not remote query execution. T3 source supports stable environment IDs plus multiple routes and compatibility checks; MIT licence. Reusing its concepts is cheap; directly extracting Effect-based runtime is not.

# Option H — Host service over current stores

One personal library host owns read-only search adapters over existing SlideWell/Core A, Scout and opt-in MultiWell stores. Existing app writers retain authority; there is no simultaneous second database writer. Stable library/environment identity, capability/coverage manifest, scoped IDs, media-by-ID endpoints, a small Air cache. Thin web finder first; desktop provider adapters later. Tailscale private HTTPS first; same API through authenticated Cloudflare Tunnel/Access later. R2 serves approved share snapshots, not a second live authority. Pro is a temporary seed host; reconcile/copy to personal Mini after evidence gates. Preserve separate vector spaces initially and fuse ranks; add shared embeddings after a compatibility evaluation. Initial usable finder: estimated 6–10 agent-hours; durable host/transport/cache: 22–38 cumulative; complete app integration and richer discovery: 50–85 cumulative. Estimates exclude full re-embedding, unattended elapsed copy time and owner acceptance. Main risk: host sleep/mount failure and adapter differences; host-down Cloudflare cannot provide live search without a published snapshot.

# Option E — Cloud read model

Personal host ingests and writes canonical local files, then publishes a versioned read model to Cloudflare: Worker API, R2 media, Vectorize vectors and D1/FTS-compatible lexical adapter. Thin web/desktop clients access the cloud copy; offline packs stay small. Keep each embedding identity in a separate index and evaluate query-model availability; local query embedding via live host defeats host-down independence, so a compatible cloud runtime or approved new cloud model/reindex is required. Publication generations make stale state visible; personal corpora need explicit cloud approval. Initial narrow usable finder: estimated 18–30 agent-hours; complete app integration/discovery: 70–115 cumulative. Estimates exclude bulk upload/re-embedding, provider charges and owner acceptance. Main risk: privacy boundary, model incompatibility, cloud query runtime and consistency of multiple stores; benefit: published search/media can survive host sleep once all serving dependencies live in cloud.

# Option F — Per-Mac selective replicas

Each app keeps its current local queries and models; a synchroniser distributes compact indexes and selected media packs through R2/Git/OneDrive, with local retrieval and demand-fetch of originals. This requires safe SQLite backup snapshots (including WAL state), model-version manifests, pin-aware cache eviction and a single writer per corpus. The Air avoids full originals but still needs query embedding runtime, vectors and multiple app stores; tiny lexical-only packs omit meaning/image queries offline. Initial narrow usable finder: estimated 10–18 agent-hours; complete app integration/discovery: 55–95 cumulative. Estimates exclude full sync time, owner acceptance and inference model downloads. Main risk: repeating freshness/index/model management on every Mac and Air disk growth; benefit: strong offline browsing and lexical search without a running host. Fully offline multimodal search is a different, larger disk budget.

# Rubric — fixed before judges

Score 1–10 on every criterion for every option; weighted arithmetic overall.

- Immediate useful Air discovery: 30%. 3 = blocked by a platform rewrite; 6 = bounded build with several data prerequisites; 9 = reuses existing indexed data in one build run.
- Small Air footprint: 20%. 3 = full replicas/models; 6 = selective stores but query models needed; 9 = no global corpus/model required, bounded chosen cache.
- Data authority and privacy fit: 25%. 3 = conflicting writers or implicit disclosure; 6 = additional authority/consent design needed; 9 = existing writers retained and boundaries explicit.
- Seamless use and availability: 15%. 3 = manual sync/paths; 6 = workable but clear host/route limitations; 9 = stable identity, automatic routes and clear offline recovery.
- Effort and reversibility: 10%. 3 = broad migration before value; 6 = several adapters/new infrastructure; 9 = incremental reversible adapter with preserved sources.

Human signal: user brief 17 Nov 08:25, Air small disk, T3 experience, existing Git/OneDrive insufficient, Cloudflare prior work, slide rediscovery first. Unknowns stay unknown. No measured latency, user relevance judgement or Cloudflare costs available.

# Judge output

Fresh context; did not author options. Return scores per criterion, overall, reason per criterion, strongest objection to top choice; compare top against each other option. Do not treat estimates as measured results. No edits to options/rubric. Save own seat Markdown only. One round score mode; no optimisation target or acceptance threshold. Same-model seats are weaker evidence than cross-family review.

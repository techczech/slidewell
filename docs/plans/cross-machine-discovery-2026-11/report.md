---
title: Cross-machine library discovery
date: 2026-11-17
register: FOR AGENTS
status: research and design proposal; not a build authorisation
author: Codex gpt-6.1-sol
authority: Dominik approved ambitious exploration on 17 November 2026 at 08:25
---

# Cross-machine library discovery

**Recommendation: one personal library host, several thin clients, one search contract.** Start with the indexed Pro to make the Air useful in one build run. Move the host role to the personal Mini after reconciling its older archive and proving its model runtime. Keep the shared Oxford Studio outside the personal library boundary. Add authenticated Cloudflare access to the same service; publish selected sharing snapshots separately.

This report is a design proposal. No app code, deployment, service installation, Tailscale route, DNS or network configuration was changed. The three mockups use invented material. They demonstrate interaction and geometry; they are not connected to the real archive and do not establish a locked design.

<nav class="report-nav" aria-label="Report sections"><a href="#inventory">Inventory</a><a href="#machines">Machines</a><a href="#t3">T3 model</a><a href="#options">Options</a><a href="#architecture">Architecture</a><a href="#directions">Try three directions</a><a href="#delivery">First build</a><a href="#decisions">Owner choices</a><a href="#sources">Evidence</a></nav>

## Inventory

The missing capability is remote query execution plus safe materialisation of selected results. Moving media to R2 already solves part of storage; it does not make a local SQLite query or Unix socket reachable from the Air.

Measured on 17 November 2026. GiB = 1,048,576 KiB; folder sizes use `du -sk` allocated space, file sizes use stat. They overlap where stated and must not be summed as independent archives. No raw deck, highlight, transcript or learner content is embedded here. Source identities and hashes are recorded in `source-manifest.json`.

| Application / library | Data and authority | Embeddings and index | Existing remote capability / measured footprint |
|---|---|---|---|
| **SlideWell / Core A** | `03_presenting-teaching/01_presentation-libraries/ppt-archive`: `extracted/`, `media-store/`, `registry/{slides,images,media}.db`. Originals stay in place, referenced by extraction manifests/location records. Added images and decisions: `~/SlideWell/well`, including `well.db`, `triage.db`, image sidecars. | Current SlideWell code pins `onnx-community/embeddinggemma-2-ONNX`, revision `daa72c…`, fp16 text + vision, 768 dimensions. `picture-search.db` stores normalised float32 little-endian BLOBs; in-memory dot-product ranking. Pro main-file snapshot: **76,280 vectors**: 61,661 slide, 12,923 triage, 1,696 well-image. | Pro extracted **12.98 GiB**, media-store **1.73 GiB**, registry **0.206 GiB**; well tree **0.408 GiB**, including picture DB **304.5 MiB**. Model folder **0.848 GiB**. Existing query endpoint is a **local Unix socket**, returning IDs/scores. R2 fetch-on-miss/upload exists for media; bounded eviction is deferred. [S1–S3] |
| **Core A legacy embeddings** | Same archive, older embedding tools. | README describes sqlite-vss `embedding_vectors`, metadata tables and `registry/embeddings.db`; OpenAI-compatible endpoint and MLX-CLIP routes. Qwen3-VL client is explicitly a scaffold in that README. No `embeddings.db` found among Pro registry databases. | Do not mistake this historical scaffold or cached Qwen models for the currently serving SlideWell implementation. No scale run or remote search service established from it. [S4] |
| **MediaWell → MultiWell** | Repository remains `06_apps-utilities/01_desktop-apps/mediawell`. Desktop data: `~/Library/Application Support/MediaWell/`; one index per vault under `vaults/indexes/<vault-id>/`. Originals are selected folders; optional managed copies/records. Prototype `.data/` is separate. Some migrated index content is still authoritative until record export is complete. | `google/embeddinggemma-2`, desktop revision `914f7f…`, 768d normalised text/frame vectors in `session-search.sqlite3` passage BLOBs. Local sentence-transformers/MPS path or explicitly configured matching remote worker. Separate embedding-space compatibility checks. | Private prototype Tailscale Serve on loopback port 8765 is documented; this is not proof that the current installed desktop vault is remotely browsable. Remote inference already exists with consent/model checks; it does **not** host the local catalogue. Pro models folder **6.64 GiB** (all roles), data **8.46 MiB**, vault tree **1.24 MiB**. External originals excluded. [S5] |
| **Highlight Scout + Scout** | Tauri/Rust app; v2 Markdown archive in `01_reading-research/highlights-archive`, old seed in `99_archive/highlights-archive-v1-readwise-seed`. Legacy app FTS: `~/.config/highlight-scout/index.sqlite`. Multi-corpus Scout stores: platform data folder `scout/indexes`. | Current default `minilm-l12`: Xenova multilingual MiniLM ONNX; optional E5 routes. `<corpus>.sqlite` FTS plus `<corpus>.vectors.sqlite`, model/dimension/content-generation metadata and per-passage vectors. Text only; not the Gemma image space. | R2 archive/index snapshot push/pull exists; observed Pro `r2_enabled=false`. No remote query API found in inspected paths. Archive checkout **0.627 GiB**; seed **0.220 GiB**; app config/index tree **0.335 GiB**; **all** Scout indexes **0.833 GiB**. Highlights vector main file **110.4 MiB**; talks **97.9 MiB**. WAL-bearing vector counts deliberately not inferred from main files. [S6] |
| **TalkWeaver** | Canonical Talk Outlines/assets in `03_presenting-teaching/dominiks-presentations-library`; multiple Vault handling and cross-vault insertion exist. Authoritative slide history in Vault `_SLIDE-VERSIONS/`. Local previews and thumbnail caches are derived. | Local Vault text catalogue/slide browser; image provider reads SlideWell/Core A DBs read-only, asks SlideWell’s Unix socket for meaning, resolves results against local sources. It does not own a parallel picture embedder. Scout separately has talk/slide-history text embeddings. | Existing Cloudflare publishing serves produced talk/handout/live outputs, not a cross-machine archive finder. Pro presentation checkout **28.18 GiB**, including **6.15 GiB Git metadata**; Air copy **9.14 GiB**; Mini copy **9.22 GiB**. Different sizes do not prove missing authored content; no content-equivalence audit was done. [S7, S8] |
| **LearnWeaver library / current pilot** | Current `07_webapps-websites/learnweaver-demo`; library-folder design uses `.learnweaver/library.json`, `course.md`, lesson Outlines and assets. File authority for authored material; published copies and class records have different ownership. Library-service code exists despite an ADR header still saying “accepted-design-not-implemented”. | SQLite/local catalogue plus Cloudflare pilot domain/storage adapters. No embedding/vector integration found in the inspected server paths; report does not claim an exhaustive repository absence proof. Prototype `.data/` measured **0.90 MiB**; actual chosen library size/location not verified. | README names authenticated **learnweaver-pilot.czechly.workers.dev**. Do not search class/learner records as slide content. Index authorised authored lessons through a source adapter, with the teacher’s library scope. [S9] |
| **Earlier LearnWeaver web app** | `07_webapps-websites/02_lovable/learnweaverapp`; catalogue identifies frozen Lovable prototype. Its local viewing hook queries Supabase presentation/section/item/content tables; local migrations include public-presentation read policies. Earlier recovery notes supplied the search lead; current remote content was not queried. | No local corpus-size or current vector-store claim. | Cloudflare DNS in front of an app is not proof of Cloudflare-hosted search. This earlier app is not the current file-backed lesson library. Live Supabase data was not queried. [S10] |

**Coverage caveat:** `slides.db` has 52,030 slide rows across 1,050 presentations and `images.db` has 14,700 image rows. Picture-vector slide count is 61,661. Those are different stores/generations, not a coverage percentage. Reconcile roots, generations, missing files and hidden states before advertising “all slides searchable”. Exclude triage Bin/emptied items and unauthorised library scopes before results and counts are returned.

### What “we already did Cloudflare” means here

| Existing item | What is established | What it does not establish |
|---|---|---|
| SlideWell R2 storage | Source implements per-store media upload and read-through. SQLite/JSON structure stays local; no automatic eviction. | A live remotely searchable archive, bounded Air disk use, or current bucket completeness. No bucket inventory performed. |
| Highlight Scout R2 | Archive plus legacy `index.sqlite` transfer code exists. | Multi-corpus Scout vector synchronisation or safe multi-writer SQLite replication. Do not reuse its file-copy path as a live WAL backup design. |
| Highlight Scout Pages, TalkWeaver Worker, SlideWell Pages | Catalogue describes application home/download sites. | Hosted personal libraries or semantic retrieval. |
| Slides gallery on Cloudflare Pages | Catalogue records a published gallery deployment, last recorded 29 Oct. | Search of the complete private well. |
| TalkWeaver publishing / old presentation Worker scaffold | Publication infrastructure and generated bundles exist; `dominiks-presentations-library-OLD` is paused scaffold. | Library-host execution or current repository synchronisation. |
| LearnWeaver pilot | Authenticated Worker pilot documented in its current README. | Permission to index or share learner records. |

## Machines

These are fresh read-only observations unless marked catalogue/runbook. SSH used existing routes; no pairing, access grant or configuration change. Process lists are momentary, and an installed app is not proof of a running service.

| Machine | Observed apps / library state | Design consequence |
|---|---|---|
| **Personal Pro — current research machine** | SlideWell **0.4.0-alpha.19**, MultiWell **0.4.0-alpha.11**, TalkWeaver **0.45.0-alpha.3**, Highlight Scout **0.6.0-preview.13** installed. Actual SlideWell checkout package is **0.4.0-alpha.15**; installed/source parity is unverified. Existing picture vectors and Scout stores measured here. | Best temporary seed host. Do not replace the newer installed bundle with this checkout blindly. Source/runtime parity and known queries are first-build gates. Laptop sleep remains a service outage. |
| **Personal Mini — target host** | External volume about **642 GiB free**. SlideWell **0.3.0**, TalkWeaver **0.42.0-alpha.19**, Highlight Scout **0.5.4** installed; no matching app processes seen. No default picture-search DB. Core A extracted **10.02 GiB**, media-store **9.52 GiB**, registry **0.209 GiB**. No MultiWell bundle at checked names. Existing T3 link answers now. | Suitable personal storage host after reconciliation, verified model runtime, mount/startup and service checks. Its archive is not proven to match Pro. Mini system disk is small; put bulk stores on the external volume. Cold boot/unmounted volume must give an explicit unavailable state, not an empty replacement catalogue. |
| **Air** | Current hostname differs from catalogue; existing tailnet address resolved and SSH worked. SlideWell **0.3.0**, TalkWeaver **0.45.1**, Highlight Scout **0.5.5** installed; TalkWeaver running. About **8.6 GiB available**. No conventional Core A folder; default SlideWell tree is only **40 KiB**. No MultiWell bundle at checked names. | A real thin-client need, not a hypothetical future optimisation. Propose **256 MiB disposable cache**, separate explicit pinned packs; no model download or global index required. No storage cleanup is part of this task. |
| **Shared Oxford Studio / BigMac — catalogue only** | Catalogue identifies M3 Ultra, 512 GB RAM, filtered development clones, T3 service and model-testing role. Personal library completeness, app versions and disk availability were not inspected. | Do not choose it as the personal highlights/library host. Approved code tests or separate institutional libraries can use it within existing boundaries. Another personal Studio would need its own verified record. |

The existing app-over-Tailscale pattern already works for ReportScout and Dev Traffic Control: loopback gateway, private Serve route, identity checks and pairing. Mini NordVPN/MagicDNS problems are documented, so connection diagnostics must separate DNS, route, authentication, host process and external-volume availability. Reuse the proven app gateway pattern; do not copy its socket-owner assumptions without verifying the installed Tailscale variant. [S11]

## T3

Local source found at `05_skills/t3code-upstream`, commit **8760d063e903406c8e8f695b0852c0a15fc1e00f**. Local runtime versions 0.1.7–0.1.9 are also present under `~/.t3/runtime/versions`; installed bundles are supporting evidence, not the source checkout’s version identity. No private T3 database, credentials or thread corpus was inspected for the architecture research.

| T3 mechanism observed in source | Borrow for libraries | Candidate code / limit |
|---|---|---|
| Persistent server environment ID and capability descriptor | A library is identified independently of its hostname, IP or current route. Cache keys include library ID and generation. | `apps/server/src/environment/ServerEnvironment.ts`; adapt the small identity/descriptor contract. |
| Primary target may be desktop-managed, configured or page origin; local execution can be disabled | Air can be a client of another machine without becoming a replica or running the heavy engine. “Primary” means selected client target, not a universal master of all files. | `apps/web/src/environments/primary/target.ts`. |
| Projects and project views carry environment identities | Bind a chosen library/Vault adapter to its host; resolve paths on that host. Same repository name on two Macs is not proof of same data generation. | `apps/web/src/hooks/useLogicalProjectEnvironments.ts`; use library + corpus IDs rather than host paths in results. |
| One environment entry has alternate routes; source ranks loopback/LAN/tailnet before public/SSH/relay | Tailscale and Cloudflare are routes to the **same** library. Reconnect without losing selection or duplicating saved operations. | `packages/client-runtime/src/connection/{catalog,routes,registry,supervisor}.ts`. Borrow concepts and tests; do not import the whole Effect runtime to save a few types. |
| Resolver checks environment identity and protocol compatibility after authorisation | A fallback route must authenticate the expected library and matching API generation. A reachable wrong host is a refusal, not a successful reconnection. | `connection/resolver.ts`, `connection/compatibility.ts`. |
| Diagnostics name device / relay / tunnel / server hops | Show “host asleep”, “sign in again”, “library disk missing”, or “show saved items” as distinct recovery paths. | `connection/diagnosis.ts`; adapt error categories and associated tests. |

T3’s checkout is **MIT licensed**, copyright T3 Tools Inc.; substantial copied code needs its licence notice. No T3 code was copied in this research task. Recommended reuse is small types, route-selection rules, failure taxonomy and test cases after dependency review. T3’s managed relay/account system is not an existing generic library service or a free transport to appropriate. The analogy does not transfer T3’s execution permission to read/write archives. [S12]

## Options

All effort figures are **planning estimates in agent-hours**, not measured build times or promises. They include focused implementation and verification, exclude unattended transfer/re-embedding time, owner review, account provisioning and subscription charges. Options use the same complete discovery goal, with different routes to first value. A “first build run” means one bounded builder session delivering a usable vertical slice, not one compiler command.

<div class="option-board">
<article><h3>H · Host service over existing stores</h3><p><strong>First useful finder: 6–10 h</strong><br>Durable host, cache and both routes: 22–38 h cumulative.<br>Full app integrations and richer discovery: 50–85 h cumulative.</p><p>Keep current writers and files. Add read-only search/media adapters on one personal host; a thin finder first, app providers later. Query the host over Tailscale or authenticated Cloudflare. Fuse separate vector spaces initially.</p><p><strong>First gain:</strong> use the existing Pro picture index from Air without cloning it. <strong>Main risk:</strong> host sleep/missing disk; Cloudflare route alone does not provide host-down search.</p></article>
<article><h3>E · Cloudflare read model</h3><p><strong>First useful finder: 18–30 h</strong><br>Full app integrations and richer discovery: 70–115 h cumulative.</p><p>Canonical local host publishes versioned Worker/D1/Vectorize/R2 read generations. Clients query the cloud copy. Compatible cloud query embeddings or an explicitly approved model change are prerequisites for independence from the host.</p><p><strong>First gain:</strong> access without Tailscale, then host-down availability. <strong>Main risk:</strong> personal content upload, model mismatch, distributed generation consistency and ongoing service costs.</p></article>
<article><h3>F · Selective replicas on each Mac</h3><p><strong>First useful finder: 10–18 h</strong><br>Full app integrations and richer discovery: 55–95 h cumulative.</p><p>Keep app-local queries; distribute compact database snapshots and selected media. Each client manages generation/model compatibility, indexing state and pin-aware cache limits. Fully offline meaning/image search requires query models too.</p><p><strong>First gain:</strong> offline lexical search and chosen material. <strong>Main risk:</strong> repeating store management and model/storage costs on the Air; this preserves much of the friction the brief asks to remove.</p></article>
</div>

<!-- include:scores -->

**Proposer’s recommendation: H.** It gives remote search first with existing data, preserves file authority, and leaves E available later for a carefully chosen cloud read model. F remains useful for offline packs, rather than the system’s primary architecture. Private Serve is tailnet-only; Cloudflare Tunnel creates an outbound connection to a local service, so a Cloudflare route can work while the client’s Tailscale is off. Both still need an awake serving host. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/).

## Architecture

<div class="architecture-map" aria-label="Proposed request and data path"><div class="map-clients"><strong>Air · thin clients</strong><span>TalkWeaver · SlideWell · Highlight Scout · MultiWell</span><span>Local Outlines + selected offline packs</span></div><div class="map-routes"><span>Private HTTPS over Tailscale</span><span>Authenticated Cloudflare route</span><small>Same library ID · same permissions · visible route</small></div><div class="map-host"><strong>Personal library host</strong><span>Library API · query jobs · generation manifest</span><span>Existing writer-owned stores + embedding runtimes</span><span>Originals stay in their source locations</span></div><div class="map-share"><strong>Explicit sharing</strong><span>Selected snapshot → R2 / published view</span><span>Revocable scope; never whole private library</span></div></div>

### Service boundary and ownership

The shared service is a **query/embedding coordinator with source adapters**, not a demand to merge every app’s database. Start beside SlideWell, which retains sole authority for well/extraction writes and heavy picture work. Initially the host app must run; later an approved host launcher can supervise it. Do not start a second engine writing its live stores. MultiWell retains its vault writer/record authority; Highlight Scout retains imports; TalkWeaver/LearnWeaver retain authored-file writes.

Use stable `{libraryId, corpusId, itemId, sourceRevision, indexGeneration}` references. Public responses contain descriptive metadata, reason channels, scoped media IDs and availability—not arbitrary host paths. Source file roots are resolved and authorised on the host. Host migration preserves library identity only after a single-writer cutover; a copied host cannot silently become a competing authority.

Accepted ADR-0032 amends ADR-0026: Outline IDs are `{id=…}`, history lives in Vault `_SLIDE-VERSIONS/`, SlideWell indexes it. The June/October RESUME and roadmap still describe older ownership and IDs. This proposal follows the later accepted ADR. Automatic suggestions may read current local draft text after an explicit personal-host preference; they never make an authoritative slide-history copy or propagate edits on their own. [S8]

### One search contract, compatible spaces

| Proposed content verb | Typed input / output | Posture floor and context |
|---|---|---|
| `library.describe` | library ID → protocol, capabilities, corpus generations, coverage/freshness, host/disk state | Direct read; enables honest availability. |
| `search.query` | query text or bounded image input, modes, corpus scope, filters, limit, request ID → ranked typed hits + per-channel reasons | Direct read; text/image content leaves Air only for the selected authorised host/route. Query content not logged by default. |
| `search.related` | item reference or draft context hash/text, scope, exclusions → ranked candidates and reason channels | Direct read/proposal display; no insertion. Context follows document privacy boundary. |
| `items.resolve` / `media.read` | authorised item references + revisions, rendition/range → metadata or checked bytes + content hash | Direct read; recheck visibility and source state at fetch time. No arbitrary-path endpoint. |
| `packs.prepare` / `packs.status` | chosen refs + byte budget + idempotency key → manifest, progress, verified pack | Direct local pin/download; no deletion of originals; permission refreshed before transfer. |
| `talk.insert` | verified local material + target Outline revision/cursor + operation ID → insertion result and undo | Explicit user intent through existing TalkWeaver writer. Stale Outline/source conflict returns a proposal; no silent retry overwrite. |
| `views.save` / `tags.propose` | scope + predicate or tagged refs + expected revision → saved view or reviewable tag proposal | Saved search direct; inferred human-tag changes remain proposals. Collections do not move files. |
| `shares.prepare` / `shares.publish` | selected refs, allowed rendition, audience, expiry → proposed manifest / published scoped snapshot | Preparation direct; publication approval. No share operation in the first slice. |

UI chrome such as panel width/theme is excluded from the content-verb table; Settings and command discovery follow existing app conventions when built. No app implementation is specified as accepted by this research report.

**Meaning is not one interchangeable vector.** SlideWell ONNX fp16 and MultiWell’s sentence-transformers/worker Gemma route have different revision/runtime/preprocessing identities. MiniLM is another space entirely. Store an embedding identity containing model revision, modality, dimensions, normalisation, task prefix, preprocessing and runtime. “Both 768d” is insufficient. Keep their indexes separate and combine ranks (for example reciprocal-rank fusion); do not average raw cosine values across them.

For genuine cross-embedding, introduce a versioned Gemma space covering slide renders, extracted/added images, associated slide text/notes and authorised highlight/lesson text. Reuse vectors only after a fixed text/image canary set establishes compatible outputs and retrieval. Otherwise build a new generation alongside the old one. Suggested corpus sample: 30 remembered-target queries, text-to-image/image-to-slide cases, Czech/English, near duplicates, sparse-text pictures and deliberately unrelated negatives. Human relevance labels stay separate from automatic similarity. Record top-5/top-20 recall, time to first usable preview and incorrect-family grouping; no quality/latency claim is made before this check.

**Search modes:** Words (exact/FTS, names, dates, phrases); Meaning (topic expressed differently); Picture (drop a local image or select an indexed seed); More like this (selected item); Hybrid (merge channels and show why). A text-rich slide can match its render and its words independently. Include optional related highlights/transcript moments without letting numerous text passages drown the slide results. Deduplicate by content/source identity, diversify by Talk family, and offer “show variants”. Emptied/hidden states and permissions constrain candidates and counts before ranking/serving.

### Two routes and explicit sharing

Tailscale: loopback host API behind a private Serve path, same-user pairing/application credentials and revocation. Tailscale membership alone is not permission to every corpus. Cloudflare: Access-protected hostname plus Tunnel to the same API, with application scope enforcement at origin. Validate origin identity/JWT where applicable; an edge rule alone is not an origin authorisation design. Desktop authentication uses an external browser/short-lived session flow, not long-lived cloud keys embedded in renderer code. [Cloudflare Access application documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

Prefer private route; an approved Cloudflare fallback may reconnect reads after verifying library identity. Show the selected transport. Do not silently send Oxford/private draft text through Cloudflare. A 401/403 is a sign-in or permission problem, not a cue to try a wider scope. Cloudflare handles plaintext HTTP at its edge in this design; it is not end-to-end private merely because the model runs locally. Whole-library cloud access and a selected public/share snapshot are separate user choices.

If host-down browsing becomes a priority, publish a selected generation of metadata/thumbnails first. Fully independent semantic search also needs cloud query embeddings in the same space. Vectorize dimensions/metric follow the chosen model; metadata filter indexes must be designed up front. No account price, throughput or free-tier promise is assumed. [Vectorize index design](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/), [metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/).

### Air cache and offline queue

Propose 256 MiB disposable LRU cache, measured bytes with a reserve check; pinned packs have an explicit separate budget and are never silently evicted. At 512×288 previews averaging an **assumed** 40 KiB, 256 MiB holds about 6,500 previews before metadata/overhead. This is capacity arithmetic, not a measurement of actual renders. Do not cache full decks or download models merely to show search results. Pinned assets copied into an authored Talk become document assets and leave cache-eviction authority.

Offline shows cached result metadata/thumbnails and pinned packs with their generation/time. Local word filtering works inside that subset; remote Meaning/Picture controls remain visible but unavailable, with “connect to search the full library”. This is not evidence of no match in the full corpus. Precompute neighbours/groups for chosen packs if useful; full fresh offline multimodal querying needs a separately approved model/index budget.

Queue only intent that still makes sense after reconnecting: requested pack downloads, saved-view/tag proposals and explicit user requests to rerun a search. Do not replay keystroke-driven suggestions or silently publish/share. Every durable operation has an operation ID, library ID, source revision and state: waiting → transferring → verified → complete / conflict / failed. On reconnection reauthorise, recheck source revision/visibility, then resume hash-checked bytes. Cancel returns to a usable local state. “Inserted” is shown only after local assets are verified and the target revision-guarded write succeeded. Partial downloads never enter a Talk; queue acknowledgements cannot insert twice.

## Directions

Three different discovery journeys are shown below. **A** makes finding the main activity. **B** keeps the existing Outline as the main activity and proposes material beside it. **C** supports browsing when a useful query is hard to formulate. They can share the same service. Prefer A for first remote value, then B; C is a later discovery layer. All shown titles, years, group counts and timings are illustrative, not archive observations.

<div class="direction-index"><a href="#direction-a">A · Find across the library</a><a href="#direction-b">B · Find while writing</a><a href="#direction-c">C · Rediscover in groups</a></div>

<!-- include:direction-a -->

### A contract

Dedicated window. Dominik remembers words or a picture; expects matching slides/images and provenance. Search → select → More like this → save locally → reuse. Success: one chosen asset is local and its source remains visible. Try Words/Meaning/Picture, cached-only/offline, a denied scope and reset. Pattern is a contact sheet plus inspector. It replaces local-store assumptions in a finder, not the canonical Outline.

<!-- include:direction-b -->

### B contract

Docked TalkWeaver panel. Dominik is already drafting; expects suggestions tied to the current slide. Select another slide context → inspect why/source → make material local → insert explicitly → undo. Success: a materialised copy is inserted once and works offline. In production trigger on slide selection/save or a short idle interval after an explicit opt-in, cancel superseded requests, use a context hash, suppress already-used items, and keep a quiet “suggestions paused” state. The demonstration’s secondary cards expose provenance only; no reuse implementation is claimed for those cards.

<!-- include:direction-c -->

### C contract

Dedicated browsing window. Dominik cannot remember search words; expects themes and visual families. Open group → expand variants → compare → save a named search view → pin selected material. Success: a useful view can be revisited without moving files or rewriting tags. Separate exact copies, near visual matches, conceptual neighbours and real slide lineage. Do not present an embedding cluster as historical proof of reuse. Suggested group labels remain editable proposals.

### Surfaces still requiring a design lock

These explorations show connected/results, cached-only/unavailable, provenance, partial-transfer/completion, selection, insertion and undo states. They do not settle complete first-use pairing, expired credentials, host disk failure, source change/conflict, keyboard rebinding, Settings, full accessibility or share-audience/expiry screens. Those states are named for the next design parcel rather than left to a builder. Common app commands/Settings stay in the estate frame; no new production shortcuts are assigned here.

## Delivery

### First usable slice — a finder on Air using the indexed Pro

**A single bounded build run, estimated 6–10 agent-hours:** a small private web finder, hosted beside the running SlideWell engine on the Pro, which the Air opens over an approved existing/new private route. It supports Words + Meaning search across available personal slide renders and well images, thumbnail/detail/source inspection, More like this for indexed items, and download of a chosen full-size image/slide render with provenance. Full archive, embeddings and models stay off Air. Images can be brought into a local Talk through the existing import/paste route. Editable cross-vault slide insertion and automatic suggestions are later parcels; a render download must not be labelled editable slide reuse.

This is usable without rebuilding/installing all four apps or re-embedding the archive. It is also conditional: verify installed/source parity, model readiness and a small set of known matches before claiming the existing index can serve. The current socket contract has only text→IDs/scores; a proper adapter must add authorised metadata resolution, media-by-ID reads, related-item queries and readiness/error responses. Do not expose the socket blindly or proxy arbitrary local paths.

If parity prevents reuse, the run should deliver the verified word-search part with an explicit “meaning unavailable” result and report the blocker; it must not replace the newer bundle or silently launch a full reindex. Route installation remains a deployment step needing its own authorised build/deployment instruction. Today’s research approval is not that instruction.

Acceptance for that build: Air has no archive/model clone; remembered-target Words and Meaning searches return valid visible results; a chosen rendition downloads with a hash and source identity; host-offline/denied/empty states are distinct; no Bin/emptied/Oxford items leak; oversized/expired/arbitrary-path requests are refused; download after a visibility change is rechecked. Measure remote query/preview latency and bytes on a real Air connection. Proposed targets: warm query under 1 s and first usable thumbnail under 2 s on the ordinary tailnet connection—targets, not measured claims.

### Parcels after first value

| Parcel | User-visible result | Estimated additional effort / dependency |
|---|---|---|
| **1 · Stable host and bounded offline packs** | Mini stays available; Air reconnects and keeps selected material. | **8–14 h** after finder. Reconcile Pro/Mini originals/derivatives and authoritative well/ledger metadata, make verified backups, stage copy without deletions, prove model runtime, then single-writer cutover. Measure fresh disk/mount readiness. Do not sync live SQLite through OneDrive/SMB; use SQLite backup API or a quiesced verified snapshot including committed WAL. |
| **2 · Cloudflare private route and selected sharing** | Finder works with Air Tailscale off; selected material can be shared explicitly. | **8–14 h** after core API. Access/Tunnel, session/origin checks, same library identity, route diagnostics. Sharing gets separate scope/expiry review; R2 snapshot generation can follow. Owner cloud/privacy decision required. First three stages total **22–38 h**. |
| **3 · TalkWeaver reuse and suggestions** | Docked “related to this slide”, genuine editable slide copy where source exists, checked local assets and undo. | **10–16 h**. Existing cross-vault insertion adapter, revision checks, provenance/ledger preservation; no automatic propagation. Needs locked B journey and target-state designs. |
| **4 · Shared embedding coordinator and app adapters** | Related slides, images, highlights and authored lesson text use one service with explicit source permissions. | **10–18 h**. Scout and MultiWell adapters first; compatibility canaries then optional new Gemma generation. Source-derived records remain separate; migrated MultiWell indexes preserved as authoritative where needed. |
| **5 · Groups, variants and rediscovery** | Browse themes/families, compare variants, revisit saved searches and recent rediscovery. | **8–13 h**. Uses corpus/generation identity and accepted relevance sample; no folder relocation. Counts/labels distinguish inferred groups and human choices. Full path total **50–85 h**, excluding large data jobs and acceptance. |

Copy/reindex elapsed times are unknown until inventory manifests reconcile files, source revisions and model identities. Shared service search should work while background indexing is paused; concurrency limits and progress are visible. Keep old stores until verified cutover and recovery proof; a proposed retirement is not permission to delete data.

## Decisions

No implementation is authorised by this report. Four owner-level choices remain; technical implementation choices are for the builder once those outcomes are selected.

1. **First useful experience:** A, finding material from Air, or B, suggestions directly beside a TalkWeaver draft? Recommend A first, B next; A avoids a desktop integration before remote value.
2. **Availability:** use the Pro briefly then make the personal Mini the library host, or wait until the Mini is ready before any remote use? Recommend Pro first then verified Mini cutover. Pro sleep temporarily interrupts full-library access.
3. **Cloud reach:** private personal access through Cloudflare only, selected sharing too, or keep all remote use on Tailscale initially? Recommend private Tailscale first, private Cloudflare second; sharing explicit and scoped. Cloudflare access sends query/media traffic through its edge.
4. **Offline promise:** chosen talk packs only, or a larger searchable offline catalogue with local query models? Recommend chosen packs plus cached word search; full offline meaning/image discovery needs a separate disk budget.

The architecture judges score the technical approaches separately above. Their scores do not stand in for Dominik’s judgement of these product/appearance/privacy choices. The coordinator can collect these choices together after inspecting the three directions; this report does not create an unrelated approval workflow.

## Sources

Source statements are bounded to inspected paths; current measurements and historical records are labelled separately. Public service documentation checked 17 Nov 2026. Source repository paths are relative to `~/gitrepos`; personal host addresses, credentials and real content are omitted from this public-repository artefact. The capture record and `source-manifest.json` preserve reconstruction metadata.

| ID | Evidence locator and scope |
|---|---|
| **S1** | `slidewell/src/main/picture-search/model-manifest.ts:8`, `vector-store.ts:1`, `service.ts:1`, `engine.ts`. Model, index and query ownership; source head in manifest. |
| **S2** | `slidewell/src/main/picture-search/query-socket.ts:1`; `talk-weaver/src/main/image-search/slidewell-query.ts:1`, `slidewell-provider.ts:1`. Local-only contract and metadata/state resolver. |
| **S3** | `slidewell/src/main/storage.ts:1`, `r2.ts`; RESUME R2 increments. Media-only read-through; no eviction. Runtime configuration read through an allowlist of library paths only. |
| **S4** | `03_presenting-teaching/01_presentation-libraries/ppt-archive/tools/embeddings/README.md:1`. Legacy index format and scaffold claim; registry stat/schema/count observation today. |
| **S5** | `mediawell/CONTEXT.md:1`, `oxford_rag/{storage,embeddings,desktop_models,desktop_inference,embedding_space,vault_index}.py`; `docs/adr/decision-multiwell-vaults.md`. Rename, remote consent, same-model checks and index authority. |
| **S6** | `highlight-scout/src-tauri/src/{meaning,config,r2}.rs`; `06_apps-utilities/03_misc-utilities/scout-core/crates/scout-corpus/src/semantic/{embed,store}.rs`. Model choice, index format and R2 scope. |
| **S7** | `talk-weaver/src/main/{vault-index.mjs,cross-vault-insert.ts}`, image-search provider files; current presentation-library README. Local Vault handling and materialised reuse. |
| **S8** | `_COORDINATION/presentations/presentation-system/{CONTEXT,ROADMAP}.md`, `docs/adr/0026-provenance-versioning-external-slidewell-tracking.md`, **0032-slide-ledger-identity-propagation.md**. Accepted later ledger amendment overrides stale resume wording. No direction-layer edits made. |
| **S9** | `07_webapps-websites/learnweaver-demo/{README.md,server/library/library-service.ts,docs/adr/0031-library-folder-is-the-content-authority.md}`. Pilot, source authority and class-record separation. ADR implementation status header conflicts with present code; no rollout-completeness claim. |
| **S10** | `_CATALOG/entities/projects/{learnweaverapp,learnweaver-demo,dominiks-presentations-library,dominiks-presentations-library-old}.md`; deployment records for Highlight Scout, TalkWeaver, slides gallery and Lovable LearnWeaver. Earlier recovery memory used as a search lead; the legacy app’s `src/hooks/usePresentationData.ts` and selected Supabase migration statements were rechecked locally. No live legacy content fetched. |
| **S11** | `_CATALOG/entities/machines/` personal Pro/Air/Mini and AI-Centre-BigMac; `_MACHINECONFIG/{machinesetup_macbook_air,machinesetup_mac-mini,devsetup_apps_over_tailscale}.md`; model catalogue. Fresh personal-machine `hostname`, `df`, `du`, installed Info.plist and bounded app-process checks supersede stale machine names/versions. |
| **S12** | `05_skills/t3code-upstream` at pinned head above; `LICENSE`, server environment identity, primary target, logical-project environments and client-runtime connection modules. Installed runtime paths inspected by filename only. Live T3 environment-links read confirms personal Mini reachable, not that any library service is running. |

### Verification and limits

Research read-only probes include known-path stat/folder allocation, SQLite schema and aggregate row counts, embedding model metadata, app versions and momentary app process checks. For picture vectors, the initial read-only open failed because SQLite wanted side files; after checking that no WAL file existed, a main-file immutable read obtained the aggregate snapshot without writing beside the database. WAL-bearing Scout vector files were not counted this way. No corpus excerpts, secret values, full settings dumps or credentials were read into the report.

The counts, file sizes and versions are a point-in-time inventory, not a full source audit, cross-Mac equality proof, restoration test, retrieval-quality evaluation or running-service certification. External originals, remote bucket completeness, chosen LearnWeaver library, app permissions, full model serving on Mini and current legacy Supabase content remain unverified. No inference or paid model experiment was run. Two fresh same-model judges assess options; their agreement is weaker evidence than cross-family review and is not a factual audit.

Build the report with `python3 docs/plans/cross-machine-discovery-2026-11/build-report.py`. Markdown files own all authored narrative and mockup copy; CSS and JavaScript remain separate author-time files. The generated HTML embeds them and loads without network access. Verification results and remaining proof limits follow, from `verification.md`.

<!-- include:verification -->

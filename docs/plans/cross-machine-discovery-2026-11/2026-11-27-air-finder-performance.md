---
title: Air finder performance measurements
date: 2026-11-27
register: FOR AGENTS
status: measured on an invented library
baseline: d9df3f4
candidate: 2ce73c0
---

# Air finder performance measurements

On Friday 27 November, Words under review-database contention went from a 595 ms median event-loop gap to 3 ms. Six distinct cold 40–60 MP PNGs went from 371 to 295 MiB median peak process RSS. The batch took 472 ms before and 844 ms after. A repeat of one of those PNGs took 110 ms before and 2.3 ms after. Cold Related still spends about 234 ms inside the shared picture engine's synchronous vector load and ranking.

## Method

- Used the MacBook Pro (Apple M4 Max, macOS 27.2.1), Node 26.12.1, SQLite 3.54.1, Sharp 0.35.5 and libvips 8.18.7. Bundled the real finder server, catalogue and picture engine for Node. Called the configured host over a private Unix socket with search-issued IDs and the production file and visibility checks. The runner set the same two-thread libuv pool for both revisions. The separate hidden Electron journey verifies worker bundling and socket lifecycle.
- Extended the existing fixture with 36,000 slides across 360 invented decks, 12,600 triage rows and 6,300 allowed well rows, plus the seed fixture. Included emptied images and expired throwaway proposals. The allowlist fits the real launch limits. Indexed 42,308 synthetic 768-dimension vectors with the real store and engine, using constant vectors to avoid model inference and keep ranking deterministic. Only a subset of catalogue rows had actual render files. Large PNG and JPEG files contained generated repeating patterns at 40, 54 and 60 MP. These compress differently from ordinary photographs and screenshots.
- Alternated baseline and candidate in three rounds. Each pair reused the same immutable fixture contents. Each search run made nine sparse Words calls, nine broad Words calls, one cold and nine warm Related calls, then one Words and one Related call while an independent connection held an exclusive transaction on the invented rollback-journal review database. The lock case deliberately exercises the busy timeout. Its frequency in the owner's library is unknown.
- Measured the largest gap in a 2 ms interval on the request-handling thread, including a final sample at request completion. This is a proxy for UI stalls. The reported gap includes the sampling interval. Recorded clock time around the shared picture engine's synchronous call for attribution.
- Used fresh processes for each preview burst and issued 1, 6 or 24 HTTP requests at once. At 24, six were admitted and 18 returned HTTP 503 for both revisions. Re-searched and requested the first successful item through its newly issued ID, retaining the same process for that repeat. Recorded process RSS high-water mark using `process.resourceUsage().maxRSS` and wall time through the last response. RSS includes runtime, workers and allocator retention. The number in parentheses is the median increase from the high-water mark immediately before the burst.
- Investigated catalogue gaps over 50 ms and preview bursts that raised peak RSS by 300 MiB or more. The largest before increases over the three rounds were 336 MiB for six PNG requests and 475 MiB for 24. The corresponding after increases were 300 MiB and 227 MiB, rounded.

## Search and related results

Milliseconds. For the steady-state rows, the number in parentheses is the maximum across 27 calls. Cold and locked rows show medians across three calls.

| Route | Main-loop gap before | Main-loop gap after | HTTP wall before | HTTP wall after |
| --- | ---: | ---: | ---: | ---: |
| Sparse Words | 14.0 (16.0) | 2.6 (3.8) | 14.2 (21.0) | 14.8 (25.0) |
| Broad Words | 33.5 (34.8) | 2.7 (3.0) | 34.1 (35.5) | 34.4 (35.6) |
| Related, cold vector cache | 248.6 | 236.4 | 249.5 | 253.3 |
| Related, warm vector cache | 57.7 (69.2) | 40.7 (53.2) | 58.4 (70.0) | 57.1 (69.8) |
| Words, review DB locked | 595.3 | 3.0 | 595.4 | 572.8 |
| Related, review DB locked | 566.9 | 3.0 | 567.2 | 565.2 |

Locked calls still returned 503 once the read failed. Their maximum sampled gaps fell from 601.4 and 577.9 ms to 5.2 and 3.2 ms. With four PNG previews requested concurrently, broad Words completed in 37.3 → 36.7 ms and the largest main-loop gap in the mixed workload was 35.4 → 2.7 ms (medians). The real shared picture-engine call took 229.5 → 233.6 ms cold and 38.3 → 38.4 ms warm. Catalogue-only changes leave that shared synchronous vector work in the application main process.

## Previews

Medians across three rounds. Peak increase from the pre-burst high-water mark appears in parentheses. Wall time is for all responses. Repeat time is for one previously successful item using a fresh search ID.

| Format | Requests | Peak before, MiB | Peak after, MiB | Burst before, ms | Burst after, ms | Repeat before, ms | Repeat after, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PNG | 1 | 194 (125) | 188 (110) | 120 | 120 | 114 | 1.7 |
| PNG | 6 | 371 (302) | 295 (217) | 472 | 844 | 110 | 2.3 |
| PNG | 24 | 395 (325) | 293 (215) | 443 | 844 | 111 | 1.3 |
| JPEG | 1 | 82 (13) | 92 (14) | 38 | 39 | 36 | 1.7 |
| JPEG | 6 | 119 (50) | 120 (42) | 137 | 253 | 36 | 1.5 |
| JPEG | 24 | 124 (54) | 116 (38) | 133 | 257 | 36 | 1.4 |

Peak RSS for six PNGs ranged from 353 to 405 MiB before and 293 to 378 MiB after. Across 24 requests it ranged from 394 to 544 MiB before and 289 to 305 MiB after. Serial decode bounds the number of live decodes. Process RSS can stay elevated between requests. This fixture did not reproduce the review's 1.5 GB estimate. JPEG already benefited from shrink-on-load, and WebP supports it in the same Sharp pipeline. PNG still needs to decode the full-resolution raster. The change leaves the existing 480-pixel output and Sharp pipeline in place and explicitly keeps shrink-on-load enabled. Common Words latency and the JPEG memory figures gave no reason to add registry indexes, another image decoder or separate scheduling by format.

## Read-only and cache behaviour

- Catalogue operations run through the existing Electron Vite worker-thread mechanism. Each database read retains canonical-path enforcement, read-only SQLite, the 500 ms busy timeout, read-only attachment of the review database and fail-closed visibility. Socket ownership and refusal of occupied paths, GET-only handling and the six-request and 24-connection limits still apply.
- Each preview enters a serial queue and resolves the ref against the current roots, allowlist, index and review state at the front of the queue. A miss still reads at most 20 MiB from the verified file with `O_NOFOLLOW`, checks both the open inode and the canonical path after reading, checks raster format and frame count, and re-resolves the ref after encoding.
- Only the finished WebP is cached. The key includes catalogue item ID, canonical path, MIME, file revision and preview size. The revision includes the catalogue revision, device, inode, file size and nanosecond modification and change times. On a hit the finder opens the original with `O_NOFOLLOW`, checks identity on the open descriptor and re-inspects the canonical path before re-resolving the ref. This checks visibility, ref expiry and source identity again before serving. The cache holds at most 4 MiB and 128 entries. Entries are eligible for reuse for two minutes from encoding. HTTP responses still use `no-store`. The cache writes nothing to disk.

## Verification artefacts

- Laptop benchmark harness, copied baseline source, invented database and image fixtures and raw logs at `/private/tmp/swperf.riu3Bi/`. Three recorded paired rounds in `repeated.log`. Earlier exploratory runs are retained in the same directory. The repeated harness corrects how the follow-up request selects a successful item from an overloaded burst.
- Laptop hidden Electron source-build run passed Words, repeat WebP preview, original download and shutdown on the private socket. Retained profiles and fixtures in `/tmp/swf.WXvNt1` and `/tmp/swf.ER5aCW`, with ignored `out/` and `node_modules/` in the worktree.
- Studio typecheck, six focused finder cases and the real-service browser journey ran against the pushed branch. Existing security assertions were retained. The added cases cover continuing to process main-loop work during a SQLite lock and rejecting a cached preview after file replacement. No broad suite, packaged app, real library, live model or Air SSH forward in this run.

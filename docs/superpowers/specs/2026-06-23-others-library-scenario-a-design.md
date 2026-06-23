# Others' Library — a separate archive for other people's slides (Scenario A)

**Status:** design — pending review, then plan + build. Companion to the shipped Convert feature (Scenario B).
**Repo:** slidewell (execution). Direction layer: presentation-system (ADR-0008, ADR-0026, ADR-0029; this warrants a new **ADR-0031**).

## Problem

Dominik receives other people's PowerPoints (e.g. from training collaborators) and wants to **import them into a searchable slide library that is physically separate from his own archive** — never mixed into `ppt-archive`, clearly not-his, and purgeable as a whole. Today SlideWell supports exactly **one** archive; pointing it at a folder of others' decks both breaks his own archive and doesn't work (that folder isn't a built Core A store).

## ADR grounding

- **ADR-0008** (shareable core vs personal estate): the archive is Dominik's personal estate; other people's decks are not his authoritative content → they must not become part of it.
- **ADR-0026** (layered authority): SlideWell is the *authoritative owner* of **his** extractions + added images. Other people's slides are a **new, non-authoritative class** — the design has no tier for them yet (the Convert feature's `origin: external` stamp is the seed).
- **ADR-0029** (Triage): precedent for a *"staging ground SlideWell reads but never owns… indexed into a separate index."* The Others' Library is the same shape, one level up: a separate **archive** SlideWell builds and searches but treats as non-authoritative.
- New **ADR-0031** records the decision: *other people's slides live in a separate, non-authoritative archive ("Others' Library"), built by the same engine, searchable as its own scope, never merged into the personal archive.*

## Decisions

- **A second archive store**, `othersArchiveRoot` (config), default `~/SlideWell/others-library`, **auto-created on first import**. Its own `extracted/` + `registry/` + `media-store/` — a real Core A archive, just a different data root.
- **Same engine, different data root.** Generalise the import pipeline to separate **engineRoot** (the main `ppt-archive`, where Core A's `tools/` live — used for cwd + PYTHONPATH) from **dataRoot** (where `--output`/OCR/media-store write). Mirrors `convert.ts`'s proven sideband split.
- **Import gets a destination**: *My archive* (today's behaviour) | *Others' library* (writes to `othersArchiveRoot`).
- **Search gains a library scope**: `library: 'mine' | 'others' | 'all'`. When `others`/`all`, SlideWell also queries `othersArchiveRoot` and **merges**, badging others' results. Default `mine`.
- **Purgeable**: a *Clear Others' Library* action wipes that store (its `extracted/`/`registry/`/`media-store/`), never touching `ppt-archive`.
- **Convert is unchanged** — it remains the throwaway, no-library path. The Others' Library is the *keep-and-search* path.

## Non-goals

- Not changing `ppt-archive` or any locked decision about the personal archive.
- Not per-deck ownership tagging inside the others' store (everything there is "others" by construction).
- Not lineage/reuse from the others' library into Talks (it's a reference/search corpus, not a reuse source) — deferred.
- Not a third store for the well; the well stays as-is.

## Architecture

### Config (`userData/config.json`)
- `othersArchiveRoot?: string` — default `~/SlideWell/others-library` (created on demand).
- Resolver `othersArchiveRootResolved()`; availability = the folder exists (registry/ optional until first import).
- `allowedRoots()` **must include** `othersArchiveRoot` so others' renders/images serve via `swarchive://`.

### Import pipeline (generalise `ingest.ts`)
- `IngestOpts` gains `engineRoot` + `dataRoot` (replacing the single `archiveRoot`; `archiveRoot` kept as alias = both equal for "My archive").
- `runIngest`: `cwd = engineRoot`, `PYTHONPATH = engineRoot:engineRoot/tools`; commands write to `dataRoot`:
  - `extract <path> --output <dataRoot>/extracted` (+ `--screenshots` if render tools present)
  - `tools.ocr.cli <dataRoot> ingest-all`
  - `tools.media_store.cli <dataRoot> migrate`
- "My archive" import → `engineRoot = dataRoot = ppt-archive`. "Others'" → `engineRoot = ppt-archive`, `dataRoot = othersArchiveRoot`.
- Guard: others' import requires the **engine** (`ppt-archive` with `tools/`) present; the data root is created if missing.

### Search (`index.ts` `archive:search` + friends)
- `SearchFilters` gains `library: 'mine' | 'others' | 'all'`.
- The handler queries `archiveResults`/`searchImages`/`listDecks` against `ppt-archive` when `library ≠ others`, and against `othersArchiveRoot` when `library ≠ mine`, then concatenates clusters. Each result carries `library: 'mine' | 'others'` (new field on the wire shape) so the card can badge **OTHERS**.
- `archive:categories`/`archive:decks`/`deckDetail`/`slideStructure`/`slideImages`/`deckSlides` take an explicit root resolved from the result's `library` (or a passed `library` arg) so context/inspect works for both stores.

### Renderer
- Filter bar: a **Library** selector (`Mine · Others · All`) beside the existing Source/Type, wired to `filters.library`.
- Result card: an **OTHERS** badge when `result.library === 'others'` (mirrors the existing WELL/IMG/OCR tags).
- Import panel: a **destination** toggle — *My archive* (default) | *Others' library* — shown above What/Where; "Where it goes" reflects the chosen store.
- Settings: an **Others' Library** section — folder chooser (`othersArchiveRoot`) + a **Clear library** button (confirm dialog).

### IPC / preload additions
- `settings.getPaths` → `+ othersArchiveRoot, othersArchiveAvailable`.
- `settings.chooseOthersFolder(): string | null`; `settings.clearOthersLibrary(): { ok: boolean }`.
- `ingest.choosePath()` unchanged; `ingest.runPath(targetPath, library)` gains a `library` arg (`'mine' | 'others'`); `ingest.pending(library?)` similarly (others' "ingest pending" is out of scope v1 — only file/folder import to others).
- `archive.search(query, filters)` — `filters.library` flows through; results gain `library`.

## Edge cases & feedback
- Others' import with no **engine** present → streamed `✕ Engine (ppt-archive) not found…` (reuse the archive-missing feedback).
- Others' search when `othersArchiveRoot` empty/unbuilt → just returns no others' results (no error).
- Clear Others' Library → confirm dialog; only ever removes inside `othersArchiveRoot`; never `ppt-archive`.
- `othersArchiveRoot` must never resolve inside `ppt-archive` (guard).

## ADR-0031 (to draft in presentation-system)
"Other people's slides live in a separate, non-authoritative archive." Builds on ADR-0008/0026/0029; introduces the **Others' Library** glossary term and the `library` search scope; affirms it is personal-estate-adjacent but explicitly *not* the authoritative archive, off the build path, purgeable.

## Files (slidewell)
- `src/main/index.ts` — config + resolvers + `allowedRoots` + search dual-query + import destination + settings handlers (choose/clear).
- `src/main/ingest.ts` — engineRoot/dataRoot split.
- `src/main/archive.ts` — thread `library` into the wire shape (a `library` field on `EnrichedHit`/wire); helpers already take `root`.
- `src/preload/index.ts` — `library` in `SearchFilters` + results; new settings methods; `ingest.runPath(target, library)`.
- `src/renderer/src/App.tsx` — Library filter, OTHERS badge, Import destination toggle, Settings section.
- `src/renderer/src/sw-mock.ts` — keep in sync.
- presentation-system: ADR-0031 + CONTEXT glossary entry (separate commit, flagged for review).

## Build order (incremental, each verifiable)
1. Config + resolvers + `allowedRoots` + ingest engineRoot/dataRoot split (no UI yet) — `npm run build` green.
2. Import-to-others: destination toggle + `runPath(target,'others')` → verify a deck lands in `othersArchiveRoot`, not `ppt-archive`.
3. Search `library` scope + dual-query + OTHERS badge → verify others' decks searchable & badged, mine unaffected.
4. Settings: chooser + Clear library.
5. ADR-0031 + CONTEXT note (presentation-system).

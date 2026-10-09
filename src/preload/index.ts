import { contextBridge, ipcRenderer } from 'electron'
import type { Stats } from '../main/stats'

export type { Stats } from '../main/stats'
// From/Kind filter values. Kept here (not imported from main/searchfilters.ts, which holds the same
// literals) so the web project needs no main-process file.
export type FromFilter = 'all' | 'screenshots' | 'old-images' | 'old-slides' | 'talks'
export type KindFilter = 'all' | 'no-text' | 'embedded'
export type FromCounts = Record<FromFilter, number>

// One Image Node entity is shared with TalkWeaver (CONTEXT.md / ADR-0020, ADR-0026): a
// content-addressed image + sidecar. In SlideWell it also carries provenance + notes. On disk
// the file is named `{slug}--{id}.ext` (ADR-0026) so the store is discoverable without this app;
// the resolver matches on the hash portion, never the slug.
export type ImageProvenance = 'extracted' | 'added'

export type ImageNode = {
  id: string // 7-char sha256 — the stable identity used in `img-{id}` references
  slug: string // human-readable, frozen-at-creation filename anchor (may be '')
  ext: string
  provenance: ImageProvenance
  source?: string // deck slug (extracted) or import note (added)
  alt: string
  caption: string
  tags: string[]
  notes: string
  /** swarchive://<b64url> | swasset://<id> — a renderable thumbnail URL. */
  thumbUrl: string
}

// Search result shapes (the main process resolves render paths to swarchive:// URLs).
export type SlideResult = {
  kind: 'slide' | 'ocr-render' | 'ocr-image' | 'well-image' | 'archive-image'
  title: string
  snippet: string
  text: string
  rank: number
  deck: string
  deckTitle: string
  filename: string
  category: string
  date: string | null
  slideOrder: number | null
  usedInDecks: number
  reference: string // `[use: ppt:<id>#<order>]`
  thumbUrl: string | null
  library?: 'mine' | 'others' // which archive store this came from (Others' Library = badged)
  ownership?: string // deck ownership (mine|others|unknown) — for the author label
  author?: string // raw deck author ('' when none)
  score?: MatchScore // Match switch: the card's score label ('words 0.91' / 'meaning 0.78')
}
export type MatchMode = 'words' | 'meaning' | 'both'
export type MatchScore = { kind: 'words' | 'meaning'; value: number; label: string }
export type MatchedSearchResult = {
  requested: MatchMode
  mode: MatchMode // what ran: 'words' when the model is missing, the query is empty or the picture query failed
  modelReady: boolean
  words: SlideClusterResult[]
  related: SlideClusterResult[]
  pictureError: string | null
  ms: { words: number; meaning: number | null }
}
export type MoreLikeThisResult = { state: 'ok' | 'no-model' | 'not-indexed' | 'none' | 'error'; items: SlideResult[]; error?: string }
export type SlideClusterResult = {
  representative: SlideResult
  members: SlideResult[]
  size: number
  deckCount: number
}
export type SearchFilters = {
  owner: 'mine' | 'all' | 'others' | 'unknown'
  era: string // 'all' | 'recent' | 'mid' | 'early' | a year like '2024'
  category: string // '' = all categories
  deck: string // '' = any deck; else a deck name/substring
  role: 'content' | 'all'
  cluster: boolean
  from: FromFilter // where the result came from (replaces the old Source switch)
  kind: KindFilter // what the picture shows
  type: 'slides' | 'images' | 'decks'
  // Which archive store to search: the user's own, the separate Others' Library, or both (ADR-0031).
  library: 'mine' | 'others' | 'all'
}
export type CategoryCount = { category: string; count: number }
// An external tool SlideWell depends on, with detected presence — shown in Settings (REQUIREMENTS.md).
export type Dependency = {
  key: string
  label: string
  found: boolean
  detail: string
  requiredFor: string
  install: string
  required: boolean
}
// A scanned item in a Triage source (ADR-0029) — not yet in the library unless state==='included'.
export type TriageItem = {
  hash: string // content hash — the DECISION key; repeats across duplicate files (not unique)
  relPath: string // absolute path — unique per file across sources; use as the React key
  kind: 'image' | 'video'
  filename: string
  ext: string
  state: 'undecided' | 'selected' | 'included' | 'excluded'
  offline: boolean // OneDrive online-only placeholder — not downloaded, so not read/thumbnailed
  mtime: number // file modified time (epoch ms) — capture time, for sort/group by date
  date: string // YYYY-MM-DD derived from mtime
  sizeMB: number
  large: boolean // video over the 20 MB gate — include needs an explicit confirm
  snippet: string
  thumbUrl: string | null
  mediaUrl: string | null // video source file (for inline playback); null for images
  source: string // absolute root of the capture source the file came from
  takenAt: string | null // local time parsed from a screenshot file name (YYYY-MM-DDTHH:MM:SS)
  app: string | null // source app parsed from a CleanShot name
  windowTitle: string | null // window title parsed from a CleanShot name
  pile?: ReviewPile | null // review pile when the sorter made a proposal (a throwaway shows 'bin in N days')
  binInDays?: number | null
}
// Review screen (ticket 08): one screenshot the sorter proposed something for, as a card.
export type ReviewPile = 'doubtful' | 'kept' | 'throwaway' | 'bin'
export type ReviewCard = {
  hash: string // triage content hash (the decision key)
  filename: string
  app: string | null
  windowTitle: string | null
  takenAt: string | null
  reason: string // the sorter's reason, in words
  confidence: number
  proposal: 'keep' | 'throwaway' | 'doubtful'
  pile: ReviewPile
  by: 'you' | 'sorter' // his decision, or a proposal he has not overridden
  binInDays: number | null // Throwaway only: whole days before it moves to the Bin
  thumbUrl: string | null
  offline: boolean
}
export type ReviewOverview = {
  needALook: number
  confident: { kept: number; throwaway: number } // proposals he has not overridden
  lastSortedAt: string | null
  queue: ReviewCard[] // the doubtful queue, newest first
  confidentSample: ReviewCard[]
  canUndo: boolean
}
export type ReviewPiles = {
  needALook: number
  confidentTotal: number
  lastSortedAt: string | null
  kept: { total: number; items: ReviewCard[] }
  throwaway: { total: number; items: ReviewCard[] }
  bin: { total: number; items: ReviewCard[]; token: string } // token: Empty Bin acts only on this set
  canUndo: boolean
}
export type ReviewActResult = { ok: boolean; hash: string; message: string; pile?: ReviewPile }
export type ReviewUndoResult = { ok: boolean; hash?: string; message: string }
// changed: Bin items that changed between his confirm and the write (rescued, re-decided) and were left alone
export type EmptyBinResult = { ok: boolean; emptied: number; changed: number; message: string }
export type ReviewPage = { total: number; offset: number; items: ReviewCard[]; nextOffset: number | null }
export type TriageCounts = { undecided: number; selected: number; included: number; excluded: number; total: number }
export type DeckInfo = { id: string; title: string; date: string | null }
export type DeckCard = {
  id: string
  title: string
  date: string | null
  category: string
  filename: string
  ownership: string
  author?: string
  slideCount: number
  coverThumbUrl: string | null
  library?: 'mine' | 'others'
}
export type DeckDetail = {
  id: string
  title: string
  date: string | null
  dateSource: string
  category: string
  filename: string
  ownership: string
  author?: string
  library?: 'mine' | 'others'
  sourcePath: string
  sectionCount: number
  slideCount: number
}

// Picture search (ticket 03). Same shapes as src/main/picture-search/service.ts, kept here so the web
// project needs no main-process file.
export type PictureIndexProgress = {
  phase: 'idle' | 'indexing' | 'paused' | 'done' | 'error'
  done: number
  total: number
  failed: number
  secondsLeft: number | null
  error?: string
}
// Backlog import (ticket 13): the dry-run view (counts, sizes, examples — never the file list), the
// result of a real run, and CleanShot's export setting. Mirrors main/backlog-plan.ts + backlog-import.ts.
export type BacklogSourceSummary = { count: number; bytes: number; examples: string[] }
export type BacklogPlanView =
  | {
      ok: true
      date: string
      watchedFolder: string
      desktopDir: string
      cleanshotDir: string | null
      summary: {
        desktop: BacklogSourceSummary
        cleanshot: BacklogSourceSummary
        recopy: number
        done: number
        unverifiedOnlineOnly: number
        onlineOnly: number
        nameTaken: number
        totalBytes: number
        skipped: { cleanshotProjects: number; cleanshotOther: number; empty: number; notRegular: number }
        leftoverStaged: number
      }
    }
  | { ok: false; reason: 'no-watched-folder' | 'watched-folder-overlaps'; detail: string }
export type BacklogRunResult = {
  ok: boolean
  cancelled: boolean
  copied: number
  reused: number
  alreadyDone: number
  unverifiedOnlineOnly: number
  onlineOnly: number
  notRegular: number
  gone: number
  failed: number
  desktopWithCopy: number
  logPath: string
  errors: string[]
}
export type BacklogProgress = { done: number; total: number; name: string }
export type CleanShotSetting = { current: string | null; target: string; command: string; matches: boolean }

export type PictureSearchStatus = {
  model: 'absent' | 'partial' | 'downloading' | 'ready'
  modelBytes: number
  download: { receivedBytes: number; totalBytes: number } | null
  error: string | null
  includeWell: boolean
  paused: boolean
  index: PictureIndexProgress
  text: string // status-bar words, '' when nothing to show
  coverage: number // % of images with meaning results so far
  estimate: { slides: number; wellImages: number; text: string } | null
}
// ids: `slide:<presentation id>#<slide order>` or `well:<well id>`; score = cosine similarity.
export type PictureQuery = { text: string } | { imageId: string }
export type PictureScored = { id: string; score: number }

// Screenshot sorter, local part (ticket 06). Same shapes as src/main/sorter/{accuracy,service}.ts.
export type SorterPrecisionLine = { proposed: number; correct: number; precision: number | null }
export type SorterAccuracy = {
  sample: number
  truth: { keep: number; throwaway: number }
  keep: SorterPrecisionLine
  throwaway: SorterPrecisionLine
  doubtful: { count: number; share: number }
  keptProposedThrowaway: number
  binnedProposedKeep: number
}
// One band of predicted p(throwaway): how many, mean prediction, share he actually binned.
export type SorterReliabilityRow = { from: number; to: number; n: number; meanPredicted: number | null; observed: number | null }
export type SorterReport = {
  trainedAt: string
  sorterVersion: string
  thresholds: { throwaway: number; keep: number }
  holdOutFraction: number
  labelled: { keep: number; throwaway: number }
  usable: { keep: number; throwaway: number }
  keepFromWellCopy: number
  grouping: { groups: number; largest: number; cosine: number; minutes: number }
  enoughToMeasure: boolean
  trainedOn: { keep: number; throwaway: number }
  l2: number
  calibration: {
    chosen: 'platt' | 'isotonic'
    brier: { raw: number; platt: number; isotonic: number }
    reliability: { platt: SorterReliabilityRow[]; isotonic: SorterReliabilityRow[] }
  } | null
  heldBackClassifier: { auc: number | null; brier: number; reliability: SorterReliabilityRow[] }
  heldBack: SorterAccuracy
  rulesOnly: SorterAccuracy
}
export type SorterStatus = {
  phase: 'idle' | 'embedding' | 'training' | 'sorting' | 'error'
  done: number
  total: number
  message: string
  error: string | null
  modelReady: boolean
  report: SorterReport | null
  canRunUnattended: boolean
  retrainNeeded: boolean
  minHeldBack: { total: number; perLabel: number }
  pending: { keep: number; throwaway: number; doubtful: number; lastProposedAt: string | null }
}

const api = {
  // Picture search: model download/delete, background indexing, query by text or by image id.
  picture: {
    status: (): Promise<PictureSearchStatus> => ipcRenderer.invoke('picture:status'),
    estimate: (): Promise<PictureSearchStatus['estimate']> => ipcRenderer.invoke('picture:estimate'),
    download: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('picture:download'),
    cancelDownload: (): Promise<void> => ipcRenderer.invoke('picture:cancel-download'),
    deleteModel: (): Promise<void> => ipcRenderer.invoke('picture:delete-model'),
    pause: (): Promise<void> => ipcRenderer.invoke('picture:pause'),
    resume: (): Promise<void> => ipcRenderer.invoke('picture:resume'),
    setIncludeWell: (on: boolean): Promise<void> => ipcRenderer.invoke('picture:set-include-well', on),
    query: (q: PictureQuery, opts?: { limit?: number; kinds?: Array<'slide' | 'well-image'> }): Promise<{ ok: boolean; results: PictureScored[]; error?: string }> =>
      ipcRenderer.invoke('picture:query', q, opts),
    queryCount: (): Promise<number> => ipcRenderer.invoke('picture:query-count'),
    onStatus: (cb: (s: PictureSearchStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: PictureSearchStatus): void => cb(s)
      ipcRenderer.on('picture:status', handler)
      return () => ipcRenderer.removeListener('picture:status', handler)
    }
  },
  // Screenshot sorter: train + accuracy report on his past choices; propose keep/throwaway/doubtful for undecided screenshots.
  sorter: {
    status: (): Promise<SorterStatus> => ipcRenderer.invoke('sorter:status'),
    train: (): Promise<{ ok: boolean; cancelled?: boolean; report?: SorterReport; error?: string }> => ipcRenderer.invoke('sorter:train'),
    sort: (opts?: { limit?: number }): Promise<{ ok: boolean; sorted?: number; counts?: { keep: number; throwaway: number; doubtful: number }; error?: string }> =>
      ipcRenderer.invoke('sorter:sort', opts),
    cancel: (): Promise<void> => ipcRenderer.invoke('sorter:cancel'),
    onStatus: (cb: (s: SorterStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: SorterStatus): void => cb(s)
      ipcRenderer.on('sorter:status', handler)
      return () => ipcRenderer.removeListener('sorter:status', handler)
    }
  },
  archive: {
    // Is the Core A (ppt-archive) extraction store present?
    available: (): Promise<boolean> => ipcRenderer.invoke('archive:available'),
    // Slide + OCR search with filters; returns clusters (size-1 clusters when clustering is off).
    search: (query: string, filters: SearchFilters): Promise<SlideClusterResult[]> =>
      ipcRenderer.invoke('archive:search', query, filters),
    // The same search with the Match switch: word hits and picture hits in two bands, with scores.
    searchMatched: (query: string, filters: SearchFilters, mode: MatchMode): Promise<MatchedSearchResult> =>
      ipcRenderer.invoke('archive:search-matched', query, filters, mode),
    // More like this: the six most similar items (other presentations and the well), each with a meaning score.
    moreLikeThis: (row: { kind: string; deck: string; slideOrder: number | null; reference: string }): Promise<MoreLikeThisResult> =>
      ipcRenderer.invoke('archive:more-like-this', row),
    // Counts for the From chips (current query, Kind applied).
    fromCounts: (query: string, filters: SearchFilters): Promise<FromCounts> => ipcRenderer.invoke('archive:from-counts', query, filters),
    // Distinct deck categories (with counts) for the Category filter.
    categories: (): Promise<CategoryCount[]> => ipcRenderer.invoke('archive:categories'),
    // All decks (newest-first) for the Deck filter picker.
    decks: (): Promise<DeckInfo[]> => ipcRenderer.invoke('archive:decks'),
    // Deck MODE: one card per presentation (title-slide cover).
    listDecks: (filters: SearchFilters): Promise<DeckCard[]> => ipcRenderer.invoke('archive:list-decks', filters),
    // Full metadata for one deck (sidebar).
    deckDetail: (pid: string): Promise<DeckDetail | null> => ipcRenderer.invoke('archive:deck-detail', pid),
    // Stats bundle (timeline of "my" PowerPoint history).
    stats: (): Promise<Stats | null> => ipcRenderer.invoke('archive:stats'),
    // The structured content (presentation.json node) of one slide — for "Copy structure" / inspector JSON.
    slideStructure: (deck: string, slideOrder: number | null): Promise<string | null> =>
      ipcRenderer.invoke('archive:slide-structure', deck, slideOrder),
    // The embedded image assets on one slide (for the inspector).
    slideImages: (deck: string, slideOrder: number | null): Promise<Array<{ thumbUrl: string | null }>> =>
      ipcRenderer.invoke('archive:slide-images', deck, slideOrder),
    // All slides of one presentation, in order — for "See in context".
    deckSlides: (deck: string): Promise<SlideResult[]> => ipcRenderer.invoke('archive:deck-slides', deck),
    // Copy an image FILE (WebP) to the clipboard (TalkWeaver keeps it as-is). Pass the hit's thumbUrl.
    copyImage: (thumbUrl: string | null): Promise<boolean> => ipcRenderer.invoke('clipboard:copy-image', thumbUrl),
    // Copy as a PNG raster bitmap (for Keynote / Slack / web). Pass the hit's thumbUrl.
    copyImagePng: (thumbUrl: string | null): Promise<boolean> => ipcRenderer.invoke('clipboard:copy-image-png', thumbUrl),
    // Reveal an image in Finder. Pass the hit's thumbUrl.
    reveal: (thumbUrl: string | null): Promise<boolean> => ipcRenderer.invoke('shell:reveal', thumbUrl),
    // Re-scan the TalkWeaver vault for new images; returns count added.
    scanVault: (): Promise<number> => ipcRenderer.invoke('well:scan-vault'),
    // Delete every Others' Library deck matching the current query + filters, then rebuild its
    // index (ADR-0031). No filter → deletes the whole Others' Library. Never touches your archive.
    deleteOthersMatching: (query: string, filters: SearchFilters): Promise<{ ok: boolean; deleted?: number; cancelled?: boolean }> =>
      ipcRenderer.invoke('others:delete-matching', query, filters)
  },
  settings: {
    getPaths: (): Promise<{
      archiveRoot: string | null
      archiveDefault: string
      archiveAvailable: boolean
      wellRoot: string
      vaultRoot: string | null
      vaultAvailable: boolean
      screenshotRoot: string | null
      screenshotAvailable: boolean
      captureSources: { path: string; namedOnly: boolean; exists: boolean }[]
      captureDefaults: { desktop: { path: string; namedOnly: boolean }; cleanshot: { path: string; namedOnly: boolean } | null }
      conversionsRoot: string | null
      convertOcrDefault: boolean
      othersArchiveRoot: string
      othersArchiveAvailable: boolean
    }> => ipcRenderer.invoke('settings:get-paths'),
    chooseArchive: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-archive'),
    chooseVault: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-vault'),
    // Capture inbox extras: add an offered default ('desktop' = screenshot-named files only, 'cleanshot') or any folder.
    addCaptureSource: (which: 'desktop' | 'cleanshot' | 'folder'): Promise<boolean> => ipcRenderer.invoke('settings:add-capture-source', which),
    removeCaptureSource: (path: string): Promise<boolean> => ipcRenderer.invoke('settings:remove-capture-source', path),
    chooseScreenshotFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-screenshot-folder'),
    // Default destination folder for throwaway conversions (pre-fills the convert save dialog).
    chooseConversionsFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-conversions-folder'),
    // Persist the default state of the convert OCR toggle.
    setConvertOcr: (on: boolean): Promise<boolean> => ipcRenderer.invoke('settings:set-convert-ocr', on),
    // "My decks": the author names that count as the user (isDefault → computed from the OS account).
    getOwnerNames: (): Promise<{ names: string[]; isDefault: boolean }> => ipcRenderer.invoke('settings:get-owner-names'),
    // Save the list; an empty list reverts to the account default. Returns the effective names.
    setOwnerNames: (names: string[]): Promise<{ names: string[]; isDefault: boolean }> => ipcRenderer.invoke('settings:set-owner-names', names),
    // Others' Library (Scenario A): pick its separate store folder, or purge it wholesale.
    chooseOthersFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-others-folder'),
    clearOthersLibrary: (): Promise<{ ok: boolean; cancelled?: boolean }> => ipcRenderer.invoke('settings:clear-others-library'),
    // R2 cloud backend (spec 2026-06-24): read non-secret config + whether creds are saved; save
    // config/creds (secret is write-only — never returned); test the connection.
    getR2: (): Promise<{ accountId: string; endpoint: string; bucket: string; prefix: string; hasCreds: boolean }> => ipcRenderer.invoke('settings:get-r2'),
    setR2: (patch: { accountId?: string; endpoint?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string }): Promise<{ ok: boolean; gotKeys: boolean; encAvailable: boolean; savedCreds: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:set-r2', patch),
    testR2: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('settings:test-r2'),
    // Per-store backend (Local | R2) + media sync to R2 (spec 2026-06-24).
    getStorage: (): Promise<{ archive: 'local' | 'r2'; others: 'local' | 'r2'; well: 'local' | 'r2' }> => ipcRenderer.invoke('settings:get-storage'),
    setStoreBackend: (store: 'archive' | 'others' | 'well', backend: 'local' | 'r2'): Promise<{ ok: boolean }> => ipcRenderer.invoke('settings:set-store-backend', store, backend),
    syncStore: (store: 'archive' | 'others' | 'well'): Promise<{ ok: boolean; uploaded?: number; skipped?: number; failed?: number; error?: string }> => ipcRenderer.invoke('settings:sync-store', store),
    // Detected status of external tools (engine, OCR, ffmpeg, LibreOffice…) + the Requirements URL.
    dependencies: (): Promise<{ requirementsUrl: string; deps: Dependency[] }> => ipcRenderer.invoke('settings:dependencies')
  },
  // Triage source workflow (ADR-0029): scan a folder, browse/decide, promote keepers into the well.
  triage: {
    scan: (): Promise<{ ok: boolean; indexed: number; total: number; offline: number }> => ipcRenderer.invoke('triage:scan'),
    list: (
      query: string,
      state: string,
      sort?: 'scanned' | 'date-desc' | 'date-asc',
      limit?: number,
      offset?: number
    ): Promise<{ items: TriageItem[]; counts: TriageCounts; hasMore: boolean }> => ipcRenderer.invoke('triage:list', query, state, sort, limit, offset),
    // refused: the item was emptied from the Bin (permanent); nothing changed
    decide: (hash: string, action: 'select' | 'exclude' | 'reset', force?: boolean): Promise<{ state: string; refused?: string }> =>
      ipcRenderer.invoke('triage:decide', hash, action, force),
    importSelected: (forceHashes?: string[]): Promise<{ imported: number; skipped: number; gated: number }> =>
      ipcRenderer.invoke('triage:import-selected', forceHashes ?? []),
    // Paste-to-include: ingest the clipboard image straight into the well. Returns the new id or null.
    paste: (): Promise<{ id: string } | null> => ipcRenderer.invoke('well:add-from-clipboard'),
    // A watched source got a new file and was re-scanned; re-list. Returns an unsubscribe function.
    onChanged: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('triage:changed', handler)
      return () => ipcRenderer.removeListener('triage:changed', handler)
    },
    // Stream scan progress; returns an unsubscribe function.
    onProgress: (cb: (line: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('triage:progress', handler)
      return () => ipcRenderer.removeListener('triage:progress', handler)
    }
  },
  // Review screen (ticket 08). act/undo/emptyBin write his decisions; nothing here deletes or moves any
  // file. emptyBin needs the token of the Bin he confirmed and only hides those items for good.
  review: {
    overview: (opts?: { queue?: number; sample?: number }): Promise<ReviewOverview> => ipcRenderer.invoke('review:overview', opts ?? {}),
    piles: (opts?: { kept?: number; throwaway?: number; bin?: number }): Promise<ReviewPiles> => ipcRenderer.invoke('review:piles', opts ?? {}),
    // any further page of one pile, by offset (no cap on how far)
    page: (pile: 'kept' | 'throwaway' | 'bin', offset: number, limit?: number): Promise<ReviewPage> => ipcRenderer.invoke('review:page', pile, offset, limit),
    act: (hash: string, action: 'keep' | 'throwaway' | 'rescue'): Promise<ReviewActResult> => ipcRenderer.invoke('review:act', hash, action),
    undo: (): Promise<ReviewUndoResult> => ipcRenderer.invoke('review:undo'),
    emptyBin: (token: string): Promise<EmptyBinResult> => ipcRenderer.invoke('review:empty-bin', token)
  },
  // One-off backlog import (ticket 13). dryRun writes nothing; run needs the id of the plan just shown.
  backlog: {
    dryRun: (): Promise<{ id: string; plan: BacklogPlanView } | null> => ipcRenderer.invoke('backlog:dry-run'),
    run: (planId: string): Promise<{ result?: BacklogRunResult; refused?: string } | null> => ipcRenderer.invoke('backlog:run', planId),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('backlog:cancel'),
    showLogs: (): Promise<boolean> => ipcRenderer.invoke('backlog:show-logs'),
    cleanShotSetting: (): Promise<CleanShotSetting | null> => ipcRenderer.invoke('backlog:cleanshot-setting'),
    // Changes CleanShot's export folder to the watched folder. Only ever called from a click.
    // `shown` = the exact folder the user saw; main refuses if it is no longer the watched folder.
    setCleanShot: (shown: string): Promise<(CleanShotSetting & { ok: boolean; refused?: undefined }) | { refused: string } | null> => ipcRenderer.invoke('backlog:set-cleanshot', shown),
    onProgress: (cb: (p: BacklogProgress) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, p: BacklogProgress): void => cb(p)
      ipcRenderer.on('backlog:progress', handler)
      return () => ipcRenderer.removeListener('backlog:progress', handler)
    }
  },
  shell: {
    openPath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:open-path', path),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url)
  },
  ingest: {
    // Run Core A's pipeline over the configured archive roots (crawl → extract → render → OCR).
    pending: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('ingest:pending'),
    // Pick a .pptx or a folder to import; returns the path so the panel shows it first (null = cancelled).
    choosePath: (): Promise<string | null> => ipcRenderer.invoke('ingest:choose-path'),
    // Import an already-chosen path (extract + OCR). library 'others' routes it into the separate
    // Others' Library store instead of the user's archive (ADR-0031).
    runPath: (targetPath: string, library?: 'mine' | 'others'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('ingest:run-path', targetPath, library),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('ingest:cancel'),
    // Subscribe to streamed progress lines; returns an unsubscribe function.
    onLine: (cb: (line: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('ingest:line', handler)
      return () => ipcRenderer.removeListener('ingest:line', handler)
    }
  },
  // Sideband, throwaway: convert someone else's .pptx to a mechanical Outline folder you pick.
  // Never catalogued into the archive or vault (distinct from `ingest`). Streams progress lines.
  convert: {
    // Step 1: pick the source .pptx (null = cancelled). Step 2: pick the destination folder
    // (pre-filled from the source name + conversionsRoot). Step 3: run with both chosen.
    chooseSource: (): Promise<string | null> => ipcRenderer.invoke('convert:choose-source'),
    chooseDest: (sourcePath: string): Promise<string | null> => ipcRenderer.invoke('convert:choose-dest', sourcePath),
    run: (opts: { pptxPath: string; outDir: string; ocr: boolean }): Promise<{ ok: boolean; cancelled?: boolean; outDir?: string; error?: string }> =>
      ipcRenderer.invoke('convert:run', opts),
    onLine: (cb: (line: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('convert:line', handler)
      return () => ipcRenderer.removeListener('convert:line', handler)
    }
  }
}

contextBridge.exposeInMainWorld('sw', api)

declare global {
  interface Window {
    sw: typeof api
  }
}

export type SwApi = typeof api

import { contextBridge, ipcRenderer } from 'electron'
import type { Stats } from '../main/stats'
import type { ImportSnapshot } from '../main/triage-import-progress'

export type { Stats } from '../main/stats'
export type { ImportSnapshot } from '../main/triage-import-progress'
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

/** A talk that uses a picture: its title, its outline file (vault-relative) and the slide of its first use. */
export type TalkUse = { title: string; relPath: string; slide: number | null }

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
  usedInTalks?: number // TalkWeaver talks that use this picture (vault images only)
  talkUses?: TalkUse[] // those talks, by title
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
  /** Set when the cluster was merged by appearance ("N versions"): every pair is at least this alike. */
  lookAlike?: 'same-picture' | 'same-thing'
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
// Triage by source app (ticket 20). An app name is the one parsed from a CleanShot file name; '' = app not known.
// Names compare trimmed and without case; `app` is the most common spelling.
export type TriageAppCount = {
  app: string
  count: number // file rows in the state tab asked for
  kept: number // his decisions for pictures from this app: selected or included
  thrownAway: number // ... excluded
  keptShare: number | null // kept / (kept + thrownAway); null when he has decided none
}
// Bulk decide: `count` is what main counted; refused 'count-changed' = it differs from the count shown, nothing was decided
// changed: file rows from the ticked apps now decided; skipped: rows left undecided because the same picture also sits undecided
// under an app that was not ticked (a decision is per picture); count: the undecided rows matched (changed + skipped when ok)
export type TriageBulkResult = { ok: boolean; changed: number; skipped: number; count: number; refused?: 'count-changed' | 'bad-arguments' }
// "What the sorter goes by" (ticket 20). Same shapes as src/main/sorter/app-rules.ts.
export type AppLean = 'keep' | 'throwaway'
export type SorterAppSuggestion = {
  kind: 'make' | 'change' // make a rule (none in force) or change the one in force (it says the opposite)
  rule: AppLean // the rule suggested; setAppRule(app, rule) accepts it
  share: number // the share of his decisions that went that way (0.85..1)
  against: 'built-in' | 'yours' | null // whose rule a change is against
  text: string // the chip, e.g. "You threw away 94% — make it a rule?"
  action: string // the chip's button: "Make rule" | "Change rule"
}
export type SorterAppReading = {
  app: string
  kept: number
  keptShare: number | null
  thrownAway: number
  undecided: number // file rows, as the Undecided tab counts them
  builtIn: AppLean | null // the built-in rule that fires on this app name alone
  rule: AppLean | null // his rule; when set it takes the place of the built-in one
  suggestion: SorterAppSuggestion | null
}
export type SorterGoesBy = {
  apps: SorterAppReading[] // most screenshots first, "app not known" last
  builtIn: { keep: string[]; throwaway: string[] } // the built-in rules in words
}
// Sort runs (ticket 20). Same shapes as src/main/sorter/runs.ts.
export type SortRun = {
  id: string
  startedAt: string
  finishedAt: string | null // null while it runs (or when the app quit mid-sort)
  period: SortPeriod
  trigger: 'manual' | 'nightly'
  counts: { sorted: number; kept: number; thrownAway: number; unsure: number } // as the sort ended
  // the screenshots this run still holds (one sorted again later is in its latest sort only), by pile as it is now:
  // his decision when he has made one, else the sorter's proposal
  now: { kept: number; thrownAway: number; unsure: number }
}
export type SortRunPile = 'kept' | 'throwaway' | 'unsure'
export type SortRunCard = {
  hash: string // triage content hash; triage.decide(hash, …) moves it
  filename: string
  app: string | null
  windowTitle: string | null
  takenAt: string | null
  reason: string
  confidence: number
  lowConfidence: boolean
  proposal: 'keep' | 'throwaway' | 'doubtful' // what the sorter said
  pile: SortRunPile // where it is now
  decidedBy: 'rules' | 'history' | 'luna' | 'haiku' | null // rules / past choices / Luna / Haiku; null for a local unsure
  decision: 'selected' | 'included' | 'excluded' | null // his own decision, if he has since made one
  thumbUrl: string | null
  offline: boolean
}
export type SortRunPage = { total: number; items: SortRunCard[]; next: string | null } // next: cursor for sorter.runPage
export type SortRunPiles = { run: SortRun | null; kept: SortRunPage; throwaway: SortRunPage; unsure: SortRunPage } // run null = no such sort (any more)
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
  decidedBy: 'rules' | 'history' | 'luna' | 'haiku' | null // which sorter step made the call (shown as rules / your history / asked Luna / asked Haiku)
  binInDays: number | null // Throwaway only: whole days before it moves to the Bin
  thumbUrl: string | null
  offline: boolean
  // why there is, or is not, a picture: ok = thumbUrl works; not-downloaded = only a cloud placeholder exists here;
  // missing = no copy at any recorded path (or outside the folders SlideWell may read); none = no file record, or a video with no poster
  picture: 'ok' | 'not-downloaded' | 'missing' | 'none'
  revealUrl: string | null // swarchive URL of the original, for "Open in Finder" (set when a copy exists here)
  expectedDir: string | null // missing only: the folder the file was recorded in
  // teach the sorter (ticket 22)
  pKeep: number // the sorter's p(keep) for it, 0..1 (rule, your history and look-alike combined); throwaway = 1 - pKeep
  leans: 'keep' | 'throwaway' // the way it leans: keep when pKeep is at least 0.5
  why: string // the reason in plain words from his own history when there is one ("You kept 3 of the last 14 from Preview"), else `reason`
}
// Teach the sorter (ticket 22): the doubtful screenshots he has not decided, the one the sorter is least sure of first
// (pKeep nearest 0.5; newest first when equal). `next` is an opaque cursor for sorter.teachQueue (null = no more).
export type TeachQueue = { total: number; items: ReviewCard[]; next: string | null }
export type ReviewOverview = {
  needALook: number
  confident: { kept: number; throwaway: number } // proposals he has not overridden
  lastSortedAt: string | null
  queue: ReviewCard[] // the doubtful queue, newest first; with order 'teach', the one the sorter is least sure of first
  confidentSample: ReviewCard[]
  /** Counts with no "how sure" range applied (the same as needALook and confident when none is set). */
  all: { needALook: number; confident: number }
  canUndo: boolean
}
/** A "how sure" range, fractions 0.5..1, both ends inclusive (compared as the whole percents the card shows). */
export type ReviewSure = { min: number; max: number }
export type ReviewPiles = {
  needALook: number
  confidentTotal: number
  lastSortedAt: string | null
  kept: { total: number; items: ReviewCard[]; next: string | null } // next: cursor for review.page
  throwaway: { total: number; items: ReviewCard[]; next: string | null }
  bin: { total: number; items: ReviewCard[]; next: string | null; token: string | null } // token: Empty Bin acts only on this set; null when the piles were read under a how-sure range (never a token for part of the Bin)
  canUndo: boolean
}
export type ReviewActResult = { ok: boolean; hash: string; message: string; pile?: ReviewPile }
export type ReviewUndoResult = { ok: boolean; hash?: string; message: string }
// changed: Bin items that changed between his confirm and the write (rescued, re-decided) and were left alone
export type EmptyBinResult = { ok: boolean; emptied: number; changed: number; message: string }
// Review answers given on cards that had no picture (review/rescue.ts): kept = keptImported + keptNotImported.
// Put back: thrownAway and keptNotImported. Left alone: keptImported (in the well) and emptied (emptying is permanent).
// items: every one found, newest answer first, from the same read as the counts and the token; putBack = the confirm puts it back.
// picture: why the card had no picture; recorded: true = as recorded when he answered, false = an older answer, as it is on this Mac now
export type ReviewBlindItem = { hash: string; filename: string; answer: 'keep' | 'throwaway'; picture: 'not-downloaded' | 'missing' | 'none'; recorded: boolean; putBack: boolean }
export type ReviewBlindAnswers = { thrownAway: number; kept: number; keptImported: number; keptNotImported: number; emptied: number; items: ReviewBlindItem[]; token: string }
/** `retrain`: an id for the retrain asked for after the answers went back (pass it to review.rescueRetrain). */
export type ReviewRescueResult = { ok: boolean; reset: number; error?: string; retrain?: number }
/** How that retrain ended: ok, or the reason it did not finish. */
export type ReviewRescueRetrain = { ok: boolean; error?: string }
// keyset paging: `next` is an opaque cursor (null = no more); pass it to review.page
export type ReviewPage = { total: number; items: ReviewCard[]; next: string | null }
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
        needDownloading: { count: number; bytes: number } // online-only, in the plan: downloaded one at a time during the run
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
  downloaded: number
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
  choicesAtTraining?: number // his choices with a readable picture when this was trained (absent on an older report: usable.keep + usable.throwaway)
  appRulesFingerprint?: string // his per-app rules as they were when this was measured (absent on an older report: no rules)
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
  canRunUnattended: boolean // false also while rulesChangedSinceTest
  retrainNeeded: boolean
  rulesChangedSinceTest: boolean // his app rules differ from those the report was measured with: Sort now works, unattended sorting waits for Train again
  minHeldBack: { total: number; perLabel: number }
  pending: { keep: number; throwaway: number; doubtful: number; lastProposedAt: string | null }
  period: SortPeriod | null // the period both sort buttons are limited to; null when the stored one cannot be read (main then sorts nothing)
  periods: ReadonlyArray<{ id: SortPeriod; label: string }>
  lastRun: SorterLocalRun | null // the last sort on this Mac as numbers; kept across restarts
  // undecided screenshots a sort would look at, in the chosen period (inPeriod is null when the period cannot be read) and in all;
  // counted in main when status() is called, after a sort and when the period changes; null until first counted
  undecided: { period: SortPeriod | null; inPeriod: number | null; all: number } | null
  learnable: { kept: number; binned: number } | null // his choices the sorter can learn from (with a readable picture); counted with undecided
} & SorterTeachStatus
// Teach the sorter (ticket 22). Same shapes in src/main/sorter/retrain.ts (it imports these).
export type RetrainTrigger = 'manual' | 'round' | 'auto' // Train / Retrain now; the end of a teaching round; by itself after ten answers
export type SorterRightShares = { throwawayRight: number | null; keepRight: number | null } // 0..1 on the held-back sample; null = it proposed none of that kind
// One retrain and what it moved. Kept across restarts.
export type SorterRetrain = {
  at: string
  trigger: RetrainTrigger
  choices: { before: number; after: number } // his choices the model before / the new model was trained with (before 0 = there was none)
  needALook: { before: number; after: number } | null // before: the doubtful proposals among his undecided screenshots that the re-score read (it reads no others; one the sorter was sure about is never re-scored); after: those of them still doubtful; null = what moved could not be checked, or the re-score was stopped part-way
  movedToSure: { keep: number; throwaway: number } | null // were doubtful, now keep / throwaway; null with needALook
  accuracy: { before: SorterRightShares | null; after: SorterRightShares } // held-back accuracy of the model before (null = none) and after
  movedHashes: string[] // up to 200 screenshots that moved to sure (none when what moved could not be checked)
}
export type SorterTeachStatus = {
  answersSinceTraining: number // his choices now minus those the model in use was trained with (0 without a current model or before the first count)
  retrainEvery: number // 10
  autoRetrain: boolean // "Retrain by itself after every ten answers"
  autoRetrainOnBattery: boolean // true = also while on battery ("Not while on battery" switched off)
  retraining: RetrainTrigger | null // a retrain is running now, and what started it
  waitingForPower: { answers: number } | null // ten or more answers are waiting and the Mac is on battery: it retrains when power returns or on Retrain now
  choicesNeeded: number // how many more choices before a training can be measured (0 = enough); below it the sorter does not retrain by itself
  lastRetrain: SorterRetrain | null
}
// "How much is enough" (ticket 22): the sorter trained on growing parts of his choices, each tested on the same held-back sample.
export type SorterLearningPoint = { choices: number; throwawayRight: number | null; needALook: number | null } // shares 0..1; null = could not be measured at that size
export type SorterLearning = {
  verdict: 'not-enough' | 'still-helping' | 'levelling-off'
  more: number // not-enough: how many more choices are needed; otherwise 0
  minimum: number // the fewest choices a training can be measured with (92: 46 kept and 46 thrown away)
  choices: number // kept + thrownAway
  kept: number
  thrownAway: number
  heldBack: number // size of the held-back sample every point was tested on (0 when nothing was computed)
  points: SorterLearningPoint[] // at most 6, growing; the last is all his choices
  trainedAt: string | null // the training this reading was made for (it is computed once per training)
  error?: string // why there are no points although there are enough choices
}
// One sort on this Mac: when it ended, its period, how many it looked at, how many got keep or throwaway, how many stayed doubtful.
export type SorterLocalRun = { at: string; period: SortPeriod; lookedAt: number; confident: number; needLook: number }
// The period a manual sort is limited to, by each screenshot's capture time (src/main/sorter/period.ts).
// The renderer only names one of these; main stores it, works out the cut-off from its own clock and
// refuses anything else. The nightly sort ignores it.
export type SortPeriod = '7d' | '30d' | '90d' | 'all'
export type SortResult = { ok: boolean; sorted?: number; counts?: { keep: number; throwaway: number; doubtful: number }; error?: string; period?: SortPeriod; periodPhrase?: string }

// Screenshot sorter, cloud step (tickets 07, 16). Same shapes as src/main/sorter/cloud/service.ts.
// provider = which company is asked: OpenAI (Luna) or Anthropic (Haiku).
// enabled = the service is on and he has agreed to that provider (main stores when; agreeing to one is not
// agreeing to the other; off keeps provider, keys and agreements); nightly = the nightly batch runs (only while
// enabled); secondOpinions = a provider may be asked about what the other was unsure about; agreedAt = when he
// agreed to each provider (read only); the per-night limit is fixed in main (nightlyLimit) and shared by both
export type CloudProviderId = 'openai' | 'anthropic'
export type CloudSettings = { enabled: boolean; batchTime: string; provider: CloudProviderId; nightly: boolean; secondOpinions: boolean; agreedAt: Record<CloudProviderId, string | null> }
// What cloud.setSettings takes; the two switches have their own calls, and nothing else can be set.
export type CloudSettingsPatch = Partial<Pick<CloudSettings, 'enabled' | 'batchTime' | 'provider'>>
export type CloudSwitchResult = { ok: boolean; error?: string; status: CloudStatus }
export type CloudRunSummary = {
  at: string
  trigger: 'nightly' | 'manual'
  provider?: CloudProviderId
  period?: SortPeriod // the period a manual run was limited to
  local: { ok: boolean; message: string } | null
  asked: number
  answered: number
  keep: number
  throwaway: number
  stayedDoubtful: number
  sent: number // the run as three numbers: screenshots sent,
  settled: number // those the provider settled (keep or throwaway),
  stillUnsure: number // and those sent that it left unsure
  skipped: 'unavailable' | 'off' | 'nightly-off' | 'rules-changed' | 'no-key' | 'revoked' | 'provider-changed' | 'offline' | 'nothing-doubtful' | 'key-rejected' | 'cancelled' | 'limit-reached' | 'not-prepared' | 'not-confirmed' | 'period-changed' | 'batch-changed' | 'date-changed' | null
  error: string | null
  message: string
}
export type CloudCostEstimate = { screenshots: number; requests: number; inputTokens: number; outputTokens: number; usd: number }
export type CloudPreview = {
  local: { ok: boolean; message: string }
  provider: CloudProviderId // the batch is bound to it: main refuses the send when another is selected by then
  period: SortPeriod | null // the batch is bound to it too: main refuses the send when another is selected by then
  periodLabel: string // 'Last 30 days'
  periodPrefix: string // 'Last 30 days: '; '' for everything
  periodNote: string // a sentence on what the period leaves out
  doubtful: number // doubtful screenshots in the period
  toSend: number
  secondOpinions: number // how many of toSend the other provider answered and was unsure about; the estimate covers all of toSend
  secondNote: string // those in words ('5 of them ones Luna was unsure about'); '' when none
  cap: number
  leftTonight: number
  estimate: CloudCostEstimate
  costLabel: string // the words before the cost figure
  costNote: string // a sentence after it ('' when none)
  blocked: 'unavailable' | 'off' | 'no-key' | 'offline' | 'busy' | 'nothing-doubtful' | 'limit-reached' | 'period' | null
  /** One-time token for send(): main sends only the batch it prepared and showed. */
  token: string | null
  message: string
}
export type CloudStatus = {
  phase: 'idle' | 'sorting' | 'asking'
  done: number
  total: number
  hasKey: boolean // the selected provider's; no key ever crosses to the renderer
  encryptionAvailable: boolean
  settings: CloudSettings
  nightlyLimit: number
  leftTonight: number | null // what is left of tonight's limit; null when it could not be read
  lastRun: CloudRunSummary | null
  nextRunAt: string | null // null while the service or the nightly switch is off
  model: string // the selected provider's model, short name and company
  name: string
  company: string
  longEdge: number
  providers: Array<{ id: CloudProviderId; name: string; company: string; model: string; hasKey: boolean; agreedAt: string | null }> // agreedAt: when he agreed to it
  period: SortPeriod | null // the same setting as SorterStatus.period
  periods: ReadonlyArray<{ id: SortPeriod; label: string }>
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
    sort: (opts?: { limit?: number }): Promise<SortResult> => ipcRenderer.invoke('sorter:sort', opts),
    // one of the four period ids, nothing else: no date and no list of screenshots ever goes to main
    setPeriod: (period: SortPeriod): Promise<{ ok: boolean; period: SortPeriod | null; error?: string }> => ipcRenderer.invoke('sorter:set-period', period),
    cancel: (): Promise<void> => ipcRenderer.invoke('sorter:cancel'),
    // Teach the sorter (ticket 22). An answer is review.act / triage.decide: there is no separate write.
    // teachQueue: the screenshots the sorter is least sure of, first page with after = null; limit defaults to 10 (at most 500)
    teachQueue: (after?: string | null, limit?: number): Promise<TeachQueue> => ipcRenderer.invoke('sorter:teach-queue', after ?? null, limit),
    // learning: computed in the background the first time after each training (several trainings: tens of seconds), then answered from the stored reading
    learning: (): Promise<SorterLearning> => ipcRenderer.invoke('sorter:learning'),
    // retrainNow: train + test + say what moved (status.lastRetrain). 'round' = the end of a teaching round; a retrain already running is joined
    retrainNow: (trigger?: 'manual' | 'round'): Promise<{ ok: boolean; cancelled?: boolean; report?: SorterReport; error?: string }> => ipcRenderer.invoke('sorter:retrain-now', trigger),
    // setAutoRetrain: either switch or both; onBattery true = retrain also on battery. Answers with both as stored
    setAutoRetrain: (patch: { enabled?: boolean; onBattery?: boolean }): Promise<{ ok: boolean; autoRetrain: boolean; autoRetrainOnBattery: boolean; error?: string }> => ipcRenderer.invoke('sorter:set-auto-retrain', patch),
    // "What the sorter goes by" (ticket 20): his choices per app with the rule in force and a suggestion, and the built-in rules in words
    goesBy: (): Promise<SorterGoesBy> => ipcRenderer.invoke('sorter:goes-by'),
    // His rule for an app ('' = app not known): 'keep' | 'throwaway' | null (none). Saved at once; used from the next sort. Answers with the table as it is now.
    setAppRule: (app: string, rule: AppLean | null): Promise<{ ok: boolean; error?: string; goesBy: SorterGoesBy }> => ipcRenderer.invoke('sorter:set-app-rule', app, rule),
    // Sort runs, newest first (at most 20 are kept), and the piles of one: kept, thrown away, unsure.
    // Moving a card is triage.decide(hash, 'select' | 'exclude' | 'reset'); then read the piles again.
    runs: (): Promise<SortRun[]> => ipcRenderer.invoke('sorter:runs'),
    runPiles: (runId: string, opts?: { kept?: number; throwaway?: number; unsure?: number }): Promise<SortRunPiles> => ipcRenderer.invoke('sorter:run-piles', runId, opts ?? {}),
    runPage: (runId: string, pile: SortRunPile, after: string | null, limit?: number): Promise<SortRunPage> => ipcRenderer.invoke('sorter:run-page', runId, pile, after, limit),
    onStatus: (cb: (s: SorterStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: SorterStatus): void => cb(s)
      ipcRenderer.on('sorter:status', handler)
      return () => ipcRenderer.removeListener('sorter:status', handler)
    }
  },
  // Sorter cloud step: Luna or Haiku for the doubtful ones. Each provider's key is write-only from here (set / clear, always naming the provider); status says only whether one is saved.
  cloud: {
    status: (): Promise<CloudStatus> => ipcRenderer.invoke('cloud:status'),
    setKey: (provider: CloudProviderId, key: string): Promise<{ ok: boolean; saved: boolean; error?: string; status: CloudStatus }> => ipcRenderer.invoke('cloud:set-key', provider, key),
    clearKey: (provider: CloudProviderId): Promise<CloudStatus> => ipcRenderer.invoke('cloud:clear-key', provider),
    setSettings: (patch: CloudSettingsPatch): Promise<CloudStatus> => ipcRenderer.invoke('cloud:set-settings', patch),
    // the nightly batch on or off (it runs only while the service is on), and second opinions on or off; main takes true or false only
    setNightly: (on: boolean): Promise<CloudSwitchResult> => ipcRenderer.invoke('cloud:set-nightly', on),
    setSecondOpinions: (on: boolean): Promise<CloudSwitchResult> => ipcRenderer.invoke('cloud:set-second-opinions', on),
    prepare: (): Promise<CloudPreview> => ipcRenderer.invoke('cloud:prepare'),
    send: (token: string): Promise<CloudRunSummary> => ipcRenderer.invoke('cloud:send', token),
    cancel: (): Promise<void> => ipcRenderer.invoke('cloud:cancel'),
    onStatus: (cb: (s: CloudStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: CloudStatus): void => cb(s)
      ipcRenderer.on('cloud:status', handler)
      return () => ipcRenderer.removeListener('cloud:status', handler)
    }
  },
  // Main-process menu events (⌘, → Settings). Subscribe once; call the returned function to unsubscribe.
  app: {
    onOpenSettings: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('app:open-settings', handler)
      return () => ipcRenderer.removeListener('app:open-settings', handler)
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
    // TalkWeaver registers no URL scheme, so "open in TalkWeaver" reveals the talk's file in Finder.
    // A scan of the vault's talks finished (ok = false: it failed and the previous usage was kept).
    onTalkUsageChanged: (cb: (r: { ok: boolean; reason: string }) => void): (() => void) => {
      const handler = (_e: unknown, r: { ok: boolean; reason: string }): void => cb(r)
      ipcRenderer.on('talks:usage-changed', handler)
      return () => ipcRenderer.removeListener('talks:usage-changed', handler)
    },
    revealTalk: (relPath: string): Promise<boolean> => ipcRenderer.invoke('talks:reveal', relPath),
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
      offset?: number,
      apps?: string[] // only these apps ('' = app not known); absent or empty = every app
    ): Promise<{ items: TriageItem[]; counts: TriageCounts; hasMore: boolean }> => ipcRenderer.invoke('triage:list', query, state, sort, limit, offset, apps?.length ? apps : undefined),
    // The App menu: each app with rows in this state tab ('undecided' | 'selected' | 'included' | 'excluded' | 'all'), most rows first, app not known ('') last
    apps: (state: string): Promise<TriageAppCount[]> => ipcRenderer.invoke('triage:apps', state),
    // Exclude all / select all undecided screenshots from these apps: his decision. `expected` is the count shown and confirmed;
    // main counts again and, if it differs, decides nothing (refused: 'count-changed'). No undo.
    decideAll: (apps: string[], action: 'select' | 'exclude', expected: number): Promise<TriageBulkResult> => ipcRenderer.invoke('triage:decide-all', apps, action, expected),
    // refused: the item was emptied from the Bin (permanent); nothing changed
    decide: (hash: string, action: 'select' | 'exclude' | 'reset', force?: boolean): Promise<{ state: string; refused?: string }> =>
      ipcRenderer.invoke('triage:decide', hash, action, force),
    // error: one plain sentence when the run failed (the counts are then 0)
    importSelected: (forceHashes?: string[]): Promise<{ imported: number; skipped: number; gated: number; error?: string }> =>
      ipcRenderer.invoke('triage:import-selected', forceHashes ?? []),
    // The run that is going now (null when none has run); progress snapshots stream while it works.
    importStatus: (): Promise<ImportSnapshot | null> => ipcRenderer.invoke('triage:import-status'),
    onImportProgress: (cb: (snap: ImportSnapshot) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, snap: ImportSnapshot): void => cb(snap)
      ipcRenderer.on('triage:import-progress', handler)
      return () => ipcRenderer.removeListener('triage:import-progress', handler)
    },
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
    overview: (opts?: { queue?: number; sample?: number; order?: 'newest' | 'teach'; sure?: ReviewSure }): Promise<ReviewOverview> => ipcRenderer.invoke('review:overview', opts ?? {}),
    piles: (opts?: { kept?: number; throwaway?: number; bin?: number; sure?: ReviewSure }): Promise<ReviewPiles> => ipcRenderer.invoke('review:piles', opts ?? {}),
    // the page after a cursor (keyset; no cap on how far)
    page: (pile: 'kept' | 'throwaway' | 'bin', after: string | null, limit?: number, sure?: ReviewSure): Promise<ReviewPage> => ipcRenderer.invoke('review:page', pile, after, limit, sure),
    // the cards of up to 200 screenshots by hash, in the order asked for; one in the Bin, emptied or no longer in review is left out
    cards: (hashes: string[]): Promise<ReviewCard[]> => ipcRenderer.invoke('review:cards', hashes),
    // shownPicture: the picture state the card was shown with (ReviewShot shownPicture); main records the worse of it and its own check
    act: (hash: string, action: 'keep' | 'throwaway' | 'rescue', shownPicture?: ReviewCard['picture']): Promise<ReviewActResult> =>
      ipcRenderer.invoke('review:act', hash, action, ...(shownPicture === undefined ? [] : [shownPicture])),
    undo: (): Promise<ReviewUndoResult> => ipcRenderer.invoke('review:undo'),
    emptyBin: (token: string): Promise<EmptyBinResult> => ipcRenderer.invoke('review:empty-bin', token),
    // answers given on cards with no picture since `since` (an ISO date-time), and putting exactly that set back to undecided
    blindAnswers: (since?: string): Promise<ReviewBlindAnswers> => ipcRenderer.invoke('review:blind-answers', ...(since === undefined ? [] : [since])),
    rescueBlind: (token: string, since?: string): Promise<ReviewRescueResult> => ipcRenderer.invoke('review:rescue-blind', token, ...(since === undefined ? [] : [since])),
    // answers when the retrain rescueBlind asked for (its `retrain` id) has ended; null for an id it does not know
    rescueRetrain: (id: number): Promise<ReviewRescueRetrain | null> => ipcRenderer.invoke('review:rescue-retrain', id)
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

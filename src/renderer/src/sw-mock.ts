import type { SwApi } from '../../preload'
import { reviewMock } from './review-mock'
import type { CloudStatus } from '../../preload'

const PERIODS: CloudStatus['periods'] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'all', label: 'Everything' }
]

// Settings › cloud step in the browser preview: pretend key flags and settings; nothing is ever sent.
function cloudMock(): SwApi['cloud'] {
  const providers: CloudStatus['providers'] = [
    { id: 'openai', name: 'Luna', company: 'OpenAI', model: 'gpt-6-luna', hasKey: false, agreedAt: null },
    { id: 'anthropic', name: 'Haiku', company: 'Anthropic', model: 'claude-haiku-5-5', hasKey: false, agreedAt: null }
  ]
  const st: CloudStatus = { phase: 'idle', done: 0, total: 0, hasKey: false, encryptionAvailable: true, settings: { enabled: false, batchTime: '02:00', provider: 'openai', nightly: true, secondOpinions: true, agreedAt: { openai: null, anthropic: null } }, nightlyLimit: 300, leftTonight: 300, lastRun: null, nextRunAt: null, model: 'gpt-6-luna', name: 'Luna', company: 'OpenAI', longEdge: 1456, providers, period: 'all', periods: PERIODS }
  const sync = (): CloudStatus => {
    const p = providers.find((x) => x.id === st.settings.provider) ?? providers[0]
    Object.assign(st, { hasKey: p.hasKey, model: p.model, name: p.name, company: p.company })
    return { ...st, providers: providers.map((x) => ({ ...x })) }
  }
  return {
    status: async () => sync(),
    setKey: async (provider, k: string) => {
      const p = providers.find((x) => x.id === provider)
      const ok = Boolean(p) && k.trim().length >= 20
      if (p && ok) p.hasKey = true
      return { ok, saved: ok, error: ok ? undefined : 'That does not look like an API key.', status: sync() }
    },
    clearKey: async (provider) => {
      const p = providers.find((x) => x.id === provider)
      if (p) p.hasKey = false
      return sync()
    },
    setSettings: async (patch) => {
      st.settings = { ...st.settings, ...patch }
      return sync()
    },
    setNightly: async (on) => {
      st.settings = { ...st.settings, nightly: on }
      return { ok: true, status: sync() }
    },
    setSecondOpinions: async (on) => {
      st.settings = { ...st.settings, secondOpinions: on }
      return { ok: true, status: sync() }
    },
    prepare: async () => ({ local: { ok: false, message: 'not available in the browser preview' }, provider: st.settings.provider, period: 'all' as const, periodLabel: 'Everything', periodPrefix: '', periodNote: 'Period: everything, whatever the date.', doubtful: 0, toSend: 0, secondOpinions: 0, secondNote: '', cap: st.nightlyLimit, leftTonight: st.nightlyLimit, estimate: { screenshots: 0, requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 }, costLabel: 'Estimated cost', costNote: '', blocked: 'nothing-doubtful' as const, token: null, message: `Nothing doubtful is waiting for ${st.name}.` }),
    send: async () => ({ at: new Date().toISOString(), trigger: 'manual' as const, provider: st.settings.provider, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, sent: 0, settled: 0, stillUnsure: 0, skipped: 'nothing-doubtful' as const, error: null, message: `Nothing doubtful was waiting for ${st.name}.` }),
    cancel: async () => undefined,
    onStatus: () => () => undefined
  }
}

// Invented data for the sort piles and "What the sorter goes by" in the browser preview.
const MOCK_GOES_BY = {
  apps: [
    { app: 'Brightloom', kept: 40, keptShare: 0.78, thrownAway: 11, undecided: 412, builtIn: null, rule: null, suggestion: null },
    { app: 'Mossgrid', kept: 3, keptShare: 0.06, thrownAway: 47, undecided: 97, builtIn: null, rule: null, suggestion: { kind: 'make' as const, rule: 'throwaway' as const, share: 0.94, against: null, text: 'You threw away 94% — make it a rule?', action: 'Make rule' } },
    { app: '', kept: 28, keptShare: 0.32, thrownAway: 60, undecided: 305, builtIn: null, rule: null, suggestion: null }
  ],
  builtIn: { keep: ['Slides on screen'], throwaway: ['Finder window'] }
}
const MOCK_RUN = { id: 'mock-run', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), period: 'all' as const, trigger: 'manual' as const, counts: { sorted: 8, kept: 3, thrownAway: 3, unsure: 2 }, now: { kept: 3, thrownAway: 3, unsure: 2 } }
const mockPile = (proposal: 'keep' | 'throwaway' | 'doubtful', count: number) => ({
  total: count,
  next: null,
  items: Array.from({ length: count }, (_, i) => ({
    hash: `mock-${proposal}-${i}`, filename: `Invented capture ${i}.png`, app: i % 2 ? 'Brightloom' : null, windowTitle: null, takenAt: null, reason: 'Looks like screenshots you kept before', confidence: 0.9, lowConfidence: i === 1,
    proposal, pile: (proposal === 'keep' ? 'kept' : proposal === 'throwaway' ? 'throwaway' : 'unsure') as 'kept' | 'throwaway' | 'unsure', decidedBy: 'rules' as const, decision: null, thumbUrl: null, offline: false
  }))
})

// Browser/dev mock for window.sw so the renderer runs under plain Vite (no Electron).
// Mirrors the full preload contract; returns inert values. Never used in the packaged app.
export function installMock(): void {
  const pictureStatus = {
    model: 'absent' as const,
    modelBytes: 910310138,
    download: null,
    error: null,
    includeWell: true,
    paused: false,
    index: { phase: 'idle' as const, done: 0, total: 0, failed: 0, secondsLeft: null },
    text: '',
    coverage: 0,
    estimate: null
  }
  const mock: SwApi = {
    app: { onOpenSettings: () => () => {} },
    picture: {
      status: async () => pictureStatus,
      estimate: async () => null,
      download: async () => ({ ok: false, error: 'not available in the browser preview' }),
      cancelDownload: async () => undefined,
      deleteModel: async () => undefined,
      pause: async () => undefined,
      resume: async () => undefined,
      setIncludeWell: async () => undefined,
      query: async () => ({ ok: false, results: [], error: 'not available in the browser preview' }),
      queryCount: async () => 0,
      onStatus: () => () => undefined
    },
    sorter: {
      status: async () => ({ phase: 'idle' as const, done: 0, total: 0, message: '', error: null, modelReady: false, report: null, canRunUnattended: false, retrainNeeded: false, rulesChangedSinceTest: false, minHeldBack: { total: 20, perLabel: 5 }, pending: { keep: 0, throwaway: 0, doubtful: 0, lastProposedAt: null }, period: 'all' as const, periods: PERIODS, lastRun: null, undecided: null, learnable: null, answersSinceTraining: 0, retrainEvery: 10, autoRetrain: true, autoRetrainOnBattery: false, retraining: null, waitingForPower: null, choicesNeeded: 0, lastRetrain: null }),
      train: async () => ({ ok: false, error: 'not available in the browser preview' }),
      // teach the sorter (ticket 22): placeholders so the preview compiles; the renderer tickets (23, 24) fill them in
      teachQueue: async () => ({ total: 0, items: [], next: null }),
      learning: async () => ({ verdict: 'not-enough' as const, more: 92, minimum: 92, choices: 0, kept: 0, thrownAway: 0, heldBack: 0, points: [], trainedAt: null }),
      retrainNow: async () => ({ ok: false, error: 'not available in the browser preview' }),
      setAutoRetrain: async () => ({ ok: false, autoRetrain: true, autoRetrainOnBattery: false, error: 'not available in the browser preview' }),
      sort: async () => ({ ok: false, error: 'not available in the browser preview' }),
      setPeriod: async () => ({ ok: false, period: 'all' as const, error: 'not available in the browser preview' }),
      cancel: async () => undefined,
      goesBy: async () => MOCK_GOES_BY,
      setAppRule: async () => ({ ok: false, error: 'not available in the browser preview', goesBy: MOCK_GOES_BY }),
      runs: async () => [MOCK_RUN],
      runPiles: async () => ({ run: MOCK_RUN, kept: mockPile('keep', 3), throwaway: mockPile('throwaway', 3), unsure: mockPile('doubtful', 2) }),
      runPage: async () => ({ total: 0, items: [], next: null }),
      onStatus: () => () => undefined
    },
    cloud: cloudMock(),
    archive: {
      available: async () => false,
      search: async () => [],
      searchMatched: async (_q: string, _f: unknown, mode: 'words' | 'meaning' | 'both') => ({ requested: mode, mode: 'words' as const, modelReady: false, words: [], related: [], pictureError: null, ms: { words: 0, meaning: null } }),
      moreLikeThis: async () => ({ state: 'no-model' as const, items: [] }),
      fromCounts: async () => ({ all: 0, screenshots: 0, 'old-images': 0, 'old-slides': 0, talks: 0 }),
      categories: async () => [],
      decks: async () => [],
      listDecks: async () => [],
      deckDetail: async () => null,
      stats: async () => null,
      slideStructure: async () => null,
      slideImages: async () => [],
      deckSlides: async () => [],
      copyImage: async () => false,
      copyImagePng: async () => false,
      reveal: async () => false,
      revealTalk: async () => false,
      onTalkUsageChanged: () => () => {},
      scanVault: async () => 0,
      deleteOthersMatching: async () => ({ ok: false })
    },
    settings: {
      getPaths: async () => ({
        archiveRoot: null,
        archiveDefault: '~/ppt-archive',
        archiveAvailable: false,
        wellRoot: '~/ppt-archive/well',
        vaultRoot: null,
        vaultAvailable: false,
        screenshotRoot: '~/Screenshots',
        screenshotAvailable: true,
        captureSources: [],
        captureDefaults: { desktop: { path: '~/Desktop', namedOnly: true }, cleanshot: null },
        conversionsRoot: null,
        convertOcrDefault: false,
        othersArchiveRoot: '~/SlideWell/others-library',
        othersArchiveAvailable: false
      }),
      chooseArchive: async () => null,
      chooseVault: async () => null,
      addCaptureSource: async () => false,
      removeCaptureSource: async () => true,
      chooseScreenshotFolder: async () => null,
      chooseConversionsFolder: async () => null,
      setConvertOcr: async (on: boolean) => on,
      getOwnerNames: async () => ({ names: ['Mock User'], isDefault: true }),
      setOwnerNames: async (names: string[]) => ({ names, isDefault: names.length === 0 }),
      chooseOthersFolder: async () => null,
      clearOthersLibrary: async () => ({ ok: false }),
      getR2: async () => ({ accountId: '', endpoint: '', bucket: 'ppt-archive-media', prefix: 'slidewell', hasCreds: false }),
      setR2: async () => ({ ok: true, gotKeys: false, encAvailable: false, savedCreds: false }),
      testR2: async () => ({ ok: false, error: 'mock' }),
      getStorage: async () => ({ archive: 'local' as const, others: 'local' as const, well: 'local' as const }),
      setStoreBackend: async () => ({ ok: true }),
      syncStore: async () => ({ ok: false, error: 'mock' }),
      dependencies: async () => ({ requirementsUrl: '', deps: [] })
    },
    triage: {
      scan: async () => ({ ok: false, indexed: 0, total: 0, offline: 0 }),
      list: async () => ({ items: [], counts: { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }, hasMore: false }),
      decide: async () => ({ state: 'undecided' }),
      apps: async () => [
        { app: 'Brightloom', count: 412, kept: 40, thrownAway: 11, keptShare: 0.78 },
        { app: 'Mossgrid', count: 97, kept: 3, thrownAway: 47, keptShare: 0.06 },
        { app: '', count: 305, kept: 28, thrownAway: 60, keptShare: 0.32 }
      ],
      decideAll: async () => ({ ok: false, changed: 0, skipped: 0, count: 0 }),
      paste: async () => null,
      importSelected: async () => ({ imported: 0, skipped: 0, gated: 0 }),
      importStatus: async () => null,
      onImportProgress: () => () => {},
      onProgress: () => () => {},
      onChanged: () => () => {}
    },
    review: reviewMock(),
    backlog: {
      dryRun: async () => ({ id: 'mock', plan: { ok: false as const, reason: 'no-watched-folder' as const, detail: 'not available in the browser preview' } }),
      run: async () => ({ refused: 'not available in the browser preview' }),
      cancel: async () => false,
      showLogs: async () => false,
      cleanShotSetting: async () => null,
      setCleanShot: async () => null,
      onProgress: () => () => undefined
    },
    shell: {
      openPath: async () => false,
      openExternal: async () => false
    },
    ingest: {
      pending: async () => ({ ok: false }),
      choosePath: async () => null,
      runPath: async () => ({ ok: false }),
      cancel: async () => true,
      onLine: () => () => {}
    },
    convert: {
      chooseSource: async () => null,
      chooseDest: async () => null,
      run: async () => ({ ok: false }),
      onLine: () => () => {}
    }
  }
  ;(window as unknown as { sw: SwApi }).sw = mock
}

// window.sw.sorter for the browser preview and the review UI test (e2e/review-ui.mjs). Invented numbers only; nothing
// is trained or sent. `window.__sorterMock` lets a test move the strip through its states: set(patch) changes the status
// and pushes it, preset(name) applies a named state, and `learning` / `learningDelayMs` shape the reading.
// ?sorterState=counting|retraining|waiting|off|few|retrained|needsTraining|neverTrained picks the state the preview opens in. Never used in the packaged app.
import type { SorterLearning, SorterReport, SorterRetrain, SorterStatus, SwApi } from '../../preload'

const PERIODS: SorterStatus['periods'] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'all', label: 'Everything' }
]
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
const share = (proposed: number, correct: number) => ({ proposed, correct, precision: proposed ? correct / proposed : null })
const accuracy = { sample: 60, truth: { keep: 44, throwaway: 16 }, keep: share(40, 38), throwaway: share(11, 10), doubtful: { count: 9, share: 0.15 }, keptProposedThrowaway: 1, binnedProposedKeep: 2 }
// a full report so the Auto sorting tab also draws in the preview
const REPORT = {
  trainedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(), sorterVersion: 'mock', thresholds: { throwaway: 0.9, keep: 0.8 }, holdOutFraction: 0.2, labelled: { keep: 228, throwaway: 84 }, usable: { keep: 228, throwaway: 84 }, keepFromWellCopy: 0,
  grouping: { groups: 1, largest: 1, cosine: 0.9, minutes: 1 }, enoughToMeasure: true, trainedOn: { keep: 182, throwaway: 67 }, l2: 1,
  calibration: { chosen: 'platt', brier: { raw: 0.1, platt: 0.08, isotonic: 0.09 }, reliability: { platt: [], isotonic: [] } }, heldBackClassifier: { auc: 0.9, brier: 0.08, reliability: [] },
  heldBack: accuracy, rulesOnly: { ...accuracy, doubtful: { count: 25, share: 0.42 } }
} as unknown as SorterReport

const RETRAIN: SorterRetrain = {
  at: new Date(Date.now() - 20 * 60_000).toISOString(),
  trigger: 'auto',
  choices: { before: 312, after: 322 },
  needALook: { before: 41, after: 18 },
  movedToSure: { keep: 19, throwaway: 4 },
  accuracy: { before: { throwawayRight: 0.91, keepRight: 0.95 }, after: { throwawayRight: 0.94, keepRight: 0.96 } },
  movedHashes: ['m030', 'm031', 'm032', 'm033', 'm034', 'm035', 'm036', 'm037', 'm038', 'm039', 'm040', 'm041']
}
const LEARNING: SorterLearning = {
  verdict: 'still-helping', more: 0, minimum: 92, choices: 312, kept: 228, thrownAway: 84, heldBack: 60, trainedAt: REPORT.trainedAt,
  points: [
    { choices: 50, throwawayRight: 0.74, needALook: 0.46 },
    { choices: 100, throwawayRight: 0.83, needALook: 0.34 },
    { choices: 150, throwawayRight: 0.87, needALook: 0.25 },
    { choices: 200, throwawayRight: 0.895, needALook: 0.19 },
    { choices: 250, throwawayRight: 0.905, needALook: 0.16 },
    { choices: 312, throwawayRight: 0.91, needALook: 0.135 }
  ]
}

// readings for the chart's edge cases and for the shape seen on real data (invented here, same figures): all at 100%, all at 0%, and the one that led to the new verdict copy
const flat = (ta: number, nl: number): SorterLearning['points'] => [113, 227, 340, 453, 567, 680].map((choices) => ({ choices, throwawayRight: ta, needALook: nl }))
const FIXTURES: Record<'all100' | 'all0' | 'real', SorterLearning> = {
  all100: { ...LEARNING, verdict: 'levelling-off', choices: 680, kept: 284, thrownAway: 396, points: flat(1, 1) },
  all0: { ...LEARNING, verdict: 'levelling-off', choices: 680, kept: 284, thrownAway: 396, points: flat(0, 0) },
  real: { ...LEARNING, verdict: 'levelling-off', choices: 680, kept: 284, thrownAway: 396, points: [0.956, 0.891, 0.796, 0.708, 0.701, 0.693].map((nl, i) => ({ choices: [113, 227, 340, 453, 567, 680][i], throwawayRight: 1, needALook: nl })) }
}

const base = (): SorterStatus => ({
  phase: 'idle', done: 0, total: 0, message: '', error: null, modelReady: true, report: REPORT, canRunUnattended: true, retrainNeeded: false, rulesChangedSinceTest: false, minHeldBack: { total: 20, perLabel: 5 },
  pending: { keep: 0, throwaway: 0, doubtful: 0, lastProposedAt: null }, period: 'all', periods: PERIODS, lastRun: null, undecided: null, learnable: { kept: 228, binned: 84 },
  answersSinceTraining: 4, retrainEvery: 10, autoRetrain: true, autoRetrainOnBattery: false, retraining: null, waitingForPower: null, choicesNeeded: 0, lastRetrain: null
})

const PRESETS: Record<string, Partial<SorterStatus>> = {
  counting: {},
  retraining: { retraining: 'auto', answersSinceTraining: 10 },
  waiting: { answersSinceTraining: 10, waitingForPower: { answers: 10 } },
  off: { autoRetrain: false, answersSinceTraining: 7 },
  few: { learnable: { kept: 30, binned: 10 }, choicesNeeded: 52, answersSinceTraining: 0 },
  retrained: { lastRetrain: RETRAIN, answersSinceTraining: 0 },
  // no current model: the sorter changed since it last learnt (the reading is still the last one), and never trained. Main counts no answers in either.
  needsTraining: { report: null, retrainNeeded: true, canRunUnattended: false, answersSinceTraining: 0 },
  neverTrained: { report: null, retrainNeeded: false, canRunUnattended: false, answersSinceTraining: 0 }
}

export type SorterMockControl = {
  set: (patch: Partial<SorterStatus>) => void
  preset: (name: keyof typeof PRESETS) => void
  learning: SorterLearning
  fixtures: typeof FIXTURES
  learningDelayMs: number
  calls: { retrainNow: Array<string | undefined>; setAutoRetrain: Array<{ enabled?: boolean; onBattery?: boolean }> }
}

export function sorterMock(review: SwApi['review']): SwApi['sorter'] {
  const st = base()
  const subs = new Set<(s: SorterStatus) => void>()
  const push = (): void => subs.forEach((f) => f({ ...st }))
  const ctl: SorterMockControl = {
    set: (patch) => {
      Object.assign(st, patch)
      push()
    },
    preset: (name) => {
      Object.assign(st, base(), PRESETS[name])
      push()
    },
    learning: LEARNING,
    fixtures: FIXTURES,
    learningDelayMs: 0,
    calls: { retrainNow: [], setAutoRetrain: [] }
  }
  const wanted = new URLSearchParams(globalThis.location?.search ?? '').get('sorterState')
  if (wanted && PRESETS[wanted]) Object.assign(st, PRESETS[wanted])
  ;(globalThis as unknown as { __sorterMock: SorterMockControl }).__sorterMock = ctl
  return {
    status: async () => ({ ...st }),
    train: async () => ({ ok: false, error: 'not available in the browser preview' }),
    teachQueue: async (after, limit) => {
      const ov = await review.overview({ queue: 500, sample: 0, order: 'teach' })
      const from = after ? Number(after) : 0
      const size = Math.min(limit ?? 10, 500)
      return { total: ov.queue.length, items: ov.queue.slice(from, from + size), next: from + size < ov.queue.length ? String(from + size) : null }
    },
    learning: async () => {
      if (ctl.learningDelayMs) await new Promise((r) => setTimeout(r, ctl.learningDelayMs))
      return ctl.learning
    },
    retrainNow: async (trigger) => {
      ctl.calls.retrainNow.push(trigger)
      st.retraining = trigger ?? 'manual'
      st.waitingForPower = null
      push()
      await new Promise((r) => setTimeout(r, 700))
      Object.assign(st, { retraining: null, answersSinceTraining: 0, lastRetrain: { ...RETRAIN, at: new Date().toISOString(), trigger: trigger ?? 'manual' } })
      push()
      return { ok: true }
    },
    setAutoRetrain: async (patch) => {
      ctl.calls.setAutoRetrain.push(patch)
      if (patch.enabled !== undefined) st.autoRetrain = patch.enabled
      if (patch.onBattery !== undefined) st.autoRetrainOnBattery = patch.onBattery
      push()
      return { ok: true, autoRetrain: st.autoRetrain, autoRetrainOnBattery: st.autoRetrainOnBattery }
    },
    sort: async () => ({ ok: false, error: 'not available in the browser preview' }),
    setPeriod: async () => ({ ok: false, period: 'all' as const, error: 'not available in the browser preview' }),
    cancel: async () => undefined,
    goesBy: async () => MOCK_GOES_BY,
    setAppRule: async () => ({ ok: false, error: 'not available in the browser preview', goesBy: MOCK_GOES_BY }),
    runs: async () => [MOCK_RUN],
    runPiles: async () => ({ run: MOCK_RUN, kept: mockPile('keep', 3), throwaway: mockPile('throwaway', 3), unsure: mockPile('doubtful', 2) }),
    runPage: async () => ({ total: 0, items: [], next: null }),
    onStatus: (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    }
  }
}

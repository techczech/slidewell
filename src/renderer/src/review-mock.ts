// In-memory review data for the browser preview and the review UI test (e2e/review-ui.mjs). Uses the
// real pile state machine (src/main/review/piles.ts), so the piles, the 30-day clock, rescue, undo and
// Empty Bin behave as in the app; only storage and the well are pretend. Never used in the packaged app.
import { binToken, keysetPage, pileKey, pileOf, planAction, summarise, type PileView, type ProposalLabel, type ReviewAction } from '../../main/review/piles'
import type { ReviewCard, ReviewOverview, ReviewPage, ReviewPiles, ReviewActResult, ReviewUndoResult, EmptyBinResult, SwApi } from '../../preload'

type MockItem = {
  hash: string
  proposal: ProposalLabel
  proposedAt: string
  throwawaySince: string | null
  decision: { state: string; decidedAt: string | null } | null
  app: string
  windowTitle: string
  filename: string
  takenAt: string
  reason: string
  decidedBy: ReviewCard['decidedBy']
}

const DAY = 86_400_000

function seed(now: number): MockItem[] {
  const sortedAt = new Date(now - 6 * 3_600_000).toISOString()
  const stamp = (minsAgo: number): string => new Date(now - minsAgo * 60_000).toISOString().slice(0, 19)
  let n = 0
  const item = (proposal: ProposalLabel, app: string, windowTitle: string, reason: string, daysAgo = 0): MockItem => {
    n++
    const taken = stamp(n * 37)
    return {
      hash: `m${String(n).padStart(3, '0')}`,
      proposal,
      proposedAt: sortedAt,
      throwawaySince: proposal === 'throwaway' ? new Date(now - daysAgo * DAY).toISOString() : null,
      decision: null,
      app,
      windowTitle,
      filename: `CleanShot ${taken.slice(0, 10)} at ${taken.slice(11, 13)}${taken.slice(14, 16)} from ${app} with ${windowTitle}.png`,
      takenAt: taken,
      reason,
      decidedBy: proposal === 'doubtful' ? null : 'history'
    }
  }
  const out: MockItem[] = [
    item('doubtful', 'Google Chrome', 'ChatGPT', 'A ChatGPT window is usually slide material, but this one shows a settings page rather than an answer.'),
    { ...item('doubtful', 'Claude', 'New chat', 'Not sure, and Luna was not sure either: a short Claude reply; could be a useful example, could be a test.'), decidedBy: 'luna' },
    item('doubtful', 'Slack', '#sidequest-apps', 'A Slack thread, but it holds a picture of a TalkWeaver layout.'),
    item('doubtful', 'Terminal', 'zsh', 'Terminal, but the output is a clean results table, not an error.'),
    item('doubtful', 'WriteFlex', 'Untitled', 'No text it could read. Nothing to go on.'),
    item('doubtful', 'Outlook', 'Inbox', 'An email about AI policy with a quotable line, inside the inbox.')
  ]
  const kept: Array<[string, string]> = [
    ['Claude', 'Slide structure options'], ['Google Chrome', 'TalkWeaver Layout Showcase'], ['Claude', 'New chat'], ['Google Chrome', 'OECD Education at a Glance'],
    ['WriteFlex', 'Reading Room'], ['ChatGPT', 'Oxford AI policy, short version'], ['TalkWeaver', 'Teaching with AI: a staff briefing'], ['Google Chrome', 'Anthropic · Model comparison'],
    ['Google Chrome', 'Gemini · image prompt result'], ['WriteFlex', 'Collections'], ['Google Chrome', 'Our World in Data · Compute'], ['Claude', 'Prompt patterns']
  ]
  for (let i = 0; i < 29; i++) {
    const [app, win] = kept[i % kept.length]
    out.push(item('keep', app, win, 'Looks like screenshots you kept before.'))
  }
  const toss: Array<[string, string, number]> = [
    ['Slack', '#sidequest-apps · build finished', 0], ['Terminal', 'zsh · npm ERR! ENOENT', 1], ['System Settings', 'Privacy & Security · Screen Recording', 3],
    ['Outlook', 'Calendar invite, Thursday', 6], ['Slack', 'DM · link pasted once', 9], ['Finder', 'Downloads · file list', 18], ['Terminal', 'zsh · git push rejected', 21],
    ['Google Chrome', 'Cookie consent banner', 26], ['Finder', 'Desktop · empty', 27], ['Slack', 'Huddle ended', 28], ['Terminal', 'zsh · permission denied', 34], ['System Settings', 'Wi-Fi', 40]
  ]
  for (const [app, win, days] of toss) out.push(app === 'Terminal' || app === 'System Settings' ? { ...item('throwaway', app, win, `${app} window — usually throwaway`, days), decidedBy: 'rules' } : item('throwaway', app, win, 'Looks like screenshots you binned before.', days))
  out[7] = { ...out[7], reason: 'A TalkWeaver layout showcase, useful slide material', decidedBy: 'luna' }
  // one he already kept from an earlier session
  out[8].decision = { state: 'included', decidedAt: new Date(now - DAY).toISOString() }
  // ?reviewBin=N adds N more items past 30 days (paging and Empty Bin at scale in the UI test)
  const extra = Number(new URLSearchParams(globalThis.location?.search ?? '').get('reviewBin')) || 0
  for (let i = 0; i < extra; i++) out.push(item('throwaway', 'Finder', `Old download ${i + 1}`, 'Looks like screenshots you binned before.', 31 + (i % 60)))
  return out
}

export function reviewMock(): SwApi['review'] {
  const now = (): number => Date.now()
  let items = seed(now())
  const undo: Array<{ hash: string; prior: MockItem['decision'] }> = []
  const view = (i: MockItem): PileView => pileOf(i, now())
  const live = (): MockItem[] => items.filter((i) => view(i).pile !== 'gone')
  const newest = (a: MockItem, b: MockItem): number => b.takenAt.localeCompare(a.takenAt)
  const card = (i: MockItem): ReviewCard => {
    const v = view(i)
    return { hash: i.hash, filename: i.filename, app: i.app, windowTitle: i.windowTitle, takenAt: i.takenAt, reason: i.reason, confidence: 0.6, proposal: i.proposal, pile: v.pile as ReviewCard['pile'], by: v.by, decidedBy: i.decidedBy, binInDays: v.binInDays, thumbUrl: null, offline: false }
  }
  const head = (): { needALook: number; kept: number; throwaway: number } => {
    const s = summarise(live().map((i) => ({ view: view(i), proposal: i.proposal, decided: Boolean(i.decision) })))
    return { needALook: s.needALook, kept: s.confidentKept, throwaway: s.confidentThrowaway }
  }
  const of = (p: 'kept' | 'throwaway' | 'bin'): MockItem[] => live().filter((i) => view(i).pile === p)
  const keyOf = (i: MockItem) => pileKey(view(i).pile, view(i).binInDays, Date.parse(i.takenAt) || 0, i.hash)
  const pageOf = (p: 'kept' | 'throwaway' | 'bin', after: string | null, limit: number) => {
    const pg = keysetPage(of(p), keyOf, after, Math.min(limit, 500))
    return { total: pg.total, items: pg.items.map(card), next: pg.next }
  }
  const lastSortedAt = (): string | null => items.reduce<string | null>((m, i) => (!m || i.proposedAt > m ? i.proposedAt : m), null)
  return {
    overview: async (opts?: { queue?: number; sample?: number }): Promise<ReviewOverview> => {
      const h = head()
      const all = live()
      return {
        needALook: h.needALook,
        confident: { kept: h.kept, throwaway: h.throwaway },
        lastSortedAt: lastSortedAt(),
        queue: all.filter((i) => view(i).pile === 'doubtful').sort(newest).slice(0, opts?.queue ?? 50).map(card),
        confidentSample: all.filter((i) => !i.decision && i.proposal !== 'doubtful').sort(newest).slice(0, opts?.sample ?? 12).map(card),
        canUndo: undo.length > 0
      }
    },
    piles: async (opts?: { kept?: number; throwaway?: number; bin?: number }): Promise<ReviewPiles> => {
      const h = head()
      return {
        needALook: h.needALook,
        confidentTotal: h.kept + h.throwaway,
        lastSortedAt: lastSortedAt(),
        kept: pageOf('kept', null, opts?.kept ?? 60),
        throwaway: pageOf('throwaway', null, opts?.throwaway ?? 60),
        bin: { ...pageOf('bin', null, opts?.bin ?? 60), token: binToken(of('bin').map((i) => i.hash)) },
        canUndo: undo.length > 0
      }
    },
    page: async (pile: 'kept' | 'throwaway' | 'bin', after: string | null, limit?: number): Promise<ReviewPage> => pageOf(pile, after, limit ?? 60),
    act: async (hash: string, action: ReviewAction): Promise<ReviewActResult> => {
      const it = items.find((i) => i.hash === hash)
      if (!it) return { ok: false, hash, message: 'This screenshot is no longer in review.' }
      const plan = planAction(view(it), action, now())
      if (plan.kind !== 'decide') return { ok: plan.kind === 'noop', hash, message: plan.reason }
      undo.push({ hash, prior: it.decision })
      it.decision = { state: plan.state === 'selected' ? 'included' : 'excluded', decidedAt: plan.decidedAt }
      const message = plan.state === 'selected' ? (action === 'rescue' ? 'Rescued — kept and added to the well.' : 'Kept — added to the well.') : 'Moved to Throwaway — bin in 30 days. Your original file is not touched.'
      return { ok: true, hash, message, pile: plan.state === 'selected' ? 'kept' : 'throwaway' }
    },
    undo: async (): Promise<ReviewUndoResult> => {
      const e = undo.pop()
      if (!e) return { ok: false, message: 'Nothing to undo.' }
      const it = items.find((i) => i.hash === e.hash)
      if (it) it.decision = e.prior
      return { ok: true, hash: e.hash, message: 'Undone.' }
    },
    emptyBin: async (token: string): Promise<EmptyBinResult> => {
      const bin = live().filter((i) => view(i).pile === 'bin')
      if (binToken(bin.map((i) => i.hash)) !== token) return { ok: false, emptied: 0, changed: 0, message: 'The Bin changed since you looked; nothing was emptied.' }
      const gone = new Set(bin.map((i) => i.hash))
      items = items.map((i) => (gone.has(i.hash) ? { ...i, decision: { state: 'emptied', decidedAt: new Date(now()).toISOString() } } : i))
      undo.length = 0
      return { ok: true, emptied: bin.length, changed: 0, message: bin.length ? `Emptied ${bin.length} from the Bin. SlideWell never deletes your files.` : 'The Bin is already empty.' }
    }
  }
}

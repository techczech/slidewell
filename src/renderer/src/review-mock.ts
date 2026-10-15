// In-memory review data for the browser preview and the review UI test (e2e/review-ui.mjs). Uses the
// real pile state machine (src/main/review/piles.ts), so the piles, the 30-day clock, rescue, undo and
// Empty Bin behave as in the app; only storage and the well are pretend. Never used in the packaged app.
import { binToken, inSure, keysetPage, parseSure, pileKey, pileOf, planAction, summarise, type PileView, type ProposalLabel, type ReviewAction } from '../../main/review/piles'
import type { ReviewBlindAnswers, ReviewBlindItem, ReviewCard, ReviewOverview, ReviewPage, ReviewPiles, ReviewRescueResult, ReviewRescueRetrain, ReviewSure, ReviewActResult, ReviewUndoResult, EmptyBinResult, SwApi } from '../../preload'

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
  pKeep?: number
  why?: string
  /** ?reviewBlind=1: an answer he gave on a card that had no picture (what main's review/rescue.ts finds) */
  blind?: 'thrownAway' | 'keptNotImported' | 'keptImported'
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
  // p(keep) and the plain-words reason (`why`) of the doubtful ones: invented, spread both sides of 0.5 so the teaching order differs from newest first
  const unsure = (p: number, why: string, it: MockItem): MockItem => ({ ...it, pKeep: p, why })
  const out: MockItem[] = [
    unsure(0.48, 'Looks like other screenshots you threw away from Google Chrome, but you kept 3 of the last 14.', item('doubtful', 'Google Chrome', 'ChatGPT', 'A ChatGPT window is usually slide material, but this one shows a settings page rather than an answer.')),
    unsure(0.55, 'Not sure, and Luna was not sure either: a short Claude reply; could be a useful example, could be a test.', { ...item('doubtful', 'Claude', 'New chat', 'Not sure, and Luna was not sure either: a short Claude reply; could be a useful example, could be a test.'), decidedBy: 'luna' }),
    unsure(0.42, 'Mostly chat, but a diagram sits in it.', item('doubtful', 'Slack', '#sidequest-apps', 'A Slack thread, but it holds a picture of a TalkWeaver layout.')),
    unsure(0.35, 'Terminal windows are mostly thrown away. This output is clean.', item('doubtful', 'Terminal', 'zsh', 'Terminal, but the output is a clean results table, not an error.')),
    unsure(0.44, 'Few like it so far. It has little to compare with.', item('doubtful', 'WriteFlex', 'Untitled', 'No text it could read. Nothing to go on.')),
    unsure(0.62, 'You kept 4 of the last 9 emails with a quotable line.', item('doubtful', 'Outlook', 'Inbox', 'An email about AI policy with a quotable line, inside the inbox.'))
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
  for (const [app, win, days] of toss) out.push(app === 'Terminal' || app === 'System Settings' ? { ...item('throwaway', app, win, `${app} window — usually throwaway`, days), decidedBy: 'rules' } : item('throwaway', app, win, 'Looks like screenshots you threw away before.', days))
  out[7] = { ...out[7], reason: 'A TalkWeaver layout showcase, useful slide material', decidedBy: 'luna' }
  // one he already kept from an earlier session
  out[8].decision = { state: 'included', decidedAt: new Date(now - DAY).toISOString() }
  // ?reviewBlind=1: answers given an hour ago on cards that had no picture: three thrown away, two kept but not imported, one kept and imported
  if (new URLSearchParams(globalThis.location?.search ?? '').get('reviewBlind') === '1') {
    const at = new Date(now - 3_600_000).toISOString()
    const mark = (i: number, blind: NonNullable<MockItem['blind']>, state: string): void => {
      out[i] = { ...out[i], blind, decision: { state, decidedAt: at } }
    }
    mark(10, 'thrownAway', 'excluded')
    mark(11, 'thrownAway', 'excluded')
    mark(12, 'thrownAway', 'excluded')
    mark(13, 'keptNotImported', 'selected')
    mark(14, 'keptNotImported', 'selected')
    mark(15, 'keptImported', 'included')
  }
  // ?reviewBin=N adds N more items past 30 days (paging and Empty Bin at scale in the UI test)
  const extra = Number(new URLSearchParams(globalThis.location?.search ?? '').get('reviewBin')) || 0
  // every other one the sorter was less sure of (70% instead of 94%), so a how-sure range splits the Bin
  for (let i = 0; i < extra; i++) out.push({ ...item('throwaway', 'Finder', `Old download ${i + 1}`, 'Looks like screenshots you threw away before.', 31 + (i % 60)), ...(i % 2 ? { pKeep: 0.3 } : {}) })
  // ?reviewUnsure=N adds N more unsure ones (a full round of ten in the browser preview and the UI tests)
  const more = Number(new URLSearchParams(globalThis.location?.search ?? '').get('reviewUnsure')) || 0
  const extraUnsure: Array<[string, string]> = [['Quillpad', 'Meeting notes'], ['Mossgrid', 'Board view'], ['Brightloom', 'Timeline'], ['Finder', 'Recents'], ['Claude', 'Draft reply'], ['Slack', 'Thread with a diagram'], ['Outlook', 'Calendar'], ['Google Chrome', 'Error page'], ['WriteFlex', 'Outline'], ['Terminal', 'Build output']]
  for (let i = 0; i < more; i++) {
    const [app, win] = extraUnsure[i % extraUnsure.length]
    out.push(unsure(0.3 + (i % 7) * 0.05, `Few screenshots like it so far, so it has little to compare with (${app}).`, item('doubtful', app, `${win} ${i + 1}`, 'Not sure: it looks a bit like screenshots you kept, but not clearly.')))
  }
  return out
}

export function reviewMock(): SwApi['review'] {
  const now = (): number => Date.now()
  let items = seed(now())
  const undo: Array<{ hash: string; prior: MockItem['decision'] }> = []
  // the retrain the last put-back asked for, as main's ReviewService holds it
  let rescueSeq = 0
  let rescueTraining: { id: number; end: Promise<ReviewRescueRetrain> } | null = null
  const view = (i: MockItem): PileView => pileOf(i, now())
  const live = (): MockItem[] => items.filter((i) => view(i).pile !== 'gone')
  const newest = (a: MockItem, b: MockItem): number => b.takenAt.localeCompare(a.takenAt)
  const unsureFirst = (a: MockItem, b: MockItem): number => Math.abs((a.pKeep ?? 0.5) - 0.5) - Math.abs((b.pKeep ?? 0.5) - 0.5) || newest(a, b)
  // ?reviewThumbs=1 gives every screenshot a picture (a small drawn one), except the first, whose picture does not load:
  // the UI test checks that one picture that fails to load leaves the later cards' pictures alone
  const thumbs = new URLSearchParams(globalThis.location?.search ?? '').get('reviewThumbs') === '1'
  const thumbOf = (hash: string): string | null =>
    !thumbs ? null : hash === 'm001' ? 'data:image/png;base64,AAAA' : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#cdd"/><text x="10" y="55">${hash}</text></svg>`)}`
  // ?reviewPictures=1 gives cards each state without a picture, by hash: m001 not found, m002 not downloaded, m003 no picture
  const states = new URLSearchParams(globalThis.location?.search ?? '').get('reviewPictures') === '1'
  const noPic: Record<string, ReviewCard['picture']> = states ? { m001: 'missing', m002: 'not-downloaded', m003: 'none' } : {}
  const card = (i: MockItem): ReviewCard => {
    const v = view(i)
    const picture = noPic[i.hash] ?? (thumbOf(i.hash) ? 'ok' : 'none')
    return { hash: i.hash, filename: i.filename, app: i.app, windowTitle: i.windowTitle, takenAt: i.takenAt, reason: i.reason, confidence: 0.6, proposal: i.proposal, pile: v.pile as ReviewCard['pile'], by: v.by, decidedBy: i.decidedBy, binInDays: v.binInDays, thumbUrl: noPic[i.hash] ? null : thumbOf(i.hash), offline: picture === 'not-downloaded', picture, revealUrl: picture === 'not-downloaded' ? 'swarchive://f/mock' : null, expectedDir: picture === 'missing' ? '/Volumes/example/Screenshots/2026-10' : null, pKeep: i.pKeep ?? (i.proposal === 'keep' ? 0.93 : 0.06), leans: (i.pKeep ?? (i.proposal === 'keep' ? 0.93 : 0.06)) >= 0.5 ? 'keep' : 'throwaway', why: i.why ?? i.reason }
  }
  const pOf = (i: MockItem): number => i.pKeep ?? (i.proposal === 'keep' ? 0.93 : 0.06)
  // a bad range is refused as main does, never clamped
  const okSure = (sure?: ReviewSure): ReviewSure | undefined => {
    if (sure !== undefined && !parseSure(sure)) throw new Error('review: bad how-sure range')
    return sure
  }
  const head = (sure?: ReviewSure): { needALook: number; kept: number; throwaway: number } => {
    const s = summarise(live().filter((i) => inSure(pOf(i), sure)).map((i) => ({ view: view(i), proposal: i.proposal, decided: Boolean(i.decision) })))
    return { needALook: s.needALook, kept: s.confidentKept, throwaway: s.confidentThrowaway }
  }
  let sureNow: ReviewSure | undefined
  // The UI test slows answers down to check that a late one never overwrites a newer one: window.__reviewMockDelay(sure) gives
  // the milliseconds to hold an overview, piles, page, act or undo answer back (worked out first, delivered late). Unset: answered at once.
  const late = async <T,>(sure: ReviewSure | undefined, answer: T): Promise<T> => {
    const ms = (globalThis as { __reviewMockDelay?: (sure: ReviewSure | null) => number }).__reviewMockDelay?.(sure ?? null) ?? 0
    if (ms > 0) await new Promise((r) => setTimeout(r, ms))
    return answer
  }
  const of = (p: 'kept' | 'throwaway' | 'bin'): MockItem[] => live().filter((i) => view(i).pile === p && inSure(pOf(i), sureNow))
  const keyOf = (i: MockItem) => pileKey(view(i).pile, view(i).binInDays, Date.parse(i.takenAt) || 0, i.hash)
  const pageOf = (p: 'kept' | 'throwaway' | 'bin', after: string | null, limit: number) => {
    const pg = keysetPage(of(p), keyOf, after, Math.min(limit, 500))
    return { total: pg.total, items: pg.items.map(card), next: pg.next }
  }
  // blind answers still standing: an answer he changed since (act, undo) is no longer blind
  const blindNow = (): { items: MockItem[]; answers: ReviewBlindAnswers } => {
    const list = items.filter((i) => i.blind && i.decision && (i.blind === 'thrownAway' ? i.decision.state === 'excluded' : i.blind === 'keptNotImported' ? i.decision.state === 'selected' : i.decision.state === 'included'))
    const n = (k: MockItem['blind']): number => list.filter((i) => i.blind === k).length
    const keptImported = n('keptImported')
    const keptNotImported = n('keptNotImported')
    // why each had no picture: the three states in turn
    const pics: ReviewBlindItem['picture'][] = ['missing', 'not-downloaded', 'none']
    const blindItems = list.map((i, k): ReviewBlindItem => ({ hash: i.hash, filename: i.filename, answer: i.blind === 'thrownAway' ? 'throwaway' : 'keep', picture: pics[k % 3], recorded: k % 2 === 0, putBack: i.blind !== 'keptImported' }))
    return { items: list, answers: { thrownAway: n('thrownAway'), kept: keptImported + keptNotImported, keptImported, keptNotImported, emptied: 0, items: blindItems, token: binToken(list.map((i) => `${i.blind}:${i.hash}:${i.decision?.decidedAt ?? ''}`)) } }
  }
  const lastSortedAt = (): string | null => items.reduce<string | null>((m, i) => (!m || i.proposedAt > m ? i.proposedAt : m), null)
  return {
    overview: async (opts?: { queue?: number; sample?: number; order?: 'newest' | 'teach'; sure?: ReviewSure }): Promise<ReviewOverview> => {
      const sure = okSure(opts?.sure)
      const h = head(sure)
      const a = head()
      const all = live().filter((i) => inSure(pOf(i), sure))
      return late(opts?.sure, {
        needALook: h.needALook,
        confident: { kept: h.kept, throwaway: h.throwaway },
        all: { needALook: a.needALook, confident: a.kept + a.throwaway },
        lastSortedAt: lastSortedAt(),
        queue: all.filter((i) => view(i).pile === 'doubtful').sort(opts?.order === 'teach' ? unsureFirst : newest).slice(0, opts?.queue ?? 50).map(card),
        confidentSample: all.filter((i) => !i.decision && i.proposal !== 'doubtful').sort(newest).slice(0, opts?.sample ?? 12).map(card),
        canUndo: undo.length > 0
      })
    },
    piles: async (opts?: { kept?: number; throwaway?: number; bin?: number; sure?: ReviewSure }): Promise<ReviewPiles> => {
      sureNow = okSure(opts?.sure)
      const h = head(sureNow)
      return late(sureNow, {
        needALook: h.needALook,
        confidentTotal: h.kept + h.throwaway,
        lastSortedAt: lastSortedAt(),
        kept: pageOf('kept', null, opts?.kept ?? 60),
        throwaway: pageOf('throwaway', null, opts?.throwaway ?? 60),
        bin: { ...pageOf('bin', null, opts?.bin ?? 60), token: sureNow ? null : binToken(live().filter((i) => view(i).pile === 'bin').map((i) => i.hash)) },
        canUndo: undo.length > 0
      })
    },
    page: async (pile: 'kept' | 'throwaway' | 'bin', after: string | null, limit?: number, sure?: ReviewSure): Promise<ReviewPage> => {
      sureNow = okSure(sure)
      return late(sureNow, pageOf(pile, after, limit ?? 60))
    },
    // as main answers it: in the order asked for, at most 200, nothing that is in the Bin or gone
    cards: async (hashes: string[]): Promise<ReviewCard[]> => {
      const shown = new Map(live().filter((i) => view(i).pile !== 'bin').map((i) => [i.hash, i]))
      return [...new Set(hashes)].slice(0, 200).flatMap((h) => (shown.has(h) ? [card(shown.get(h)!)] : []))
    },
    act: async (hash: string, action: ReviewAction, shownPicture?: ReviewCard['picture']): Promise<ReviewActResult> => {
      // what each answer said it was shown with, for the UI test (main records it: review/service.ts act)
      const g = globalThis as unknown as { __reviewShown?: Array<[string, string | undefined]> }
      ;(g.__reviewShown ??= []).push([hash, shownPicture])
      const it = items.find((i) => i.hash === hash)
      if (!it) return { ok: false, hash, message: 'This screenshot is no longer in review.' }
      const plan = planAction(view(it), action, now())
      if (plan.kind !== 'decide') return { ok: plan.kind === 'noop', hash, message: plan.reason }
      undo.push({ hash, prior: it.decision })
      it.decision = { state: plan.state === 'selected' ? 'included' : 'excluded', decidedAt: plan.decidedAt }
      const message = plan.state === 'selected' ? (action === 'rescue' ? 'Rescued — kept and added to the well.' : 'Kept — added to the well.') : 'Moved to Throwaway — bin in 30 days. Your original file is not touched.'
      return late(sureNow, { ok: true, hash, message, pile: plan.state === 'selected' ? 'kept' : 'throwaway' })
    },
    undo: async (): Promise<ReviewUndoResult> => {
      const e = undo.pop()
      if (!e) return { ok: false, message: 'Nothing to undo.' }
      const it = items.find((i) => i.hash === e.hash)
      if (it) it.decision = e.prior
      return late(sureNow, { ok: true, hash: e.hash, message: 'Undone.' })
    },
    blindAnswers: async (): Promise<ReviewBlindAnswers> => blindNow().answers,
    // as main does: only the set behind the token, put back to undecided; then a retrain like Retrain now
    rescueBlind: async (token: string): Promise<ReviewRescueResult> => {
      const b = blindNow()
      if (b.answers.token !== token) return { ok: false, reset: 0, error: 'Something changed since you looked; check the list again.' }
      const back = b.items.filter((i) => i.blind !== 'keptImported')
      for (const i of back) {
        i.decision = null
        i.blind = undefined
      }
      if (!back.length) return { ok: true, reset: 0 }
      const id = ++rescueSeq
      const end = (globalThis as unknown as { sw: SwApi }).sw.sorter.retrainNow('manual').then(
        (r): ReviewRescueRetrain => (r.ok ? { ok: true } : { ok: false, error: r.error || 'The sorter could not retrain just now.' }),
        (): ReviewRescueRetrain => ({ ok: false, error: 'The sorter could not retrain just now.' })
      )
      rescueTraining = { id, end }
      return { ok: true, reset: back.length, retrain: id }
    },
    rescueRetrain: async (id: number): Promise<ReviewRescueRetrain | null> => (rescueTraining?.id === id ? rescueTraining.end : null),
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

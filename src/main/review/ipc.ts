/**
 * IPC for the review screen (ticket 08). Types: src/preload/index.ts. Main window only.
 *
 * review:overview and review:cards refuse ("<channel>: bad arguments") anything but what they list:
 *   review:overview  (opts?) nothing, or a plain object with only `queue` and `sample` (whole numbers
 *                    0..500), `order` ('newest' | 'teach'), `sure` (a how-sure range, below) and `notOnMac` (a boolean);
 *                    no further argument
 *   review:piles     (opts?) as before, and `sure` and `notOnMac`
 *   review:page      (pile, after, limit?, sure?, notOnMac?)
 *   `notOnMac` is true or false, nothing else: true = only screenshots whose picture is not on this Mac
 *   review:download-not-on-mac (sure?) download every one in the Not on this Mac view (under the range); one at a time
 *   review:download-cancel / review:download-status  no argument
 *   review:set-leave-out-not-on-mac (on) a boolean
 *   `sure` is { min, max }, nothing else: numbers, 0.5 <= min <= max <= 1 (piles.ts parseSure); a bad one refuses, it is never clamped
 *   review:cards     (hashes) one array of at most 200 hashes; the cards of those still shown in
 *                    Need a look, Kept or Throwaway (service.ts cards)
 *   review:act       (hash, action, shownPicture?) shownPicture, when sent, is one of ok | not-downloaded | missing | none:
 *                    the picture state the card was shown with; anything else refuses
 *   review:blind-answers  (since?) answers given on cards with no picture (rescue.ts); since = an ISO date-time string
 *   review:answers-since  (since, after?, limit?) Review answers still standing since `since` (an ISO date-time string, required), newest first; after = cursor string or null; limit a whole number 1..200
 *   review:rescue-blind   (token, since?) put exactly the set behind that token back to undecided; a bad token is answered { ok: false }
 *   review:rescue-retrain (id) how the retrain that rescue (or retrain-after-answers) asked for ended (answers when it has); null for an unknown id
 *   review:retrain-after-answers  no argument: Look again's Done asks for one training after every answer written so far
 */
import { ipcMain } from 'electron'
import type { ReviewService } from './service'
import { CARDS_MAX, HASH, parseSure } from './piles'
import type { PictureState } from './picture'

const ACTIONS = new Set(['keep', 'throwaway', 'rescue'])
// the picture state the card was shown with (review:act's optional third argument)
const PICTURES: ReadonlySet<string> = new Set<PictureState>(['ok', 'not-downloaded', 'missing', 'none'])

export function registerReviewIpc(svc: ReviewService, allowed: (sender: Electron.WebContents) => boolean): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  const obj = (o: unknown): Record<string, unknown> => (o && typeof o === 'object' ? (o as Record<string, unknown>) : {})
  const plain = (o: unknown): o is Record<string, unknown> => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false
    const proto: unknown = Object.getPrototypeOf(o)
    return proto === Object.prototype || proto === null
  }
  const upTo500 = (x: unknown): boolean => x === undefined || (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 500)
  const sureOk = (x: unknown): boolean => x === undefined || parseSure(x) !== null
  const flagOk = (x: unknown): boolean => x === undefined || typeof x === 'boolean'
  handle('review:overview', (...args: unknown[]) => {
    const bad = new Error('review:overview: bad arguments')
    if (args.length > 1) throw bad
    const o = args[0]
    if (o === undefined) return svc.overview({})
    if (!plain(o) || !Object.keys(o).every((k) => k === 'queue' || k === 'sample' || k === 'order' || k === 'sure' || k === 'notOnMac')) throw bad
    // the queue's order (ticket 22): newest first, or the teaching order
    if (!upTo500(o.queue) || !upTo500(o.sample) || (o.order !== undefined && o.order !== 'newest' && o.order !== 'teach') || !sureOk(o.sure) || !flagOk(o.notOnMac)) throw bad
    return svc.overview({ queue: o.queue as number | undefined, sample: o.sample as number | undefined, order: o.order, sure: o.sure, notOnMac: o.notOnMac })
  })
  handle('review:cards', (...args: unknown[]) => {
    const [hashes] = args
    if (args.length !== 1 || !Array.isArray(hashes) || hashes.length > CARDS_MAX || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) throw new Error('review:cards: bad arguments')
    return svc.cards(hashes as string[])
  })
  handle('review:piles', (o?: unknown) => {
    if (!sureOk(obj(o).sure) || !flagOk(obj(o).notOnMac)) throw new Error('review:piles: bad arguments')
    return svc.piles(obj(o))
  })
  handle('review:act', (hash: unknown, action: unknown, shown: unknown) => {
    if (typeof hash !== 'string' || !HASH.test(hash) || typeof action !== 'string' || !ACTIONS.has(action)) throw new Error('review:act: bad arguments')
    if (shown !== undefined && (typeof shown !== 'string' || !PICTURES.has(shown))) throw new Error('review:act: bad arguments')
    return svc.act(hash, action as 'keep' | 'throwaway' | 'rescue', shown as PictureState | undefined)
  })
  handle('review:page', (pile: unknown, after: unknown, limit: unknown, sure: unknown, notOnMac: unknown) => {
    if (pile !== 'kept' && pile !== 'throwaway' && pile !== 'bin') throw new Error('review:page: bad pile')
    if (!sureOk(sure) || !flagOk(notOnMac)) throw new Error('review:page: bad arguments')
    const rest: [unknown?] = notOnMac === undefined ? [] : [notOnMac]
    return svc.page(pile, typeof after === 'string' && after.length < 400 ? after : null, typeof limit === 'number' ? limit : undefined, sure, ...rest)
  })
  handle('review:download-not-on-mac', (...args: unknown[]) => {
    if (args.length > 1 || !sureOk(args[0])) throw new Error('review:download-not-on-mac: bad arguments')
    return svc.downloadNotOnMac(args[0])
  })
  handle('review:download-cancel', (...args: unknown[]) => {
    if (args.length) throw new Error('review:download-cancel: bad arguments')
    return svc.cancelDownload()
  })
  handle('review:download-status', (...args: unknown[]) => {
    if (args.length) throw new Error('review:download-status: bad arguments')
    return svc.downloadStatus()
  })
  handle('review:set-leave-out-not-on-mac', (...args: unknown[]) => {
    if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('review:set-leave-out-not-on-mac: bad arguments')
    return svc.setLeaveOutNotOnMac(args[0])
  })
  // an ISO-like date-time Date.parse reads; nothing else reaches the service
  const sinceOk = (x: unknown): boolean => x === undefined || (typeof x === 'string' && x.length <= 40 && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(x) && Number.isFinite(Date.parse(x)))
  handle('review:blind-answers', (...args: unknown[]) => {
    if (args.length > 1 || !sinceOk(args[0])) throw new Error('review:blind-answers: bad arguments')
    return svc.blindAnswers(args[0] as string | undefined)
  })
  handle('review:answers-since', (...args: unknown[]) => {
    const [since, after, limit] = args
    if (args.length < 1 || args.length > 3 || typeof since !== 'string' || !sinceOk(since)) throw new Error('review:answers-since: bad arguments')
    if (after !== undefined && after !== null && (typeof after !== 'string' || after.length >= 400)) throw new Error('review:answers-since: bad arguments')
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw new Error('review:answers-since: bad arguments')
    return svc.answersSince(since, after ?? null, limit)
  })
  handle('review:rescue-blind', (...args: unknown[]) => {
    const [token, since] = args
    if (args.length < 1 || args.length > 2 || typeof token !== 'string' || token.length > 100 || !sinceOk(since)) throw new Error('review:rescue-blind: bad arguments')
    return svc.rescueBlind(token, since as string | undefined)
  })
  handle('review:rescue-retrain', (id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('review:rescue-retrain: bad arguments')
    return svc.rescueRetrain(id)
  })
  handle('review:retrain-after-answers', (...args: unknown[]) => {
    if (args.length > 0) throw new Error('review:retrain-after-answers: bad arguments')
    return svc.retrainAfterAnswers()
  })
  handle('review:undo', () => svc.undo())
  handle('review:empty-bin', (token: unknown) => svc.emptyBin(typeof token === 'string' ? token : ''))
}

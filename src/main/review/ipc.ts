/**
 * IPC for the review screen (ticket 08). Types: src/preload/index.ts. Main window only.
 *
 * review:overview and review:cards refuse ("<channel>: bad arguments") anything but what they list:
 *   review:overview  (opts?) nothing, or a plain object with only `queue` and `sample` (whole numbers
 *                    0..500) and `order` ('newest' | 'teach'); no further argument
 *   review:cards     (hashes) one array of at most 200 hashes; the cards of those still shown in
 *                    Need a look, Kept or Throwaway (service.ts cards)
 */
import { ipcMain } from 'electron'
import type { ReviewService } from './service'
import { CARDS_MAX, HASH } from './piles'

const ACTIONS = new Set(['keep', 'throwaway', 'rescue'])

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
  handle('review:overview', (...args: unknown[]) => {
    const bad = new Error('review:overview: bad arguments')
    if (args.length > 1) throw bad
    const o = args[0]
    if (o === undefined) return svc.overview({})
    if (!plain(o) || !Object.keys(o).every((k) => k === 'queue' || k === 'sample' || k === 'order')) throw bad
    // the queue's order (ticket 22): newest first, or the teaching order
    if (!upTo500(o.queue) || !upTo500(o.sample) || (o.order !== undefined && o.order !== 'newest' && o.order !== 'teach')) throw bad
    return svc.overview({ queue: o.queue as number | undefined, sample: o.sample as number | undefined, order: o.order })
  })
  handle('review:cards', (...args: unknown[]) => {
    const [hashes] = args
    if (args.length !== 1 || !Array.isArray(hashes) || hashes.length > CARDS_MAX || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) throw new Error('review:cards: bad arguments')
    return svc.cards(hashes as string[])
  })
  handle('review:piles', (o?: unknown) => svc.piles(obj(o)))
  handle('review:act', (hash: unknown, action: unknown) => {
    if (typeof hash !== 'string' || !HASH.test(hash) || typeof action !== 'string' || !ACTIONS.has(action)) throw new Error('review:act: bad arguments')
    return svc.act(hash, action as 'keep' | 'throwaway' | 'rescue')
  })
  handle('review:page', (pile: unknown, after: unknown, limit: unknown) => {
    if (pile !== 'kept' && pile !== 'throwaway' && pile !== 'bin') throw new Error('review:page: bad pile')
    return svc.page(pile, typeof after === 'string' && after.length < 400 ? after : null, typeof limit === 'number' ? limit : undefined)
  })
  handle('review:undo', () => svc.undo())
  handle('review:empty-bin', (token: unknown) => svc.emptyBin(typeof token === 'string' ? token : ''))
}

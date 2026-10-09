/** IPC for the review screen (ticket 08). Types: src/preload/index.ts. Main window only. */
import { ipcMain } from 'electron'
import type { ReviewService } from './service'

const HASH = /^[A-Za-z0-9:_-]{1,64}$/
const ACTIONS = new Set(['keep', 'throwaway', 'rescue'])

export function registerReviewIpc(svc: ReviewService, allowed: (sender: Electron.WebContents) => boolean): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  const obj = (o: unknown): Record<string, unknown> => (o && typeof o === 'object' ? (o as Record<string, unknown>) : {})
  handle('review:overview', (o?: unknown) => svc.overview(obj(o)))
  handle('review:piles', (o?: unknown) => svc.piles(obj(o)))
  handle('review:act', (hash: unknown, action: unknown) => {
    if (typeof hash !== 'string' || !HASH.test(hash) || typeof action !== 'string' || !ACTIONS.has(action)) throw new Error('review:act: bad arguments')
    return svc.act(hash, action as 'keep' | 'throwaway' | 'rescue')
  })
  handle('review:page', (pile: unknown, offset: unknown, limit: unknown) => {
    if (pile !== 'kept' && pile !== 'throwaway' && pile !== 'bin') throw new Error('review:page: bad pile')
    return svc.page(pile, typeof offset === 'number' ? offset : 0, typeof limit === 'number' ? limit : undefined)
  })
  handle('review:undo', () => svc.undo())
  handle('review:empty-bin', (token: unknown) => svc.emptyBin(typeof token === 'string' ? token : ''))
}

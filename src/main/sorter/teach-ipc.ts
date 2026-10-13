/**
 * IPC for teaching the sorter (ticket 22). Types: src/preload/index.ts. Main window only, like the
 * sorter's other handlers (service.ts, goes-by-and-runs-ipc.ts).
 *
 *   sorter:teach-queue       (after, limit) a page of the screenshots the sorter is least sure of
 *                            (review/service.ts teachQueue). Reads only: an answer is review:act
 *   sorter:learning          the "how much is enough" reading (learning.ts), computed in the worker
 *                            the first time after a training
 *   sorter:retrain-now       (trigger?) train + test + what moved (retrain.ts): 'manual' (default) or
 *                            'round', the end of a teaching round. 'auto' cannot be asked for from here
 *   sorter:set-auto-retrain  ({ enabled?, onBattery? }) the two switches, stored in config
 */
import { ipcMain } from 'electron'
import type { SorterLearning, TeachQueue } from '../../preload'

export type TeachIpcDeps = {
  allowed: (sender: Electron.WebContents) => boolean
  teachQueue: (after: string | null, limit?: number) => Promise<TeachQueue>
  learning: () => Promise<SorterLearning>
  retrain: (trigger: 'manual' | 'round') => Promise<unknown>
  setAuto: (patch: unknown) => { ok: boolean; autoRetrain: boolean; autoRetrainOnBattery: boolean; error?: string }
}

export const TEACH_PAGE_MAX = 500

export function registerTeachIpc(d: TeachIpcDeps): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!d.allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  handle('sorter:teach-queue', (after: unknown, limit: unknown) => {
    const cursor = after === null || after === undefined || (typeof after === 'string' && after.length <= 400)
    const size = limit === undefined || limit === null || (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= TEACH_PAGE_MAX)
    if (!cursor || !size) throw new Error('sorter:teach-queue: bad arguments')
    return d.teachQueue((after as string | null | undefined) ?? null, (limit as number | null | undefined) ?? undefined)
  })
  handle('sorter:learning', () => d.learning())
  handle('sorter:retrain-now', (trigger: unknown) => {
    if (trigger !== undefined && trigger !== null && trigger !== 'manual' && trigger !== 'round') throw new Error('sorter:retrain-now: bad arguments')
    return d.retrain(trigger === 'round' ? 'round' : 'manual')
  })
  // the patch itself is checked where it is stored (retrain.ts setAuto): a bad one is refused there and nothing is stored
  handle('sorter:set-auto-retrain', (patch: unknown) => d.setAuto(patch))
}

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
 *
 * Every handler refuses an argument of the wrong type and any argument beyond the ones listed (and,
 * for set-auto-retrain, a call without its one argument); nothing is guessed from a bad call and
 * none of its arguments reaches what is behind the handler. How a handler refuses is the same for every
 * kind of bad call:
 *   sorter:retrain-now       answers { ok: false, error } (its result's refusal, as when a training fails)
 *   sorter:set-auto-retrain  answers { ok: false, autoRetrain, autoRetrainOnBattery, error } with the
 *                            switches as stored (retrain.ts setAuto: nothing is stored)
 *   sorter:teach-queue,      reject with "<channel>: bad arguments": a page and a reading have no
 *   sorter:learning          refusal value, and an empty one would say "nothing to teach"
 * A cursor is null / absent (the first page) or a string that decodes to a cursor (review/piles.ts):
 * one that does not is refused rather than read as "from the start".
 */
import { ipcMain } from 'electron'
import type { SorterLearning, TeachQueue } from '../../preload'
import { decodeCursor } from '../review/piles'

export type TeachIpcDeps = {
  allowed: (sender: Electron.WebContents) => boolean
  teachQueue: (after: string | null, limit?: number) => Promise<TeachQueue>
  learning: () => Promise<SorterLearning>
  retrain: (trigger: 'manual' | 'round') => Promise<unknown>
  setAuto: (patch: unknown) => { ok: boolean; autoRetrain: boolean; autoRetrainOnBattery: boolean; error?: string }
}

export const TEACH_PAGE_MAX = 500
/** What sorter:retrain-now answers to a call it does not take. */
export const RETRAIN_REFUSED = 'That is not a training the sorter knows how to start.'
/** What setAuto is given for a call with no argument or more than one: not a patch, so it is refused and nothing is stored. */
const NO_PATCH = null

export function registerTeachIpc(d: TeachIpcDeps): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!d.allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  /** Reject unless there are at most `max` arguments and `ok` holds (the two handlers whose result has no refusal value). */
  const need = (channel: string, args: unknown[], max: number, ok: boolean): void => {
    if (args.length > max || !ok) throw new Error(`${channel}: bad arguments`)
  }
  handle('sorter:teach-queue', (...args: unknown[]) => {
    const [after, limit] = args
    const cursor = after === null || after === undefined || (typeof after === 'string' && after.length <= 400 && decodeCursor(after) !== null)
    const size = limit === undefined || (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= TEACH_PAGE_MAX)
    need('sorter:teach-queue', args, 2, cursor && size)
    return d.teachQueue((after as string | null | undefined) ?? null, limit as number | undefined)
  })
  handle('sorter:learning', (...args: unknown[]) => {
    need('sorter:learning', args, 0, true)
    return d.learning()
  })
  handle('sorter:retrain-now', (...args: unknown[]) => {
    const [trigger] = args
    if (args.length > 1 || (trigger !== undefined && trigger !== 'manual' && trigger !== 'round')) return { ok: false, error: RETRAIN_REFUSED }
    return d.retrain(trigger === 'round' ? 'round' : 'manual')
  })
  // The patch is checked where it is stored (retrain.ts setAuto): a bad one is refused there, nothing
  // is stored, and the answer carries the switches as they are. A call that is not exactly one
  // argument gets that same answer: it is passed on as no patch at all (NO_PATCH), never as its first argument
  handle('sorter:set-auto-retrain', (...args: unknown[]) => d.setAuto(args.length === 1 ? args[0] : NO_PATCH))
}

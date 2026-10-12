/**
 * IPC for the Auto sorting tab's "What the sorter goes by" and its piles (ticket 20). Types:
 * src/preload/index.ts. Main window only, like the sorter's other handlers (service.ts).
 *
 *   sorter:goes-by        the per-app table and the built-in rules in words (app-rules.ts)
 *   sorter:set-app-rule   his rule for one app: 'keep' | 'throwaway' | null (none), stored in config.
 *                         It sorts nothing; the next sort uses it. Answers with the table as it is now.
 *   sorter:runs           the kept sort runs, newest first (runs.ts)
 *   sorter:run-piles      one run with the first page of its three piles
 *   sorter:run-page       a further page of one pile
 */
import { ipcMain } from 'electron'
import { changeAppRule, goesBy, type AppRule } from './app-rules'
import { RUN_ID, type SortRuns } from './runs'

export type GoesByAndRunsDeps = {
  allowed: (sender: Electron.WebContents) => boolean
  wellRoot: () => string
  /** His per-app rules as stored in config, and where to store them. */
  appRules: () => unknown
  saveAppRules: (rules: AppRule[]) => void
  runs: SortRuns
}

export function registerGoesByAndRunsIpc(d: GoesByAndRunsDeps): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!d.allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  const table = (): ReturnType<typeof goesBy> => goesBy(d.wellRoot(), d.appRules())
  const runId = (channel: string, x: unknown): string => {
    if (typeof x !== 'string' || !RUN_ID.test(x)) throw new Error(`${channel}: bad arguments`)
    return x
  }
  const size = (x: unknown): number | undefined => (typeof x === 'number' ? x : undefined)
  handle('sorter:goes-by', () => table())
  handle('sorter:set-app-rule', (app: unknown, rule: unknown) => ({ ...changeAppRule(app, rule, d.appRules, d.saveAppRules), goesBy: table() }))
  handle('sorter:runs', () => d.runs.list())
  handle('sorter:run-piles', (id: unknown, o?: unknown) => {
    const opts = o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
    return d.runs.piles(runId('sorter:run-piles', id), { kept: size(opts.kept), throwaway: size(opts.throwaway), unsure: size(opts.unsure) })
  })
  handle('sorter:run-page', (id: unknown, pile: unknown, after: unknown, limit: unknown) => {
    const run = runId('sorter:run-page', id)
    if ((pile !== 'kept' && pile !== 'throwaway' && pile !== 'unsure') || !(after === null || after === undefined || (typeof after === 'string' && after.length <= 400))) throw new Error('sorter:run-page: bad arguments')
    return d.runs.page(run, pile, after ?? null, size(limit))
  })
}

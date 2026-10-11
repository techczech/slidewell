/**
 * IPC for the backlog import (ticket 13). The renderer can only (1) ask for a dry run, (2) run the
 * exact plan it was shown, by id, (3) cancel, (4) read / change CleanShot's export folder on a click.
 * A run without a fresh plan id from a dry run is refused, so a real run always follows a shown plan.
 */
import { ipcMain, shell, type WebContents } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dryRun, real, runImport, type BacklogEnv, type RunProgress } from './backlog-import'
import type { BacklogPlan } from './backlog-plan'
import { cleanShotNameTemplate, cleanShotSetting, setCleanShotExportPath, type DefaultsReader, type DefaultsWriter } from './cleanshot-folder'

/** CleanShot X keeps its capture history here (one folder per capture). Read only. */
export function cleanShotHistoryDir(home = homedir()): string {
  return join(home, 'Library', 'Application Support', 'CleanShot', 'media')
}

const PLAN_TTL_MS = 30 * 60 * 1000

export function registerBacklogIpc(deps: {
  watchedFolder: () => string | null // the Triage source folder (config.screenshotRoot)
  stateDir: () => string
  isMainWindow: (sender: WebContents) => boolean
  afterRun: () => void // e.g. one explicit scan of the capture sources
  writer?: DefaultsWriter
  nameTemplateReader?: DefaultsReader // CleanShot's mediaNameTemplate (default: `defaults read`)
}): void {
  let shown: { id: string; plan: BacklogPlan; at: number } | null = null
  let running: AbortController | null = null

  const env = (): BacklogEnv => ({
    desktopDir: join(homedir(), 'Desktop'),
    cleanshotDir: cleanShotHistoryDir(),
    watchedFolder: deps.watchedFolder(),
    stateDir: deps.stateDir()
  })

  ipcMain.handle('backlog:dry-run', async (e) => {
    if (!deps.isMainWindow(e.sender)) return null
    // Desktop names are recognised with CleanShot's own name template, read fresh for every dry run
    const plan = await dryRun({ ...env(), nameTemplate: await cleanShotNameTemplate(deps.nameTemplateReader) })
    const id = randomUUID()
    shown = { id, plan, at: Date.now() }
    // items are not sent: the renderer shows counts, sizes and examples only
    return { id, plan: plan.ok ? { ...plan, items: [] } : plan }
  })

  ipcMain.handle('backlog:run', async (e, planId: string) => {
    if (!deps.isMainWindow(e.sender)) return null
    if (running) return { refused: 'already running' }
    if (!shown || shown.id !== planId || Date.now() - shown.at > PLAN_TTL_MS) return { refused: 'show the plan again first' }
    const plan = shown.plan
    shown = null // one plan, one run
    running = new AbortController()
    try {
      const result = await runImport(plan, env(), {
        signal: running.signal,
        onProgress: (p: RunProgress) => e.sender.isDestroyed() || e.sender.send('backlog:progress', p)
      })
      deps.afterRun()
      return { result }
    } finally {
      running = null
    }
  })

  ipcMain.handle('backlog:cancel', () => {
    running?.abort()
    return Boolean(running)
  })

  // Opens the folder holding the run logs (one JSONL file per real run).
  ipcMain.handle('backlog:show-logs', async () => {
    const dir = join(deps.stateDir(), 'logs')
    return (await shell.openPath(dir)) === ''
  })

  ipcMain.handle('backlog:cleanshot-setting', async () => {
    const w = deps.watchedFolder()
    return w ? cleanShotSetting(w) : null
  })

  // Writes only the folder the user was shown, and only if it is still the watched folder (by realpath).
  ipcMain.handle('backlog:set-cleanshot', async (e, shown: string) => {
    if (!deps.isMainWindow(e.sender)) return null
    const w = deps.watchedFolder()
    const [a, b] = await Promise.all([realOrNull(w), realOrNull(typeof shown === 'string' ? shown : null)])
    if (!a || !b || a !== b) return { refused: 'the folder changed, review again' }
    return setCleanShotExportPath(shown, deps.writer)
  })
}

const realOrNull = real

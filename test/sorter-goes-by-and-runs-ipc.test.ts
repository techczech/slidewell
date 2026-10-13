import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerGoesByAndRunsIpc } = await import('../src/main/sorter/goes-by-and-runs-ipc')
const { SortRuns } = await import('../src/main/sorter/runs')
const { SorterStore } = await import('../src/main/sorter/store')

let well: string
let stored: unknown
const sender = { id: 1 }
const call = (channel: string, ...args: unknown[]): unknown => ipc.get(channel)!({ sender }, ...args)

beforeEach(() => {
  ipc.clear()
  well = mkdtempSync(join(tmpdir(), 'sw-goes-by-ipc-'))
  stored = undefined
  registerGoesByAndRunsIpc({
    allowed: (s) => s === sender,
    wellRoot: () => well,
    appRules: () => stored,
    saveAppRules: (r) => void (stored = r),
    runs: new SortRuns({ wellRoot: () => well, sourceRoot: () => null, thumbUrl: () => null })
  })
})
afterEach(() => rmSync(well, { recursive: true, force: true }))

describe('IPC: what the sorter goes by, and sort runs', () => {
  it('answers the main window only', () => {
    for (const ch of ['sorter:goes-by', 'sorter:set-app-rule', 'sorter:runs', 'sorter:run-piles', 'sorter:run-page']) {
      expect(() => ipc.get(ch)!({ sender: { id: 2 } }, 'x', 'keep'), ch).toThrow(/not allowed/)
    }
    expect(stored).toBeUndefined()
  })

  it('goes-by gives the built-in rules in words even with no index', () => {
    expect(call('sorter:goes-by')).toEqual({
      apps: [],
      builtIn: { keep: ['Claude or ChatGPT answer', 'Slides on screen', 'Looks like a chart'], throwaway: ['TalkWeaver, WriteFlex or SlideWell screen', 'Terminal window', 'System Settings window', 'Finder window'] }
    })
  })

  it('set-app-rule stores the rule in config and returns the table; a bad rule stores nothing', () => {
    const r = call('sorter:set-app-rule', 'Brightloom', 'throwaway') as { ok: boolean; goesBy: { apps: Array<{ app: string; rule: string | null }> } }
    expect(r.ok).toBe(true)
    expect(stored).toEqual([{ app: 'Brightloom', rule: 'throwaway' }])
    expect(r.goesBy.apps).toMatchObject([{ app: 'Brightloom', rule: 'throwaway' }])
    expect((call('sorter:set-app-rule', 'Brightloom', 'bin it') as { ok: boolean }).ok).toBe(false)
    expect((call('sorter:set-app-rule', { app: 'x' }, 'keep') as { ok: boolean }).ok).toBe(false)
    expect(stored).toEqual([{ app: 'Brightloom', rule: 'throwaway' }])
    expect((call('sorter:set-app-rule', 'brightloom', null) as { ok: boolean }).ok).toBe(true)
    expect(stored).toEqual([])
  })

  it('runs, run-piles and run-page validate their arguments', () => {
    const s = new SorterStore(well)
    s.startRun({ id: 'run-1', startedAt: '2026-10-13T14:20:00.000Z', period: '30d', trigger: 'manual' })
    s.writeProposals([{ hash: 'a', proposal: 'keep', confidence: 0.9, pKeep: 0.9, reason: 'r', rule: null }], 'v', null, 'run-1')
    s.close()
    expect(call('sorter:runs')).toMatchObject([{ id: 'run-1', period: '30d', now: { kept: 1 } }])
    expect(call('sorter:run-piles', 'run-1')).toMatchObject({ run: { id: 'run-1' }, kept: { total: 1 } })
    expect(call('sorter:run-page', 'run-1', 'kept', null, 10)).toMatchObject({ total: 1, next: null })
    expect(() => call('sorter:run-piles', 'run 1; DROP')).toThrow(/bad arguments/)
    expect(() => call('sorter:run-piles', 7)).toThrow(/bad arguments/)
    expect(() => call('sorter:run-page', 'run-1', 'bin', null)).toThrow(/bad arguments/)
    expect(() => call('sorter:run-page', 'run-1', 'kept', 'x'.repeat(401))).toThrow(/bad arguments/)
  })
})

describe('IPC: Triage by app goes through the guard in the main process', () => {
  it('apps and decide-all are guarded handlers that validate before they act', () => {
    const text = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    for (const ch of ['triage:apps', 'triage:decide-all']) expect(text).toContain(`guardedHandle(ipcMain, fromMainWindow, '${ch}'`)
  })
})

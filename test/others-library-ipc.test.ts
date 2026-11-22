import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archiveResults, listDecks } from '../src/main/archive'
import type { AppHandle } from '../src/main/app-handle'
import { install } from '../src/main/others-library-ipc'

vi.mock('../src/main/archive', () => ({
  archiveResults: vi.fn(),
  listDecks: vi.fn(),
  searchImages: vi.fn(async () => [])
}))
vi.mock('../src/main/deckmeta', () => ({ invalidateDeckMeta: vi.fn() }))
vi.mock('../src/main/ingest', () => ({ runIngest: vi.fn() }))

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function fixture(overlap = false) {
  const root = mkdtempSync(join(tmpdir(), 'sw-others-ipc-'))
  scratch.push(root)
  const personal = join(root, 'personal')
  const others = overlap ? join(personal, 'others') : join(root, 'others')
  const matching = join(others, 'extracted', 'matching')
  const kept = join(others, 'extracted', 'kept')
  const personalDeck = join(personal, 'extracted', 'matching')
  for (const dir of [matching, kept, personalDeck, join(others, 'registry')]) mkdirSync(dir, { recursive: true })
  const marker = join(personalDeck, 'original.txt')
  writeFileSync(marker, 'unchanged')
  const handlers = new Map<string, Parameters<AppHandle>[1]>()
  const showMessageBox = vi.fn(async () => ({ response: 1, checkboxChecked: false }))
  install({
    appHandle: (channel, handler) => void handlers.set(channel, handler),
    dialog: { showMessageBox, showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    archiveRoot: () => personal,
    archiveAvailable: () => false,
    othersArchiveRootResolved: () => others,
    othersArchiveAvailable: () => true,
    readConfig: () => ({}),
    writeConfig: vi.fn(),
    cacheDir: () => root,
    python: () => 'python3',
    sendConvertLine: vi.fn()
  })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
  return { personal, others, matching, kept, marker, showMessageBox, invoke }
}

describe("Others' Library IPC", () => {
  it('removes only the matching deck from the Others root after confirmation', async () => {
    const { others, matching, kept, marker, showMessageBox, invoke } = fixture()
    vi.mocked(listDecks).mockResolvedValue([{ id: 'matching' }, { id: 'kept' }] as Awaited<ReturnType<typeof listDecks>>)
    vi.mocked(archiveResults).mockResolvedValue([{ representative: { deck: 'matching' }, members: [] }] as Awaited<ReturnType<typeof archiveResults>>)

    await expect(invoke('others:delete-matching', 'lesson', { owner: 'mine', library: 'all' })).resolves.toEqual({ ok: true, deleted: 1 })
    expect(archiveResults).toHaveBeenCalledWith(others, expect.any(String), 'lesson', { owner: 'all', library: 'others' })
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Cancel', 'Delete 1'], defaultId: 0, cancelId: 0 }))
    expect(existsSync(matching)).toBe(false)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(marker)).toBe(true)
  })

  it('refuses to clear overlapping roots before asking for confirmation', async () => {
    const { matching, kept, marker, showMessageBox, invoke } = fixture(true)

    await expect(invoke('settings:clear-others-library')).resolves.toEqual({ ok: false })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(existsSync(matching)).toBe(true)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(marker)).toBe(true)
  })
})

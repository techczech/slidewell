import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerReviewIpc } = await import('../src/main/review/ipc')
const { ReviewService, downloadWords } = await import('../src/main/review/service')
const { setTriageOffline } = await import('../src/main/triage')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { openTriage, seedProposals, teachWell } = await import('./sorter-teach-fixture')

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})
const NOW = Date.parse('2026-10-13T10:00:00Z')

// how each screenshot's file is: 'here' (on this Mac), 'flag' (the scan row says placeholder), 'gone' (the row says
// downloaded but the file is a placeholder on disk now: the stub `dataless` says so; no real placeholder is ever made)
type Shot = { hash: string; pKeep: number; proposal: 'keep' | 'throwaway' | 'doubtful'; file: 'here' | 'flag' | 'gone'; old?: boolean }
const SHOTS: Shot[] = [
  { hash: 'd1here', pKeep: 0.5, proposal: 'doubtful', file: 'here' },
  { hash: 'd2flag', pKeep: 0.55, proposal: 'doubtful', file: 'flag' },
  { hash: 'd3gone', pKeep: 0.35, proposal: 'doubtful', file: 'gone' },
  { hash: 'k1here', pKeep: 0.9, proposal: 'keep', file: 'here' },
  { hash: 'k2gone', pKeep: 0.97, proposal: 'keep', file: 'gone' },
  { hash: 't1flag', pKeep: 0.1, proposal: 'throwaway', file: 'flag' },
  { hash: 'b1gone', pKeep: 0.03, proposal: 'throwaway', file: 'gone', old: true },
  { hash: 'b2here', pKeep: 0.03, proposal: 'throwaway', file: 'here', old: true }
]
const AWAY = SHOTS.filter((s) => s.file !== 'here').map((s) => s.hash)

/** A well with SHOTS, each with one file in the well's source folder; `cloud` = the files the stub calls placeholders. */
function well(): { w: string; src: string; cloud: Set<string> } {
  const w = teachWell(0, 0, [])
  wells.push(w)
  new SorterStore(w).close()
  const src = join(w, 'source')
  mkdirSync(src, { recursive: true })
  const t = openTriage(w)
  const cloud = new Set<string>()
  try {
    const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', ?, '', ?, ?, 'Invented App', '')")
    SHOTS.forEach((s, i) => {
      const rel = `${s.hash}.png`
      writeFileSync(join(src, rel), Buffer.alloc(16, 1))
      row.run(s.hash, rel, rel, s.file === 'flag' ? '1' : '0', src, `2026-10-12T09:${String(10 + i)}:00`)
      if (s.file !== 'here') cloud.add(join(src, rel))
    })
  } finally {
    t.close()
  }
  seedProposals(w, SHOTS.filter((s) => !s.old).map((s) => ({ hash: s.hash, pKeep: s.pKeep, proposal: s.proposal, sorterVersion: SORTER_VERSION })))
  seedProposals(w, SHOTS.filter((s) => s.old).map((s) => ({ hash: s.hash, pKeep: s.pKeep, proposal: s.proposal, sorterVersion: SORTER_VERSION, proposedAt: '2026-09-03T08:00:00.000Z' })))
  return { w, src, cloud }
}

type Svc = InstanceType<typeof ReviewService>
function service(w: string, cloud: Set<string>, extra: Partial<ConstructorParameters<typeof ReviewService>[0]> = {}): { svc: Svc; leave: { on: boolean } } {
  const leave = { on: false }
  const svc = new ReviewService({
    wellRoot: () => w,
    archiveRoot: () => join(w, 'archive'),
    sourceRoot: () => null,
    thumbUrl: (abs) => (abs ? `swthumb://t${abs}` : null),
    allowedRoots: () => [join(w, 'source')],
    now: () => NOW,
    dataless: (abs) => cloud.has(abs),
    leaveOutNotOnMac: () => leave.on,
    saveLeaveOutNotOnMac: (on) => void (leave.on = on),
    ...extra
  })
  return { svc, leave }
}
const hashes = (cards: Array<{ hash: string }>): string[] => cards.map((c) => c.hash).sort()
const flagOf = (w: string, hash: string): string => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return (db.prepare('SELECT offline FROM triage_fts WHERE hash = ?').get(hash) as { offline: string }).offline
  } finally {
    db.close()
  }
}

describe('Not on this Mac: the count and the filter', () => {
  it('counts need a look and the sorted piles (Bin included) whose picture is a placeholder, by row flag or on disk', async () => {
    const { w, cloud } = well()
    const { svc } = service(w, cloud)
    const o = await svc.overview()
    expect(o.notOnMac).toBe(AWAY.length)
    expect(o.leaveOutNotOnMac).toBe(false)
    expect(hashes(o.queue)).toEqual(['d1here', 'd2flag', 'd3gone'])
    const [card] = await svc.cards(['d3gone'])
    expect(card).toMatchObject({ picture: 'not-downloaded', thumbUrl: null })
    expect(card.revealUrl).toContain('d3gone.png')
  })

  it('the filter shows only those, in the queue and the piles, and keeps the tab count and the Bin token honest', async () => {
    const { w, cloud } = well()
    const { svc } = service(w, cloud)
    const o = await svc.overview({ notOnMac: true })
    expect(hashes(o.queue)).toEqual(['d2flag', 'd3gone'])
    expect(o.needALook).toBe(2)
    expect(o.all.needALook).toBe(3) // the tab's count is Review as a whole
    expect(o.notOnMac).toBe(AWAY.length)
    const p = await svc.piles({ notOnMac: true })
    expect(hashes(p.kept.items)).toEqual(['k2gone'])
    expect(hashes(p.throwaway.items)).toEqual(['t1flag'])
    expect(hashes(p.bin.items)).toEqual(['b1gone'])
    expect(p.bin.token).toBeNull() // only part of the Bin: Empty Bin is never offered from here
    expect(hashes((await svc.page('bin', null, 10, undefined, true)).items)).toEqual(['b1gone'])
    expect((await svc.piles()).bin.token).not.toBeNull()
  })

  it('combines with How sure: both must hold', async () => {
    const { w, cloud } = well()
    const { svc } = service(w, cloud)
    const o = await svc.overview({ notOnMac: true, sure: { min: 0.65, max: 0.65 } })
    expect(hashes(o.queue)).toEqual(['d3gone'])
    const p = await svc.piles({ notOnMac: true, sure: { min: 0.95, max: 1 } })
    expect(hashes([...p.kept.items, ...p.throwaway.items, ...p.bin.items])).toEqual(['b1gone', 'k2gone'])
    expect(o.notOnMac).toBe(AWAY.length) // the chip's count is never narrowed
  })

  it('a flag that is not true or false is refused, never read as either', async () => {
    const { w, cloud } = well()
    const { svc } = service(w, cloud)
    await expect(svc.overview({ notOnMac: 'yes' })).rejects.toThrow(/not-on-this-Mac/)
    await expect(svc.piles({ notOnMac: 1 })).rejects.toThrow(/not-on-this-Mac/)
    await expect(svc.page('kept', null, 10, undefined, 'true')).rejects.toThrow(/not-on-this-Mac/)
  })
})

describe('Not on this Mac: leave them out', () => {
  it('hides them from the queue, the piles and the teaching queue, not from the filter, and they come back once here', async () => {
    const { w, cloud, src } = well()
    const { svc, leave } = service(w, cloud)
    expect(svc.setLeaveOutNotOnMac(true)).toBe(true)
    expect(leave.on).toBe(true)
    const o = await svc.overview()
    expect(o.leaveOutNotOnMac).toBe(true)
    expect(hashes(o.queue)).toEqual(['d1here'])
    expect(o.all.needALook).toBe(1)
    expect(o.notOnMac).toBe(AWAY.length)
    const p = await svc.piles()
    expect(hashes([...p.kept.items, ...p.throwaway.items, ...p.bin.items])).toEqual(['b2here', 'k1here'])
    expect(p.bin.token).toBeNull() // a Bin item is left out: the Bin shown is not the whole Bin
    expect(hashes((await svc.teachQueue()).items)).toEqual(['d1here'])
    expect(hashes((await svc.overview({ notOnMac: true })).queue)).toEqual(['d2flag', 'd3gone'])
    // downloaded (by any means): back in Review at the next read after a scan (or within 60 s: not-on-mac-cache.ts)
    cloud.delete(join(src, 'd3gone.png'))
    svc.filesChanged()
    expect(hashes((await svc.overview()).queue)).toEqual(['d1here', 'd3gone'])
    svc.setLeaveOutNotOnMac(false)
    expect(hashes((await svc.overview()).queue)).toEqual(['d1here', 'd2flag', 'd3gone'])
  })

  it('an answer to a hidden one still goes through (from the filter view)', async () => {
    const { w, cloud } = well()
    const { svc } = service(w, cloud)
    svc.setLeaveOutNotOnMac(true)
    expect((await svc.act('d3gone', 'throwaway')).ok).toBe(true)
  })
})

describe('Not on this Mac: Download them', () => {
  it('asks for each placeholder in the view, need a look first, sets each row flag to what the file is now, and reports counts', async () => {
    const { w, cloud, src } = well()
    const asked: string[] = []
    const progress: Array<{ current: number; total: number; running: boolean }> = []
    const { svc } = service(w, cloud, {
      // the stub provider: d2flag never comes down; the rest do
      download: async (abs) => {
        asked.push(abs.split('/').pop()!)
        if (!abs.includes('d2flag')) cloud.delete(abs)
      },
      downloadProgress: (p) => progress.push({ current: p.current, total: p.total, running: p.running })
    })
    const r = await svc.downloadNotOnMac()
    expect(asked.slice(0, 2).sort()).toEqual(['d2flag.png', 'd3gone.png']) // need a look first
    expect(asked).toHaveLength(AWAY.length)
    expect(r).toMatchObject({ ok: true, total: AWAY.length, done: AWAY.length - 1, failed: 1, cancelled: false })
    expect(r.message).toBe(`Downloaded ${AWAY.length - 1} of ${AWAY.length}. 1 could not be downloaded (offline, unavailable or slower than a minute); they stay in this list.`)
    expect(flagOf(w, 't1flag')).toBe('0')
    expect(flagOf(w, 'd2flag')).toBe('1')
    expect(flagOf(w, 'd3gone')).toBe('0')
    expect(progress.map((p) => p.current)).toEqual([...AWAY.map((_, i) => i + 1), 0])
    expect(progress.at(-1)!.running).toBe(false)
    const o = await svc.overview({ notOnMac: true })
    expect(o.notOnMac).toBe(1)
    expect(hashes(o.queue)).toEqual(['d2flag'])
    expect(cloud.has(join(src, 'd2flag.png'))).toBe(true)
  })

  it('downloads only what the range shows, runs one at a time, and Cancel stops it', async () => {
    const { w, cloud } = well()
    let release: (() => void) | null = null
    const asked: string[] = []
    const { svc } = service(w, cloud, {
      download: (abs) => {
        asked.push(abs.split('/').pop()!)
        return new Promise<void>((res) => (release = res))
      }
    })
    const run = svc.downloadNotOnMac({ min: 0.65, max: 0.65 })
    await vi.waitFor(() => expect(asked).toEqual(['d3gone.png']))
    expect(svc.downloadStatus()).toMatchObject({ running: true, total: 1, current: 1 })
    expect(await svc.downloadNotOnMac()).toMatchObject({ ok: false, message: 'A download is already running.' })
    expect(svc.cancelDownload()).toBe(true)
    release!()
    const r = await run
    expect(r).toMatchObject({ ok: true, total: 1, done: 0, failed: 0, cancelled: true })
    expect(svc.downloadStatus()).toBeNull()
    expect(svc.cancelDownload()).toBe(false)
  })

  it('says so in plain words when there is nothing to download', () => {
    expect(downloadWords({ total: 0, done: 0, failed: 0, cancelled: false })).toBe('Nothing to download: every screenshot here is on this Mac.')
    expect(downloadWords({ total: 140, done: 12, failed: 0, cancelled: true })).toBe('Stopped. Downloaded 12 of 140.')
  })
})

describe('Not on this Mac: the picture chooser', () => {
  it('a copy that is a placeholder on disk is passed over for a copy that is here, whatever its row says', async () => {
    const { w, cloud } = well()
    const here = join(w, 'source2')
    mkdirSync(here, { recursive: true })
    writeFileSync(join(here, 'copy.png'), Buffer.alloc(16, 1))
    const t = openTriage(w)
    t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES ('d3gone', 'image', 'copy.png', 'copy.png', 'png', '0', '', ?, '', '', '')").run(here)
    t.close()
    const { svc } = service(w, cloud, { allowedRoots: () => [join(w, 'source'), here] })
    const [c] = await svc.cards(['d3gone'])
    expect(c).toMatchObject({ picture: 'ok', thumbUrl: `swthumb://t${join(here, 'copy.png')}` })
  })
})

describe('setTriageOffline', () => {
  it('changes only the flag of the rows at that path, and only when it differs', async () => {
    const { w } = well()
    const src = join(w, 'source')
    expect(setTriageOffline(w, src, 't1flag.png', false)).toBe(1)
    expect(setTriageOffline(w, src, 't1flag.png', false)).toBe(0)
    expect(flagOf(w, 't1flag')).toBe('0')
    expect(flagOf(w, 'd2flag')).toBe('1')
    expect(setTriageOffline(w, '/nowhere', 'x.png', true)).toBe(0)
  })
})

describe('Not on this Mac: IPC', () => {
  it('takes only true or false for the view, a range for Download them, and a boolean for the switch', async () => {
    const { w, cloud } = well()
    const { svc } = service(w, cloud)
    ipc.clear()
    registerReviewIpc(svc, () => true)
    const call = (ch: string, ...args: unknown[]): unknown => ipc.get(ch)!({ sender: null }, ...args)
    expect(((await call('review:overview', { notOnMac: true })) as { queue: unknown[] }).queue).toHaveLength(2)
    expect(() => call('review:overview', { notOnMac: 'yes' })).toThrow('review:overview: bad arguments')
    expect(() => call('review:piles', { notOnMac: 1 })).toThrow('review:piles: bad arguments')
    expect(() => call('review:page', 'kept', null, 10, undefined, 'x')).toThrow('review:page: bad arguments')
    expect(((await call('review:page', 'kept', null, 10, undefined, true)) as { total: number }).total).toBe(1)
    expect(() => call('review:download-not-on-mac', { min: 0.2, max: 1 })).toThrow('review:download-not-on-mac: bad arguments')
    expect(() => call('review:download-cancel', 1)).toThrow('review:download-cancel: bad arguments')
    expect(call('review:download-status')).toBeNull()
    expect(() => call('review:set-leave-out-not-on-mac', 'on')).toThrow('review:set-leave-out-not-on-mac: bad arguments')
    expect(call('review:set-leave-out-not-on-mac', true)).toBe(true)
  })
})

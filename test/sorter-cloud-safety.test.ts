// The cloud step's safety rules (fix round 1 after review): consent held in main, a fixed per-night
// limit kept in the database, bytes re-verified before sending, the key redacted out of Luna's words,
// screenshots only, eligibility re-checked before each request and each proposal write, and one
// claim per screenshot across processes. Synthetic data only (sorter-cloud-fixture.ts).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter, applySettingsPatch, normaliseCloudSettings, NIGHTLY_LIMIT, PREPARED_TTL_MS } = await import('../src/main/sorter/cloud/service')
const { SorterStore, CLAIM_STALE_MS } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { LUNA } = await import('../src/main/sorter/cloud/luna')
const { readVerified, contentHash } = await import('../src/main/sorter/cloud/images')
const { makeCloudWell, readProposal, lunaStub, cloudDeps, hashOf, bytesOf, relOf, sourceOf } = await import('./sorter-cloud-fixture')

const KEY = 'sk-test-FAKEKEY0123456789abcdefWXYZ'
const SCOPE = { sorterVersion: SORTER_VERSION, model: LUNA.model, promptVersion: LUNA.promptVersion }

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
const well = (...a: Parameters<typeof makeCloudWell>): string => {
  const w = makeCloudWell(...a)
  dirs.push(w)
  return w
}
const four = (): string =>
  well([
    { hash: 'd1', proposal: 'doubtful', window: 'keep-chart', takenAt: '2026-10-04T10:00:00' },
    { hash: 'd2', proposal: 'doubtful', window: 'toss-wifi', takenAt: '2026-10-03T10:00:00' },
    { hash: 'd3', proposal: 'doubtful', window: 'weak-picker', takenAt: '2026-10-02T10:00:00' },
    { hash: 'd4', proposal: 'doubtful', window: 'blurry', takenAt: '2026-10-01T10:00:00' }
  ])
const sql = (w: string, q: string, ...args: Array<string | number>): void => {
  const db = new DatabaseSync(join(w, 'triage.db'))
  try {
    db.prepare(q).run(...args)
  } finally {
    db.close()
  }
}
const decide = (w: string, name: string, state: string): void => sql(w, 'INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)', hashOf(name), state, '2026-10-10')
const allowance = (w: string, night: string): number => {
  const st = new SorterStore(w)
  try {
    return st.allowanceUsed(night)
  } finally {
    st.close()
  }
}
const sentWindows = (stub: ReturnType<typeof lunaStub>): string[] => stub.seen.flatMap((r) => r.windows)

describe('finding 1: consent lives in main', () => {
  it('off by default; saving settings with enabled records the opt-in; an old enabled flag or a cap is ignored', () => {
    expect(normaliseCloudSettings({}).enabled).toBe(false)
    const now = new Date('2026-10-11T09:00:00Z')
    const on = applySettingsPatch({}, { enabled: true, nightlyCap: 5000 }, now)
    expect(on).toEqual({ optedInAt: '2026-10-11T09:00:00.000Z', batchTime: '02:00' })
    expect(normaliseCloudSettings(on).enabled).toBe(true)
    expect(applySettingsPatch(on, { batchTime: '03:15' }, new Date('2026-10-12T09:00:00Z'))).toEqual({ optedInAt: '2026-10-11T09:00:00.000Z', batchTime: '03:15' }) // opt-in time kept
    expect(applySettingsPatch(on, { enabled: false }, now).optedInAt).toBeNull()
    expect(applySettingsPatch({}, { batchTime: '04:00' }, now).optedInAt).toBeNull() // changing the time never opts in
  })

  it('with the cloud step off, a nightly run and Sort now send nothing, even with a key', async () => {
    const w = four()
    const stub = lunaStub()
    const d = cloudDeps(w, { http: stub.http, settings: { enabled: false } })
    const svc = new CloudSorter(d)
    expect(await svc.runNightly()).toMatchObject({ skipped: 'off', asked: 0 })
    const p = await svc.prepare()
    expect(p).toMatchObject({ blocked: 'off', token: null })
    expect(await svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(stub.seen).toHaveLength(0)
  })

  it('send without a prepared batch, with a wrong token, or with an expired one is refused', async () => {
    const w = four()
    const stub = lunaStub()
    let now = new Date(2026, 9, 11, 14, 0)
    const svc = new CloudSorter(cloudDeps(w, { http: stub.http, now: () => now }))
    expect(await svc.send(300)).toMatchObject({ skipped: 'not-prepared', asked: 0 }) // the old count-only call
    expect(await svc.send(undefined)).toMatchObject({ skipped: 'not-prepared' })
    const p = await svc.prepare()
    expect(await svc.send('not-the-token')).toMatchObject({ skipped: 'not-prepared' })
    now = new Date(now.getTime() + PREPARED_TTL_MS + 1000)
    expect(await svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(stub.seen).toHaveLength(0)
  })

  it('send sends exactly the prepared batch, once: a screenshot that became doubtful afterwards is not in it', async () => {
    const w = well([
      { hash: 'd1', proposal: 'doubtful', window: 'keep-chart', takenAt: '2026-10-04T10:00:00' },
      { hash: 'k1', proposal: 'keep', window: 'keep-later', takenAt: '2026-10-05T10:00:00' }
    ])
    const stub = lunaStub()
    const svc = new CloudSorter(cloudDeps(w, { http: stub.http }))
    const p = await svc.prepare()
    expect(p.toSend).toBe(1)
    sql(w, "UPDATE sorter_proposals SET proposal = 'doubtful' WHERE hash = ?", hashOf('k1')) // a later local sort
    expect(await svc.send(p.token)).toMatchObject({ trigger: 'manual', asked: 1 })
    expect(sentWindows(stub)).toEqual(['keep-chart'])
    expect(await svc.send(p.token)).toMatchObject({ skipped: 'not-prepared' }) // a token is used once
    expect(stub.seen).toHaveLength(1)
  })
})

describe('finding 2: a fixed, persisted per-night limit', () => {
  it('moving the batch time after a run cannot open a second allowance that night; the next night can', async () => {
    const w = four()
    const stub = lunaStub()
    new SorterStore(w).close() // the allowance table exists
    sql(w, 'INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?)', '2026-10-10', NIGHTLY_LIMIT - 1)
    let now = new Date(2026, 9, 11, 2, 0)
    const d = cloudDeps(w, { http: stub.http, now: () => now })
    const settings = d.settings() // the live settings object
    d.stateBox.since = new Date(2026, 9, 10, 9, 0).toISOString()
    const svc = new CloudSorter(d)
    expect((await svc.tick())?.asked).toBe(1) // one left tonight: the newest
    expect(sentWindows(stub)).toEqual(['keep-chart'])
    expect(allowance(w, '2026-10-10')).toBe(NIGHTLY_LIMIT)
    // he moves the batch to 03:00: the slot is due again, but tonight's limit is used up
    settings.batchTime = '03:00'
    now = new Date(2026, 9, 11, 3, 0)
    expect(await svc.tick()).toMatchObject({ skipped: 'limit-reached', asked: 0 })
    // a Sort now the same morning shares the night's limit
    now = new Date(2026, 9, 11, 9, 0)
    expect(await svc.prepare()).toMatchObject({ blocked: 'limit-reached', toSend: 0, leftTonight: 0, token: null })
    expect(stub.seen).toHaveLength(1)
    // the next night has its own limit
    now = new Date(2026, 9, 12, 3, 0)
    expect((await svc.tick())?.asked).toBe(3)
    expect(allowance(w, '2026-10-11')).toBe(3)
  })

  it('a screenshot that never went into a request is given back to the night', async () => {
    const w = four()
    unlinkSync(join(sourceOf(w), relOf({ hash: 'd4', proposal: 'doubtful', window: 'blurry' })))
    writeFileSync(join(sourceOf(w), relOf({ hash: 'd4', proposal: 'doubtful', window: 'blurry' })), 'changed bytes')
    const now = new Date(2026, 9, 11, 2, 0)
    await new CloudSorter(cloudDeps(w, { http: lunaStub().http, now: () => now })).runNightly()
    expect(allowance(w, '2026-10-10')).toBe(3)
  })
})

describe('finding 3: the bytes sent are the bytes classified', () => {
  it('a screenshot replaced after it was classified is not sent and stays doubtful; the log names no file', async () => {
    const w = four()
    const rel = relOf({ hash: 'd2', proposal: 'doubtful', window: 'toss-wifi' })
    writeFileSync(join(sourceOf(w), rel), Buffer.concat([bytesOf('d2'), Buffer.from('a confidential replacement')]))
    const stub = lunaStub()
    const d = cloudDeps(w, { http: stub.http })
    const s = await new CloudSorter(d).runNightly()
    expect(sentWindows(stub).sort()).toEqual(['blurry', 'keep-chart', 'weak-picker'])
    expect(s.asked).toBe(3)
    expect(readProposal(w, 'd2')).toMatchObject({ proposal: 'doubtful', decided_by: null })
    const log = d.logs.join('\n')
    expect(log).toMatch(/1 screenshot\(s\) not sent: the file changed since it was scanned/)
    expect(log).not.toContain('toss-wifi')
    expect(log).not.toContain(sourceOf(w))
  })

  it('a screenshot whose path became a symlink is not sent, even to identical bytes', async () => {
    const w = four()
    const rel = relOf({ hash: 'd1', proposal: 'doubtful', window: 'keep-chart' })
    const elsewhere = join(w, 'elsewhere.png')
    writeFileSync(elsewhere, bytesOf('d1'))
    unlinkSync(join(sourceOf(w), rel))
    symlinkSync(elsewhere, join(sourceOf(w), rel))
    const stub = lunaStub()
    await new CloudSorter(cloudDeps(w, { http: stub.http })).runNightly()
    expect(sentWindows(stub)).not.toContain('keep-chart')
  })

  it('readVerified: regular file with the right hash only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-verify-'))
    dirs.push(dir)
    const f = join(dir, 'a.png')
    writeFileSync(f, 'picture bytes')
    const h = contentHash(Buffer.from('picture bytes'))
    expect(await readVerified(f, h)).toMatchObject({ ok: true })
    expect(await readVerified(f, 'aaaaaaaaaaaa')).toEqual({ ok: false, why: 'changed' })
    symlinkSync(f, join(dir, 'link.png'))
    expect(await readVerified(join(dir, 'link.png'), h)).toEqual({ ok: false, why: 'symlink' })
    mkdirSync(join(dir, 'folder.png'))
    expect(await readVerified(join(dir, 'folder.png'), h)).toEqual({ ok: false, why: 'not-a-file' })
    expect(await readVerified(join(dir, 'missing.png'), h)).toEqual({ ok: false, why: 'unreadable' })
  })
})

describe("finding 4: the key never comes back in Luna's words", () => {
  it('a reason that contains the key is stored and shown redacted', async () => {
    const w = four()
    const stub = lunaStub()
    const http: typeof stub.http = async (url, init) => {
      const res = await stub.http(url, init)
      const text = (await res.text()).split('A chart worth keeping.').join(`The screen shows the key ${KEY} and sk-other-0123456789.`)
      return { status: 200, headers: res.headers, text: async () => text }
    }
    await new CloudSorter(cloudDeps(w, { http, keyValue: KEY })).runNightly()
    const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
    try {
      const dump = JSON.stringify([db.prepare('SELECT * FROM sorter_cloud_answers').all(), db.prepare('SELECT * FROM sorter_proposals').all()])
      expect(dump).not.toContain(KEY)
      expect(dump).not.toContain('sk-other')
      expect(dump).toContain('[key]')
    } finally {
      db.close()
    }
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'keep', decided_by: 'luna', reason: 'The screen shows the key [key] and [key]' })
  })
})

describe('finding 5: screenshots only', () => {
  it('a doubtful picture whose file name is not a screenshot name never leaves the Mac', async () => {
    const w = well([
      { hash: 'shot', proposal: 'doubtful', window: 'keep-chart', takenAt: '2026-10-04T10:00:00' },
      { hash: 'photo', proposal: 'doubtful', window: 'keep-photo', filename: 'IMG_0042.jpg' },
      { hash: 'scan', proposal: 'doubtful', window: 'keep-scan', filename: 'contract scan.png' },
      { hash: 'mac', proposal: 'doubtful', window: 'keep-mac', filename: 'Screenshot 2026-10-02 at 10.05.01.png' }
    ])
    const stub = lunaStub()
    const svc = new CloudSorter(cloudDeps(w, { http: stub.http }))
    expect((await svc.prepare()).doubtful).toBe(2)
    await svc.runNightly()
    expect(stub.seen.reduce((n, r) => n + r.images, 0)).toBe(2)
    expect(sentWindows(stub)).not.toContain('keep-photo')
    expect(sentWindows(stub)).not.toContain('keep-scan')
    expect(readProposal(w, 'photo')).toMatchObject({ proposal: 'doubtful', decided_by: null })
  })
})

describe('finding 6: eligibility re-checked before each request and each proposal write', () => {
  it('a screenshot he decides while it waits in a later chunk is not sent', async () => {
    const shots = Array.from({ length: 32 }, (_, i) => ({ hash: `h${i}`, proposal: 'doubtful' as const, window: `keep-${i}`, takenAt: `2026-10-01T10:${String(59 - i).padStart(2, '0')}:00` }))
    const w = well(shots)
    const stub = lunaStub({ delayMs: 10 })
    let first = true
    const http: typeof stub.http = async (u, init) => {
      if (first) {
        first = false
        decide(w, 'h31', 'excluded') // the oldest: in the third chunk, not yet started
        sql(w, 'UPDATE sorter_proposals SET answered_at = ?, answer = ? WHERE hash = ?', '2026-10-10', 'keep', hashOf('h30'))
      }
      return stub.http(u, init)
    }
    const s = await new CloudSorter(cloudDeps(w, { http })).runNightly()
    expect(sentWindows(stub)).not.toContain('keep-31')
    expect(sentWindows(stub)).not.toContain('keep-30')
    expect(s.asked).toBe(30)
  })

  it('a Triage decision that lands during the request keeps the proposal unchanged', async () => {
    const w = four()
    const stub = lunaStub()
    const http: typeof stub.http = async (u, init) => {
      decide(w, 'd1', 'included')
      return stub.http(u, init)
    }
    const s = await new CloudSorter(cloudDeps(w, { http })).runNightly()
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'doubtful', decided_by: null, reason: 'local reason for d1' })
    expect(s.keep).toBe(0) // not counted as Luna's call
  })
})

describe('finding 7: one claim per screenshot across processes', () => {
  it('two app processes running the nightly batch at once send each screenshot once', async () => {
    const shots = Array.from({ length: 20 }, (_, i) => ({ hash: `p${i}`, proposal: 'doubtful' as const, window: `keep-${i}` }))
    const w = well(shots)
    const stub = lunaStub({ delayMs: 20 })
    const a = new CloudSorter(cloudDeps(w, { http: stub.http }))
    const b = new CloudSorter(cloudDeps(w, { http: stub.http }))
    await Promise.all([a.runNightly(), b.runNightly()])
    const windows = sentWindows(stub)
    expect(windows).toHaveLength(20)
    expect(new Set(windows).size).toBe(20)
  })

  it('claimForCloud: a live claim blocks another run; a stale one does not; the limit holds in the claim', () => {
    const w = four()
    const now = new Date('2026-10-11T01:00:00Z')
    const hs = ['d1', 'd2', 'd3', 'd4'].map(hashOf)
    const st = new SorterStore(w)
    try {
      expect(st.claimForCloud(hs.slice(0, 2), { ...SCOPE, night: 'n', limit: 300, runId: 'A', now }).claimed).toEqual(hs.slice(0, 2))
      expect(st.claimForCloud(hs, { ...SCOPE, night: 'n', limit: 300, runId: 'B', now }).claimed).toEqual(hs.slice(2))
      const later = new Date(now.getTime() + CLAIM_STALE_MS + 1000)
      expect(st.claimForCloud(hs, { ...SCOPE, night: 'n', limit: 5, runId: 'C', now: later }).claimed).toEqual(hs.slice(0, 1)) // 4 of 5 used
      expect(st.allowanceUsed('n')).toBe(5)
      st.releaseClaims('C', 'n', 1)
      expect(st.allowanceUsed('n')).toBe(4)
    } finally {
      st.close()
    }
  })
})

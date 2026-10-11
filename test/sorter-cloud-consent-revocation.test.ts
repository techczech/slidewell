// The cloud step's safety rules, fix round 2 after the second review: consent confirmed by main's own
// dialog, revocation honoured before every request and retry, retries re-checked per item, the
// night's allowance counted only for what went into a request, and a FIFO refused without blocking.
// Synthetic data only (sorter-cloud-fixture.ts).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { constants, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ipc = vi.hoisted(() => new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { CloudSorter, changeSettings, normaliseCloudSettings, registerCloudIpc } = await import('../src/main/sorter/cloud/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { DEFAULT_THRESHOLDS, SORTER_VERSION } = await import('../src/main/sorter/decide')
const { LUNA } = await import('../src/main/sorter/cloud/luna')
const { readVerified } = await import('../src/main/sorter/cloud/images')
const { makeCloudWell, lunaStub, cloudDeps, hashOf } = await import('./sorter-cloud-fixture')
type HttpPost = import('../src/main/sorter/cloud/client').HttpPost
type StoredCloudSettings = import('../src/main/sorter/cloud/service').StoredCloudSettings

const SCOPE = { sorterVersion: SORTER_VERSION, provider: 'openai' as const, model: LUNA.model, promptVersion: LUNA.promptVersion, throwawayAt: DEFAULT_THRESHOLDS.throwaway }

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
const decide = (w: string, name: string): void => {
  const db = new DatabaseSync(join(w, 'triage.db'))
  try {
    db.prepare('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)').run(hashOf(name), 'excluded', '2026-10-10')
  } finally {
    db.close()
  }
}
const claimsLeft = (w: string): number => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM sorter_cloud_claims').get() as { n: number }).n)
  } finally {
    db.close()
  }
}
const allowance = (w: string, night: string): number => {
  const st = new SorterStore(w)
  try {
    return st.allowanceUsed(night)
  } finally {
    st.close()
  }
}
const windowsOf = (body: string): string[] =>
  (JSON.parse(body) as { input: Array<{ content: Array<{ type: string; text?: string }> }> }).input[0].content
    .filter((p) => p.type === 'input_text' && p.text?.startsWith('id: '))
    .map((p) => /window: ([^·]+)/.exec(p.text as string)?.[1].trim() ?? '')
/** A transport that answers 500 the first time, then like Luna; records every body. */
const failOnce = (): { http: HttpPost; bodies: string[] } => {
  const stub = lunaStub()
  const bodies: string[] = []
  return {
    bodies,
    http: async (u, init) => {
      bodies.push(init.body)
      if (bodies.length === 1) return { status: 500, headers: { get: () => null }, text: async () => '{}' }
      return stub.http(u, init)
    }
  }
}

describe('A: consent is confirmed by main', () => {
  it('turning the cloud step on is recorded only after main’s dialog returns OK; the dialog shows count, cost and what is sent', async () => {
    const w = four()
    let stored: StoredCloudSettings = {}
    const save = (s: StoredCloudSettings): void => void (stored = s)
    const now = (): Date => new Date('2026-10-11T09:00:00Z')

    const declined = cloudDeps(w, { confirmAnswer: false })
    await changeSettings(new CloudSorter(declined), { enabled: true, batchTime: '03:00' }, () => stored, save, now)
    expect(normaliseCloudSettings(stored).enabled).toBe(false)
    expect(stored.batchTime).toBe('03:00') // the rest of the change still applies
    expect(declined.prompts).toHaveLength(1)
    const p = declined.prompts[0]
    expect(p).toMatchObject({ kind: 'turn-on', count: 4 })
    expect(p.detail).toMatch(/4 doubtful screenshots are waiting now/)
    expect(p.detail).toMatch(/Estimated cost: (about \$|under \$)/)
    expect(p.detail).toMatch(/OpenAI \(gpt-6-luna\) receives the picture, resized to 1456 pixels/)
    expect(p.detail).toMatch(/app name and window title/)

    const confirmed = cloudDeps(w)
    await changeSettings(new CloudSorter(confirmed), { enabled: true }, () => stored, save, now)
    expect(stored.optedInAt).toBe('2026-10-11T09:00:00.000Z')
    await changeSettings(new CloudSorter(confirmed), { enabled: true }, () => stored, save, now) // already on: no second dialog
    expect(confirmed.prompts).toHaveLength(1)
  })

  it('a Sort now send goes only after main’s dialog returns OK; the nightly run needs only the recorded opt-in', async () => {
    const w = four()
    const stub = lunaStub()
    const declined = cloudDeps(w, { http: stub.http, confirmAnswer: false })
    const svc = new CloudSorter(declined)
    const p = await svc.prepare()
    expect(await svc.send(p.token)).toMatchObject({ skipped: 'not-confirmed', asked: 0 })
    expect(declined.prompts.map((x) => [x.kind, x.count])).toEqual([['send', 4]])
    expect(declined.prompts[0].detail).toMatch(/Estimated cost: .*app name and window title/s)
    expect(stub.seen).toHaveLength(0)
    expect(claimsLeft(w)).toBe(0)

    const ok = cloudDeps(w, { http: stub.http })
    const svc2 = new CloudSorter(ok)
    expect(await svc2.send((await svc2.prepare()).token)).toMatchObject({ trigger: 'manual', asked: 4 })
    expect(ok.prompts).toHaveLength(1)

    const w2 = four()
    const nightly = cloudDeps(w2, { http: lunaStub().http, confirmAnswer: false })
    expect(await new CloudSorter(nightly).runNightly()).toMatchObject({ asked: 4 })
    expect(nightly.prompts).toHaveLength(0)
  })
})

describe('B: revocation stops the run before the next request or retry', () => {
  it('turning asking Luna off mid-batch: no request starts afterwards, the run stops, claims go', async () => {
    const shots = Array.from({ length: 32 }, (_, i) => ({ hash: `h${i}`, proposal: 'doubtful' as const, window: `keep-${i}`, takenAt: `2026-10-01T10:${String(59 - i).padStart(2, '0')}:00` }))
    const w = well(shots)
    const stub = lunaStub({ delayMs: 20 })
    const d = cloudDeps(w)
    const settings = d.settings()
    let afterOff = 0
    d.http = async (u, init) => {
      if (!settings.enabled) afterOff++
      const r = await stub.http(u, init)
      settings.enabled = false // he unticks "Ask Luna" while the first request is out
      return r
    }
    const s = await new CloudSorter(d).runNightly()
    expect(afterOff).toBe(0)
    expect(stub.seen.length).toBeLessThan(3) // 32 items are three requests; the third never went
    expect(s.skipped).toBe('off')
    expect(s.message).toMatch(/asking Luna was turned off/)
    expect(claimsLeft(w)).toBe(0)
  })

  it('removing the key during a retry’s wait: the retry is not made', async () => {
    const w = four()
    const t = failOnce()
    let key: string | null = 'sk-test-FAKEKEY0123456789abcdefWXYZ'
    const d = cloudDeps(w, {
      http: t.http,
      key: { get: () => key, has: () => Boolean(key), encryptionAvailable: () => true },
      sleep: async () => void (key = null)
    })
    const s = await new CloudSorter(d).runNightly()
    expect(t.bodies).toHaveLength(1)
    expect(s.skipped).toBe('no-key')
    expect(claimsLeft(w)).toBe(0)
  })
})

describe('C: a retry re-checks eligibility per item', () => {
  it('an item he decides during the backoff is dropped from the retry', async () => {
    const w = four()
    const t = failOnce()
    const d = cloudDeps(w, { http: t.http, sleep: async () => decide(w, 'd1') })
    await new CloudSorter(d).runNightly()
    expect(t.bodies).toHaveLength(2)
    expect(windowsOf(t.bodies[0])).toContain('keep-chart')
    expect(windowsOf(t.bodies[1]).sort()).toEqual(['blurry', 'toss-wifi', 'weak-picker'])
  })

  it('when none is left, the retry is skipped', async () => {
    const w = four()
    const t = failOnce()
    const d = cloudDeps(w, { http: t.http, sleep: async () => ['d1', 'd2', 'd3', 'd4'].forEach((n) => decide(w, n)) })
    const s = await new CloudSorter(d).runNightly()
    expect(t.bodies).toHaveLength(1)
    expect(s.answered).toBe(0)
    expect(d.logs.join('\n')).toMatch(/retry 1 not made: nothing in it is still waiting for Luna/)
  })
})

describe('D: the allowance counts only what went into a request', () => {
  it('a crash after the claim with zero requests leaves the night’s allowance intact after restart', () => {
    const w = four()
    const now = new Date('2026-10-11T01:00:00Z')
    const before = new SorterStore(w)
    expect(before.claimForCloud([hashOf('d1')], { ...SCOPE, night: 'n', limit: 1, runId: 'crashed', now }).claimed).toEqual([hashOf('d1')])
    before.close() // the process dies here: no request, no release
    const after = new SorterStore(w) // restart
    try {
      expect(after.allowanceUsed('n')).toBe(0)
      expect(after.claimForCloud([hashOf('d2')], { ...SCOPE, night: 'n', limit: 1, runId: 'next', now }).claimed).toEqual([hashOf('d2')])
      expect(after.admitForRequest([hashOf('d2')], { ...SCOPE, runId: 'next', night: 'n', limit: 1 })).toEqual({ admitted: [hashOf('d2')], overLimit: 0 })
      expect(after.allowanceUsed('n')).toBe(1)
    } finally {
      after.close()
    }
  })

  it('a run whose requests all fail before upload uses none of the allowance; a sent one uses it once, retries included', async () => {
    const w = four()
    const now = new Date(2026, 9, 11, 2, 0)
    const none = cloudDeps(w, { now: () => now, shrink: async () => Promise.reject(new Error('cannot shrink')) })
    await new CloudSorter(none).runNightly()
    expect(allowance(w, '2026-10-10')).toBe(0)
    const t = failOnce()
    await new CloudSorter(cloudDeps(w, { http: t.http, now: () => now })).runNightly()
    expect(t.bodies).toHaveLength(2)
    expect(allowance(w, '2026-10-10')).toBe(4)
  })
})

describe('F: a run is bound to the key it started with', () => {
  const OLD = 'sk-test-SYNTHOLD0123456789abcdefWXYZ'
  const NEW = 'sk-proj-SYNTHNEW9876543210zyxwvuQRST'
  const shots32 = (): string =>
    well(Array.from({ length: 32 }, (_, i) => ({ hash: `h${i}`, proposal: 'doubtful' as const, window: `keep-${i}`, takenAt: `2026-10-01T10:${String(59 - i).padStart(2, '0')}:00` })))

  it('replacing the key during a retry’s wait: no further request, the run ends revoked', async () => {
    const w = four()
    const t = failOnce()
    let key: string | null = OLD
    const d = cloudDeps(w, {
      http: t.http,
      key: { get: () => key, has: () => Boolean(key), encryptionAvailable: () => true },
      sleep: async () => void (key = NEW) // removed and a new one saved before the backoff ends
    })
    const s = await new CloudSorter(d).runNightly()
    expect(t.bodies).toHaveLength(1)
    expect(s.skipped).toBe('revoked')
    expect(s.message).toMatch(/the OpenAI key was changed/)
    expect(claimsLeft(w)).toBe(0)
  })

  for (const [channel, after, skipped] of [
    ['cloud:set-key', NEW, 'revoked'],
    ['cloud:clear-key', null, 'no-key']
  ] as const) {
    it(`${channel} while a request is out stops the run at once: no further request, claims go, skipped ${skipped}`, async () => {
      const w = shots32()
      const stub = lunaStub({ delayMs: 20 })
      let key: string | null = OLD
      const d = cloudDeps(w, { key: { get: () => key, has: () => Boolean(key), encryptionAvailable: () => true } })
      const svc = new CloudSorter(d)
      ipc.clear()
      registerCloudIpc(
        svc,
        { openai: { set: (k) => ((key = String(k)), { ok: true, saved: true }), clear: () => void (key = null) }, anthropic: { set: () => ({ ok: false, saved: false }), clear: () => undefined } },
        () => undefined,
        () => ({}),
        () => true
      )
      let calls = 0
      d.http = async (u, init) => {
        calls++
        if (calls === 1) await ipc.get(channel)!({ sender: null }, 'openai', after) // he changes the OpenAI key while the first request is out
        const r = await stub.http(u, init)
        if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }) // as net.fetch does
        return r
      }
      const s = await svc.runNightly()
      expect(calls).toBeLessThanOrEqual(2) // the two already started together (concurrency 2); the third never went
      expect(s.skipped).toBe(skipped)
      expect(s.answered).toBe(0) // the aborted requests' answers are not stored
      expect(claimsLeft(w)).toBe(0)
    })
  }

  it('a reason carrying a key glued to a word is stored redacted, against the run’s key and the current one', async () => {
    const w = four()
    const stub = lunaStub()
    let key: string | null = OLD
    const http: HttpPost = async (url, init) => {
      const res = await stub.http(url, init)
      key = NEW // the stored key changes under the run without the change being signalled
      const text = (await res.text()).split('A chart worth keeping.').join(`echo${NEW} and echosk-proj-SYNTHOTHER0123456789 and x${OLD}`)
      return { status: 200, headers: res.headers, text: async () => text }
    }
    await new CloudSorter(cloudDeps(w, { http, key: { get: () => key, has: () => Boolean(key), encryptionAvailable: () => true } })).runNightly()
    const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
    try {
      const dump = JSON.stringify([db.prepare('SELECT * FROM sorter_cloud_answers').all(), db.prepare('SELECT * FROM sorter_proposals').all()])
      expect(dump).not.toContain('SYNTHNEW')
      expect(dump).not.toContain('SYNTHOTHER')
      expect(dump).not.toContain('SYNTHOLD')
      expect(dump).toContain('echo[key]')
    } finally {
      db.close()
    }
  })
})

describe('E: readVerified never blocks on a FIFO', () => {
  it('a FIFO with no writer is refused promptly as not a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-fifo-'))
    dirs.push(dir)
    const fifo = join(dir, 'CleanShot 2026-10-01 at 10.00.00 from Test App with pipe.png')
    execFileSync('mkfifo', [fifo])
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'blocked'>((r) => (timer = setTimeout(() => r('blocked'), 1500)))
    const result = await Promise.race([readVerified(fifo, 'aaaaaaaaaaaa'), timeout])
    clearTimeout(timer)
    if (result === 'blocked') {
      // free the blocked open() (a writer arrives) so the worker thread does not hang the test run
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
    }
    expect(result).toEqual({ ok: false, why: 'not-a-file' })
  })
})

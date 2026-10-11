// Two providers for the cloud step (ticket 16), the consent rules: opting in to one provider is not
// consent to the other; a prepared batch and a running batch are bound to the provider they started
// with; a key is saved only for the provider the call names. Fake transport only; synthetic data.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const ipc = vi.hoisted(() => new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { CloudSorter, applySettingsPatch, changeSettings, normaliseCloudSettings, registerCloudIpc } = await import('../src/main/sorter/cloud/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { makeCloudWell, bothStubs, cloudDeps, readProposal, ANTHROPIC_URL, OPENAI_URL, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY } = await import('./sorter-cloud-fixture')
type StoredCloudSettings = import('../src/main/sorter/cloud/service').StoredCloudSettings
type CloudSettings = import('../src/main/sorter/cloud/service').CloudSettings
type CloudDeps = import('../src/main/sorter/cloud/service').CloudDeps

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
const many = (n: number): string => well(Array.from({ length: n }, (_, i) => ({ hash: `h${i}`, proposal: 'doubtful' as const, window: `keep-${i}`, takenAt: `2026-10-01T10:${String(59 - i).padStart(2, '0')}:00` })))
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
const T1 = '2026-10-11T09:00:00.000Z'
const T2 = '2026-10-11T10:00:00.000Z'

/**
 * A service whose settings are the stored ones, as in the app: config (the box) → normaliseCloudSettings.
 * `change` is the settings IPC path (changeSettings); `answers` are what main's dialog returns, in order.
 */
function app(w: string, stored: StoredCloudSettings, extra: Parameters<typeof cloudDeps>[1] = {}, answers: boolean[] = []) {
  const box = { stored }
  const d = cloudDeps(w, extra)
  const deps = d as CloudDeps
  deps.settings = (): CloudSettings => normaliseCloudSettings(box.stored)
  deps.confirm = async (p) => {
    d.prompts.push(p)
    return answers.length ? (answers.shift() as boolean) : true
  }
  const svc = new CloudSorter(d)
  let clock = T1
  const change = (patch: unknown): Promise<void> => changeSettings(svc, patch, () => box.stored, (s) => void (box.stored = s), () => new Date(clock))
  return { svc, d, box, change, at: (t: string) => void (clock = t) }
}

describe('consent is per provider', () => {
  it('turning on with Haiku selected asks about Anthropic and records an opt-in to Anthropic only', async () => {
    const w = four()
    const a = app(w, { provider: 'anthropic' })
    await a.change({ enabled: true })
    expect(a.d.prompts).toHaveLength(1)
    expect(a.d.prompts[0]).toMatchObject({ kind: 'turn-on', provider: 'anthropic', count: 4, message: 'Turn on asking Haiku?' })
    expect(a.d.prompts[0].detail).toMatch(/Anthropic \(claude-haiku-5-5\) receives the picture.*app name and window title/s)
    expect(a.box.stored).toEqual({ provider: 'anthropic', optedInAt: null, anthropicOptedInAt: T1, batchTime: '02:00' })
    expect(normaliseCloudSettings(a.box.stored)).toMatchObject({ enabled: true, provider: 'anthropic' })
  })

  it('an opt-in to OpenAI is not an opt-in to Anthropic: choosing Haiku while on raises its own dialog; declined, nothing changes and nothing goes to Anthropic', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1 }, { http: net.http }, [false])
    await a.change({ provider: 'anthropic' })
    expect(a.d.prompts).toHaveLength(1)
    expect(a.d.prompts[0]).toMatchObject({ kind: 'turn-on', provider: 'anthropic', message: 'Ask Haiku instead of Luna?' })
    expect(a.d.prompts[0].detail).toMatch(/the screenshots go to Anthropic instead; this is a separate agreement/)
    expect(a.d.prompts[0].detail).toMatch(/Anthropic \(claude-haiku-5-5\) receives the picture, resized to 1456 pixels on its long edge, with the app name and window title/)
    expect(a.box.stored).toEqual({ provider: 'openai', optedInAt: T1, anthropicOptedInAt: null, batchTime: '02:00' })
    // still Luna, still on: the next run goes to OpenAI and nowhere else
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'openai', asked: 4 })
    expect(new Set(net.urls)).toEqual(new Set([OPENAI_URL]))
  })

  it('confirmed, the switch records Anthropic’s own opt-in with its own time and keeps OpenAI’s; the next run asks Haiku', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1, batchTime: '03:00' }, { http: net.http })
    a.at(T2)
    await a.change({ provider: 'anthropic' })
    expect(a.d.prompts.map((p) => [p.kind, p.provider])).toEqual([['turn-on', 'anthropic']])
    expect(a.box.stored).toEqual({ provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: T2, batchTime: '03:00' })
    expect(await a.svc.runNightly()).toMatchObject({ provider: 'anthropic', asked: 4 })
    expect(new Set(net.urls)).toEqual(new Set([ANTHROPIC_URL]))
    // back to Luna: he agreed to OpenAI before and has not turned it off, so no second dialog
    await a.change({ provider: 'openai' })
    expect(a.d.prompts).toHaveLength(1)
    expect(normaliseCloudSettings(a.box.stored)).toMatchObject({ enabled: true, provider: 'openai' })
  })

  it('while off, a provider can be chosen without a dialog and stays off; turning on then asks for that provider', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, {}, { http: net.http }, [false, true])
    await a.change({ provider: 'anthropic' })
    expect(a.d.prompts).toHaveLength(0)
    expect(normaliseCloudSettings(a.box.stored)).toEqual({ enabled: false, batchTime: '02:00', provider: 'anthropic' })
    expect(await a.svc.runNightly()).toMatchObject({ skipped: 'off', asked: 0 })
    expect(await a.svc.prepare()).toMatchObject({ blocked: 'off', token: null })
    await a.change({ enabled: true }) // declined
    expect(normaliseCloudSettings(a.box.stored).enabled).toBe(false)
    await a.change({ enabled: true }) // confirmed
    expect(a.d.prompts.map((p) => p.provider)).toEqual(['anthropic', 'anthropic'])
    expect(a.box.stored).toMatchObject({ provider: 'anthropic', optedInAt: null, anthropicOptedInAt: T1 })
    expect(net.urls).toEqual([]) // nothing was sent by any of this
  })

  it('one patch that turns on and chooses a provider asks once, for that provider; declined, neither happens but the batch time still applies', async () => {
    const w = four()
    const a = app(w, {}, {}, [false, true])
    await a.change({ enabled: true, provider: 'anthropic', batchTime: '04:30' })
    expect(a.box.stored).toEqual({ provider: 'openai', optedInAt: null, anthropicOptedInAt: null, batchTime: '04:30' })
    await a.change({ enabled: true, provider: 'anthropic' })
    expect(a.d.prompts.map((p) => [p.provider, p.message])).toEqual([
      ['anthropic', 'Turn on asking Haiku?'],
      ['anthropic', 'Turn on asking Haiku?']
    ])
    expect(a.box.stored).toEqual({ provider: 'anthropic', optedInAt: null, anthropicOptedInAt: T1, batchTime: '04:30' })
  })

  it('turning off clears both opt-ins: afterwards either provider needs its dialog again', async () => {
    const w = four()
    const a = app(w, { provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: T1 })
    await a.change({ enabled: false })
    expect(a.box.stored).toEqual({ provider: 'anthropic', optedInAt: null, anthropicOptedInAt: null, batchTime: '02:00' })
    await a.change({ provider: 'openai' })
    expect(normaliseCloudSettings(a.box.stored)).toMatchObject({ enabled: false, provider: 'openai' })
    expect(a.d.prompts).toHaveLength(0)
    await a.change({ enabled: true })
    expect(a.d.prompts.map((p) => p.provider)).toEqual(['openai'])
  })

  it('the stored settings alone can never opt in to a provider by selecting it', () => {
    const now = new Date(T2)
    const onLuna: StoredCloudSettings = { provider: 'openai', optedInAt: T1 }
    // selecting Haiku without enabled: true leaves Anthropic not opted in, so off
    const switched = applySettingsPatch(onLuna, { provider: 'anthropic' }, now)
    expect(switched).toEqual({ provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: null, batchTime: '02:00' })
    expect(normaliseCloudSettings(switched).enabled).toBe(false)
    // enabled: true opts in to the provider the patch leaves selected, and to no other
    expect(applySettingsPatch({}, { provider: 'anthropic', enabled: true }, now)).toMatchObject({ optedInAt: null, anthropicOptedInAt: T2 })
    expect(applySettingsPatch({ provider: 'anthropic' }, { enabled: true }, now)).toMatchObject({ optedInAt: null, anthropicOptedInAt: T2 })
    expect(applySettingsPatch({}, { enabled: true }, now)).toMatchObject({ optedInAt: T2, anthropicOptedInAt: null })
    // an unknown provider, or opt-in times passed in the patch, are not read
    expect(applySettingsPatch(onLuna, { provider: 'google', anthropicOptedInAt: T1, optedIn: { anthropic: T1 } }, now)).toEqual({ provider: 'openai', optedInAt: T1, anthropicOptedInAt: null, batchTime: '02:00' })
    expect(applySettingsPatch({ anthropicOptedInAt: 'yes', provider: 'anthropic' } as never, {}, now).anthropicOptedInAt).toBeNull()
  })

  it('a renderer patch cannot smuggle an opt-in: the dialog decides, and it names the provider the opt-in is recorded for', async () => {
    const w = four()
    const a = app(w, { provider: 'openai', optedInAt: T1 }, {}, [false])
    await a.change({ provider: 'anthropic', enabled: true, anthropicOptedInAt: T1 })
    expect(a.d.prompts.map((p) => p.provider)).toEqual(['anthropic'])
    expect(a.box.stored).toEqual({ provider: 'openai', optedInAt: T1, anthropicOptedInAt: null, batchTime: '02:00' })
  })

  it('if the stored provider changes while the dialog is open, the opt-in still goes to the provider the dialog named', async () => {
    const w = four()
    const a = app(w, { provider: 'openai', optedInAt: T1 })
    const deps = a.d as CloudDeps
    deps.confirm = async (p) => {
      a.d.prompts.push(p)
      a.box.stored = { ...a.box.stored, provider: 'openai', optedInAt: null } // turned off elsewhere meanwhile
      return true
    }
    await a.change({ provider: 'anthropic' })
    expect(a.d.prompts[0].provider).toBe('anthropic')
    expect(a.box.stored).toEqual({ provider: 'anthropic', optedInAt: null, anthropicOptedInAt: T1, batchTime: '02:00' })
  })
})

describe('a prepared batch is bound to the provider it was prepared for', () => {
  it('prepared for Luna, then Haiku is chosen (with its own consent): the old token sends nothing to anyone', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1 }, { http: net.http })
    const p = await a.svc.prepare()
    expect(p).toMatchObject({ provider: 'openai', toSend: 4, blocked: null })
    await a.change({ provider: 'anthropic' }) // confirmed in main's dialog
    expect(normaliseCloudSettings(a.box.stored)).toMatchObject({ enabled: true, provider: 'anthropic' })
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(net.urls).toEqual([])
    expect(a.d.prompts.map((x) => x.kind)).toEqual(['turn-on']) // no send dialog was even raised
    expect(claimsLeft(w)).toBe(0)
    expect(allowance(w, '2026-10-10')).toBe(0)
    // and it stays unusable after switching back
    await a.change({ provider: 'openai' })
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(net.urls).toEqual([])
  })

  it('switching away and back between prepare and send still invalidates the batch', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1, anthropicOptedInAt: T1 }, { http: net.http })
    const p = await a.svc.prepare()
    await a.change({ provider: 'anthropic' })
    await a.change({ provider: 'openai' }) // Luna is selected again, as when the batch was prepared
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(net.urls).toEqual([])
    expect(a.d.prompts).toHaveLength(0)
    // a fresh prepare gives a fresh token that works
    const again = await a.svc.prepare()
    expect(again.token).not.toBe(p.token)
    expect(await a.svc.send(again.token)).toMatchObject({ provider: 'openai', asked: 4 })
  })

  it('the send itself checks the provider, even when the change was not signalled to the service', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1, anthropicOptedInAt: T1 }, { http: net.http })
    const p = await a.svc.prepare()
    a.box.stored = { ...a.box.stored, provider: 'anthropic' } // config changed underneath; providerChanged() was never called
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    expect(s.message).toMatch(/prepared for Luna, and another provider is selected now/)
    expect(net.urls).toEqual([])
    expect(a.d.prompts).toHaveLength(0)
    a.box.stored = { ...a.box.stored, provider: 'openai' }
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared' }) // the token was used up by the refusal
    expect(net.urls).toEqual([])
  })

  it('a provider change while main’s send dialog is open: the confirmation does not carry over, nothing is sent', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1, anthropicOptedInAt: T1 }, { http: net.http })
    const deps = a.d as CloudDeps
    const p = await a.svc.prepare()
    deps.confirm = async (prompt) => {
      a.d.prompts.push(prompt)
      a.box.stored = { ...a.box.stored, provider: 'anthropic' } // chosen while the dialog that names OpenAI is open
      return true
    }
    const s = await a.svc.send(p.token)
    expect(a.d.prompts.map((x) => [x.kind, x.provider])).toEqual([['send', 'openai']])
    expect(s).toMatchObject({ provider: 'openai', skipped: 'provider-changed', asked: 0 })
    expect(net.urls).toEqual([])
    expect(claimsLeft(w)).toBe(0)
  })

  it('switching away and back while main’s send dialog is open: the confirmation no longer counts, nothing is sent and none of tonight’s allowance is used', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1, anthropicOptedInAt: T1 }, { http: net.http })
    const deps = a.d as CloudDeps
    const p = await a.svc.prepare()
    deps.confirm = async (prompt) => {
      a.d.prompts.push(prompt)
      await a.change({ provider: 'anthropic' }) // through Settings, while the dialog that names OpenAI is open
      await a.change({ provider: 'openai' }) // and back: Luna is selected again when he confirms
      return true
    }
    const s = await a.svc.send(p.token)
    expect(normaliseCloudSettings(a.box.stored)).toMatchObject({ enabled: true, provider: 'openai' })
    expect(a.d.prompts.map((x) => [x.kind, x.provider])).toEqual([['send', 'openai']])
    expect(s).toMatchObject({ provider: 'openai', skipped: 'provider-changed', asked: 0, answered: 0 })
    expect(net.urls).toEqual([])
    expect(claimsLeft(w)).toBe(0)
    expect(allowance(w, '2026-10-10')).toBe(0)
    expect(a.svc.busy()).toBe(false)
    // the old token is used up; a fresh prepare and an undisturbed dialog send as usual
    expect(await a.svc.send(p.token)).toMatchObject({ skipped: 'not-prepared', asked: 0 })
    deps.confirm = async () => true
    const again = await a.svc.prepare()
    expect(await a.svc.send(again.token)).toMatchObject({ provider: 'openai', asked: 4 })
    expect(new Set(net.urls)).toEqual(new Set([OPENAI_URL]))
  })

  it('the key removed and the same key saved again while main’s send dialog is open: nothing is sent', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1 }, { http: net.http })
    const deps = a.d as CloudDeps
    const p = await a.svc.prepare()
    deps.confirm = async () => {
      a.svc.keyChanged('anthropic', 'saved') // the other provider's key does not concern this send
      a.svc.keyChanged('openai', 'cleared') // what the key IPC signals; the fake store still returns the same key afterwards
      a.svc.keyChanged('openai', 'saved')
      return true
    }
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ provider: 'openai', skipped: 'revoked', asked: 0 })
    expect(net.urls).toEqual([])
    expect(claimsLeft(w)).toBe(0)
    expect(allowance(w, '2026-10-10')).toBe(0)
  })

  it('a change to the other provider’s key while main’s send dialog is open does not stop the send', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'openai', optedInAt: T1 }, { http: net.http })
    const deps = a.d as CloudDeps
    const p = await a.svc.prepare()
    deps.confirm = async () => {
      a.svc.keyChanged('anthropic', 'saved')
      return true
    }
    expect(await a.svc.send(p.token)).toMatchObject({ provider: 'openai', asked: 4 })
    expect(new Set(net.urls)).toEqual(new Set([OPENAI_URL]))
  })

  it('a batch prepared for Haiku and sent with Haiku still selected goes to Anthropic, after main’s dialog names Anthropic', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'anthropic', anthropicOptedInAt: T1 }, { http: net.http })
    const p = await a.svc.prepare()
    const s = await a.svc.send(p.token)
    expect(s).toMatchObject({ trigger: 'manual', provider: 'anthropic', asked: 4, answered: 4 })
    expect(a.d.prompts.map((x) => [x.kind, x.provider, x.message])).toEqual([['send', 'anthropic', 'Send 4 screenshots to Haiku?']])
    expect(new Set(net.urls)).toEqual(new Set([ANTHROPIC_URL]))
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'keep', decided_by: 'haiku', decided_model: 'claude-haiku-5-5' })
  })
})

describe('a running batch is bound to the provider it started with', () => {
  it('the provider is changed while the first request is out: no request goes to the new provider, none further to the old, claims go', async () => {
    const w = many(32)
    const net = bothStubs({ delayMs: 20 })
    const a = app(w, { provider: 'openai', optedInAt: T1, anthropicOptedInAt: T1 })
    const deps = a.d as CloudDeps
    let calls = 0
    deps.http = async (u, init) => {
      calls++
      if (calls === 1) await a.change({ provider: 'anthropic' }) // already opted in to both: no dialog, takes effect at once
      const r = await net.http(u, init)
      if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }) // as net.fetch does
      return r
    }
    const s = await a.svc.runNightly()
    expect(s).toMatchObject({ provider: 'openai', skipped: 'provider-changed', answered: 0 })
    expect(s.message).toMatch(/another provider was selected in Settings\. Nothing more goes to OpenAI from this run/)
    expect(calls).toBeLessThanOrEqual(2) // the two already started together; the third never went
    expect(net.urls.every((u) => u === OPENAI_URL)).toBe(true)
    expect(net.haiku.seen).toHaveLength(0)
    expect(claimsLeft(w)).toBe(0)
  })

  it('the stored provider changes during a retry’s wait, unsignalled: the retry is not made', async () => {
    const w = four()
    const net = bothStubs()
    const a = app(w, { provider: 'anthropic', optedInAt: T1, anthropicOptedInAt: T1 })
    const deps = a.d as CloudDeps
    const urls: string[] = []
    deps.http = async (u, init) => {
      urls.push(u)
      if (urls.length === 1) return { status: 500, headers: { get: () => null }, text: async () => '{}' }
      return net.http(u, init)
    }
    deps.sleep = async () => void (a.box.stored = { ...a.box.stored, provider: 'openai' })
    const s = await a.svc.runNightly()
    expect(urls).toEqual([ANTHROPIC_URL])
    expect(s).toMatchObject({ provider: 'anthropic', skipped: 'provider-changed' })
    expect(claimsLeft(w)).toBe(0)
  })

  it('saving or removing the other provider’s key does not stop a run; this provider’s key does', async () => {
    for (const [changed, expected] of [
      ['anthropic', null],
      ['openai', 'revoked']
    ] as const) {
      const w = many(32)
      const net = bothStubs({ delayMs: 10 })
      const d = cloudDeps(w)
      const svc = new CloudSorter(d)
      let calls = 0
      d.http = async (u, init) => {
        calls++
        if (calls === 1) svc.keyChanged(changed, 'saved')
        const r = await net.http(u, init)
        if (init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        return r
      }
      const s = await svc.runNightly()
      expect(s.skipped).toBe(expected)
      if (!expected) expect(s).toMatchObject({ asked: 32, answered: 32 })
      else expect(calls).toBeLessThanOrEqual(2)
    }
  })
})

describe('the key IPC names its provider', () => {
  const setUp = (w: string) => {
    const saved: Record<'openai' | 'anthropic', string | null> = { openai: null, anthropic: null }
    const d = cloudDeps(w, {
      key: { get: () => saved.openai, has: () => Boolean(saved.openai), encryptionAvailable: () => true },
      anthropicKey: { get: () => saved.anthropic, has: () => Boolean(saved.anthropic), encryptionAvailable: () => true }
    })
    const svc = new CloudSorter(d)
    ipc.clear()
    const store = (id: 'openai' | 'anthropic') => ({ set: (k: unknown) => ((saved[id] = String(k)), { ok: true, saved: true }), clear: () => void (saved[id] = null) })
    registerCloudIpc(svc, { openai: store('openai'), anthropic: store('anthropic') }, () => undefined, () => ({}), () => true)
    const call = (channel: string, ...args: unknown[]): Promise<any> => Promise.resolve(ipc.get(channel)!({ sender: null }, ...args)) // eslint-disable-line @typescript-eslint/no-explicit-any
    return { saved, call }
  }

  it('a key is saved and removed for the named provider only; switching provider keeps both keys', async () => {
    const { saved, call } = setUp(four())
    expect(await call('cloud:set-key', 'anthropic', FAKE_ANTHROPIC_KEY)).toMatchObject({ ok: true, saved: true })
    expect(saved).toEqual({ openai: null, anthropic: FAKE_ANTHROPIC_KEY })
    await call('cloud:set-key', 'openai', FAKE_OPENAI_KEY)
    expect(saved).toEqual({ openai: FAKE_OPENAI_KEY, anthropic: FAKE_ANTHROPIC_KEY })
    await call('cloud:set-settings', { provider: 'anthropic' })
    await call('cloud:set-settings', { provider: 'openai' })
    expect(saved).toEqual({ openai: FAKE_OPENAI_KEY, anthropic: FAKE_ANTHROPIC_KEY })
    await call('cloud:clear-key', 'openai')
    expect(saved).toEqual({ openai: null, anthropic: FAKE_ANTHROPIC_KEY })
  })

  it('without a provider, or with an unknown one, no key is saved or removed anywhere', async () => {
    const { saved, call } = setUp(four())
    await call('cloud:set-key', 'anthropic', FAKE_ANTHROPIC_KEY)
    for (const bad of [undefined, null, '', 'google', FAKE_OPENAI_KEY, { id: 'openai' }]) {
      expect(await call('cloud:set-key', bad, FAKE_OPENAI_KEY)).toMatchObject({ ok: false, saved: false })
      await call('cloud:clear-key', bad)
    }
    expect(await call('cloud:set-key', FAKE_OPENAI_KEY)).toMatchObject({ ok: false, saved: false }) // the old one-argument call
    expect(saved).toEqual({ openai: null, anthropic: FAKE_ANTHROPIC_KEY })
  })

  it('nothing the IPC returns carries a key', async () => {
    const { call } = setUp(four())
    const out = [
      await call('cloud:set-key', 'anthropic', FAKE_ANTHROPIC_KEY),
      await call('cloud:set-key', 'openai', FAKE_OPENAI_KEY),
      await call('cloud:status'),
      await call('cloud:set-settings', { provider: 'anthropic' }),
      await call('cloud:prepare'),
      await call('cloud:clear-key', 'openai')
    ]
    expect(JSON.stringify(out)).not.toMatch(/sk-|FAKEKEY/)
    expect(out[2].providers.map((p: { id: string; hasKey: boolean }) => [p.id, p.hasKey])).toEqual([
      ['openai', true],
      ['anthropic', true]
    ])
  })
})

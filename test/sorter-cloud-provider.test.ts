// Two providers for the cloud step (ticket 16): which one is asked, what each run sends where and
// with which key, what is recorded with each decision, and the one nightly allowance both share.
// Fake transport only (sorter-cloud-fixture.ts): each stub answers at its own provider's address and
// any other address fails the test. Synthetic data, made-up keys.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { CloudSorter, NIGHTLY_LIMIT, normaliseCloudSettings, sendPrompt, turnOnPrompt } = await import('../src/main/sorter/cloud/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { DEFAULT_PROVIDER, HAIKU_PROVIDER, LUNA_PROVIDER, PROVIDERS, answerScopes, isProviderId, providerOf, voiceOfAnswer } = await import('../src/main/sorter/cloud/provider')
const { makeCloudWell, readProposal, bothStubs, cloudDeps, hashOf, ANTHROPIC_URL, OPENAI_URL, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY } = await import('./sorter-cloud-fixture')

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
const rows = <T>(w: string, q: string): T[] => {
  const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
  try {
    return db.prepare(q).all() as T[]
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
const useAllowance = (w: string, night: string, sent: number): void => {
  new SorterStore(w).close() // creates the tables
  const db = new DatabaseSync(join(w, 'triage.db'))
  db.prepare('INSERT INTO sorter_cloud_allowance (night, sent) VALUES (?, ?) ON CONFLICT(night) DO UPDATE SET sent = excluded.sent').run(night, sent)
  db.close()
}

describe('provider selection', () => {
  it('there are two providers; OpenAI’s Luna is the default and anything unknown is not a provider', () => {
    expect(DEFAULT_PROVIDER).toBe('openai')
    expect(Object.keys(PROVIDERS)).toEqual(['openai', 'anthropic'])
    expect(providerOf('openai')).toBe(LUNA_PROVIDER)
    expect(providerOf('anthropic')).toBe(HAIKU_PROVIDER)
    for (const x of [undefined, null, '', 'Anthropic', 'haiku', 'google', 7, {}, '__proto__', 'constructor']) {
      expect(isProviderId(x)).toBe(false)
      expect(providerOf(x)).toBe(LUNA_PROVIDER)
    }
    expect(LUNA_PROVIDER).toMatchObject({ company: 'OpenAI', name: 'Luna', model: 'gpt-6-luna', endpoint: OPENAI_URL, decidedBy: 'luna' })
    expect(HAIKU_PROVIDER).toMatchObject({ company: 'Anthropic', name: 'Haiku', model: 'claude-haiku-5-5', endpoint: ANTHROPIC_URL, decidedBy: 'haiku' })
  })

  it('stored settings without a provider, or with an unknown one, mean OpenAI; the opt-in read is the selected provider’s own', () => {
    const at = '2026-10-11T09:00:00.000Z'
    expect(normaliseCloudSettings({ optedInAt: at })).toEqual({ enabled: true, batchTime: '02:00', provider: 'openai' })
    expect(normaliseCloudSettings({ optedInAt: at, provider: 'google' } as never)).toMatchObject({ enabled: true, provider: 'openai' })
    // opted in to OpenAI only: selecting Anthropic is off
    expect(normaliseCloudSettings({ optedInAt: at, provider: 'anthropic' })).toMatchObject({ enabled: false, provider: 'anthropic' })
    expect(normaliseCloudSettings({ anthropicOptedInAt: at, provider: 'anthropic' })).toMatchObject({ enabled: true, provider: 'anthropic' })
    // opted in to Anthropic only: selecting OpenAI is off
    expect(normaliseCloudSettings({ anthropicOptedInAt: at, provider: 'openai' })).toMatchObject({ enabled: false, provider: 'openai' })
    expect(normaliseCloudSettings({ anthropicOptedInAt: 'yes', provider: 'anthropic' })).toMatchObject({ enabled: false })
  })

  it('status names the selected provider and says, for each, only whether a key is saved', () => {
    const w = four()
    const luna = new CloudSorter(cloudDeps(w, { anthropicKeyValue: null })).status()
    expect(luna).toMatchObject({ model: 'gpt-6-luna', name: 'Luna', company: 'OpenAI', hasKey: true, longEdge: 1456, nightlyLimit: 300 })
    expect(luna.providers).toEqual([
      { id: 'openai', name: 'Luna', company: 'OpenAI', model: 'gpt-6-luna', hasKey: true },
      { id: 'anthropic', name: 'Haiku', company: 'Anthropic', model: 'claude-haiku-5-5', hasKey: false }
    ])
    const haiku = new CloudSorter(cloudDeps(w, { anthropicKeyValue: null, settings: { provider: 'anthropic' } })).status()
    expect(haiku).toMatchObject({ model: 'claude-haiku-5-5', name: 'Haiku', company: 'Anthropic', hasKey: false })
    expect(JSON.stringify([luna, haiku])).not.toMatch(/sk-/)
  })
})

describe('a run asks the selected provider, at its address, with its key', () => {
  it('Luna (the default): only OpenAI is called, with the OpenAI key as a Bearer token', async () => {
    const w = four()
    const net = bothStubs()
    const s = await new CloudSorter(cloudDeps(w, { http: net.http })).runNightly()
    expect(s).toMatchObject({ provider: 'openai', asked: 4, answered: 4, keep: 1, throwaway: 1 })
    expect(new Set(net.urls)).toEqual(new Set([OPENAI_URL]))
    expect(net.haiku.seen).toHaveLength(0)
    expect(net.luna.seen[0].headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_OPENAI_KEY}` })
    expect(JSON.stringify(net.luna.seen)).not.toContain('sk-ant')
    expect(s.message).toBe('Asked Luna about 4 screenshots: 1 keep, 1 throwaway. 2 screenshots still need a look.')
  })

  it('Haiku: only Anthropic is called, with the Anthropic key in x-api-key; the OpenAI key goes nowhere', async () => {
    const w = four()
    const net = bothStubs()
    const d = cloudDeps(w, { http: net.http, settings: { provider: 'anthropic' } })
    const s = await new CloudSorter(d).runNightly()
    expect(s).toMatchObject({ provider: 'anthropic', asked: 4, answered: 4, keep: 1, throwaway: 1, stayedDoubtful: 2, skipped: null, error: null })
    expect(new Set(net.urls)).toEqual(new Set([ANTHROPIC_URL]))
    expect(net.luna.seen).toHaveLength(0)
    expect(net.haiku.seen).toHaveLength(1)
    expect(net.haiku.seen[0].headers).toEqual({ 'Content-Type': 'application/json', 'x-api-key': FAKE_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' })
    expect(JSON.stringify(net.haiku.seen)).not.toContain(FAKE_OPENAI_KEY)
    expect(net.haiku.seen[0].body).not.toContain(FAKE_ANTHROPIC_KEY)
    expect(net.haiku.seen[0].windows.sort()).toEqual(['blurry', 'keep-chart', 'toss-wifi', 'weak-picker'])
    expect(net.haiku.seen[0].images).toBe(4)
    expect(s.message).toBe('Asked Haiku about 4 screenshots: 1 keep, 1 throwaway. 2 screenshots still need a look.')
    expect(d.logs.join('\n')).toMatch(/nightly run \(Haiku\): asked 4/)
  })

  it('no Anthropic key: a Haiku run is skipped even though an OpenAI key is saved (no fallback to the other key or provider)', async () => {
    const w = four()
    const net = bothStubs()
    const s = await new CloudSorter(cloudDeps(w, { http: net.http, anthropicKeyValue: null, settings: { provider: 'anthropic' } })).runNightly()
    expect(s).toMatchObject({ provider: 'anthropic', skipped: 'no-key', asked: 0, stayedDoubtful: 4 })
    expect(s.message).toBe('Haiku was not asked: no Anthropic key is saved. 4 screenshots still need a look.')
    expect(net.urls).toEqual([])
  })

  it('Haiku’s answer goes through the same keep-bias: a 0.7 throwaway and an unsure stay doubtful, in Haiku’s name', async () => {
    const w = four()
    await new CloudSorter(cloudDeps(w, { settings: { provider: 'anthropic' } })).runNightly()
    expect(readProposal(w, 'd1')).toMatchObject({ proposal: 'keep', reason: 'A chart worth keeping' })
    expect(readProposal(w, 'd2')).toMatchObject({ proposal: 'throwaway' })
    expect(readProposal(w, 'd2')?.throwaway_since).not.toBeNull()
    expect(readProposal(w, 'd3')).toMatchObject({ proposal: 'doubtful', reason: 'Not sure: Haiku leans throwaway (70%), not sure enough to throw away: probably a file picker' })
    expect(readProposal(w, 'd4')).toMatchObject({ proposal: 'doubtful', reason: 'Not sure, and Haiku was not sure either: hard to tell' })
  })

  it('an answer Haiku gives in any other form is no decision: everything stays doubtful and local', async () => {
    const w = four()
    const replies = [
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: '{"items":[{"id":"s1","verdict":"throwaway","confidence":0.99,"reason":"x"}]}' }], stop_reason: 'end_turn' },
      { type: 'message', role: 'assistant', content: [], stop_reason: 'refusal' },
      { type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'screenshot_verdicts', input: { items: [{ id: 's1', verdict: 'throwaway', confidence: 99, reason: 'x' }] } }], stop_reason: 'tool_use' }
    ]
    for (const reply of replies) {
      const http = async (): Promise<{ status: number; headers: { get: () => null }; text: () => Promise<string> }> => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(reply) })
      const s = await new CloudSorter(cloudDeps(w, { http, settings: { provider: 'anthropic' } })).runNightly()
      expect(s).toMatchObject({ answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 4 })
      for (const h of ['d1', 'd2', 'd3', 'd4']) expect(readProposal(w, h)).toMatchObject({ proposal: 'doubtful', decided_by: null, decided_model: null, reason: `local reason for ${h}` })
    }
    expect(rows(w, 'SELECT * FROM sorter_cloud_answers')).toEqual([])
  })
})

describe('decided_by records the provider’s model for each item', () => {
  it('a Luna decision is recorded as luna with gpt-6-luna; a Haiku decision as haiku with claude-haiku-5-5', async () => {
    const wl = four()
    await new CloudSorter(cloudDeps(wl)).runNightly()
    for (const h of ['d1', 'd2', 'd3', 'd4']) expect(readProposal(wl, h)).toMatchObject({ decided_by: 'luna', decided_model: 'gpt-6-luna' })
    expect(rows<{ model: string; prompt_version: string }>(wl, 'SELECT DISTINCT model, prompt_version FROM sorter_cloud_answers')).toEqual([{ model: 'gpt-6-luna', prompt_version: 'luna-prompt-1' }])

    const wh = four()
    await new CloudSorter(cloudDeps(wh, { settings: { provider: 'anthropic' } })).runNightly()
    for (const h of ['d1', 'd2', 'd3', 'd4']) expect(readProposal(wh, h)).toMatchObject({ decided_by: 'haiku', decided_model: 'claude-haiku-5-5' })
    expect(rows<{ model: string; prompt_version: string }>(wh, 'SELECT DISTINCT model, prompt_version FROM sorter_cloud_answers')).toEqual([{ model: 'claude-haiku-5-5', prompt_version: 'haiku-prompt-1' }])
  })

  it('a local proposal carries no model; an older database gains the column', () => {
    const w = well([
      { hash: 'k1', proposal: 'keep', window: 'keep-local' },
      { hash: 'd1', proposal: 'doubtful', window: 'one' }
    ])
    expect(readProposal(w, 'k1')).toMatchObject({ decided_by: 'history', decided_model: null })
    expect(readProposal(w, 'd1')).toMatchObject({ decided_by: null, decided_model: null })
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.exec('ALTER TABLE sorter_proposals DROP COLUMN decided_model') // as written before ticket 16
    db.close()
    new SorterStore(w).close()
    expect(readProposal(w, 'k1')).toMatchObject({ proposal: 'keep', decided_by: 'history', decided_model: null })
  })

  it('a stored answer belongs to the provider whose current model and prompt it was given under, or to none', () => {
    expect(answerScopes()).toEqual([
      { model: 'gpt-6-luna', promptVersion: 'luna-prompt-1' },
      { model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }
    ])
    expect(voiceOfAnswer('gpt-6-luna', 'luna-prompt-1')).toBe(LUNA_PROVIDER)
    expect(voiceOfAnswer('claude-haiku-5-5', 'haiku-prompt-1')).toBe(HAIKU_PROVIDER)
    expect(voiceOfAnswer('claude-haiku-5-5', 'luna-prompt-1')).toBeNull()
    expect(voiceOfAnswer('some-older-model', 'haiku-prompt-1')).toBeNull()
  })
})

describe('one nightly allowance, shared by both providers', () => {
  const night = '2026-10-10'
  const now = (): Date => new Date(2026, 9, 11, 2, 0)

  it('what Luna used tonight is gone for Haiku: 300 in all, not 300 each', async () => {
    const w = four()
    useAllowance(w, night, NIGHTLY_LIMIT - 1)
    const net = bothStubs()
    // Luna takes the one that is left tonight
    const lunaDeps = cloudDeps(w, { http: net.http, now })
    expect(await new CloudSorter(lunaDeps).runNightly()).toMatchObject({ provider: 'openai', asked: 1 })
    expect(allowance(w, night)).toBe(NIGHTLY_LIMIT)
    // the same night, Haiku: nothing is left
    const haikuDeps = cloudDeps(w, { http: net.http, now, settings: { provider: 'anthropic' } })
    const svc = new CloudSorter(haikuDeps)
    expect(await svc.runNightly()).toMatchObject({ provider: 'anthropic', skipped: 'limit-reached', asked: 0 })
    expect(await svc.prepare()).toMatchObject({ blocked: 'limit-reached', toSend: 0, leftTonight: 0, token: null })
    expect(net.haiku.seen).toHaveLength(0)
    expect(allowance(w, night)).toBe(NIGHTLY_LIMIT)
  })

  it('a night split between the two never exceeds the limit, and both count in the same row', async () => {
    const shots = Array.from({ length: 6 }, (_, i) => ({ hash: `h${i}`, proposal: 'doubtful' as const, window: `blurry-${i}`, takenAt: `2026-10-01T10:0${9 - i}:00` }))
    const w = well(shots)
    useAllowance(w, night, NIGHTLY_LIMIT - 5)
    const net = bothStubs()
    // Sort now with Haiku is offered the five that are left, and sends them
    const haiku = new CloudSorter(cloudDeps(w, { http: net.http, now, settings: { provider: 'anthropic' } }))
    const p = await haiku.prepare()
    expect(p).toMatchObject({ provider: 'anthropic', doubtful: 6, toSend: 5, leftTonight: 5 })
    expect(await haiku.send(p.token)).toMatchObject({ asked: 5 })
    expect(allowance(w, night)).toBe(NIGHTLY_LIMIT)
    // Luna, the same night, for the one Haiku did not get: refused by the shared limit
    const luna = new CloudSorter(cloudDeps(w, { http: net.http, now }))
    expect(await luna.runNightly()).toMatchObject({ provider: 'openai', skipped: 'limit-reached', asked: 0 })
    expect(net.luna.seen).toHaveLength(0)
    expect(net.haiku.seen.reduce((n, r) => n + r.images, 0)).toBe(5)
    expect(rows(w, 'SELECT night, sent FROM sorter_cloud_allowance')).toEqual([{ night, sent: NIGHTLY_LIMIT }])
    // the next night has a fresh allowance, whichever provider asks
    const tomorrow = (): Date => new Date(2026, 9, 12, 2, 0)
    expect(await new CloudSorter(cloudDeps(w, { http: net.http, now: tomorrow })).runNightly()).toMatchObject({ provider: 'openai', asked: 1 })
  })

  it('the allowance table has no provider in it', () => {
    const w = four()
    new SorterStore(w).close()
    expect(rows<{ name: string }>(w, "SELECT name FROM pragma_table_info('sorter_cloud_allowance')").map((c) => c.name)).toEqual(['night', 'sent'])
  })
})

describe('a screenshot one provider has answered is not sent to the other', () => {
  it('after a Luna run, a Haiku run finds nothing waiting; and the other way round', async () => {
    for (const [first, second] of [
      ['openai', 'anthropic'],
      ['anthropic', 'openai']
    ] as const) {
      const w = four()
      const net = bothStubs()
      expect(await new CloudSorter(cloudDeps(w, { http: net.http, settings: { provider: first } })).runNightly()).toMatchObject({ asked: 4 })
      const before = net.urls.length
      const svc = new CloudSorter(cloudDeps(w, { http: net.http, settings: { provider: second } }))
      expect(await svc.runNightly()).toMatchObject({ provider: second, skipped: 'nothing-doubtful', asked: 0 })
      expect(await svc.prepare()).toMatchObject({ blocked: 'nothing-doubtful', doubtful: 0 })
      expect(net.urls.length).toBe(before)
      // the two it left doubtful keep the first provider's name
      expect(readProposal(w, 'd4')?.decided_by).toBe(first === 'openai' ? 'luna' : 'haiku')
    }
  })

  it('claims and the eligibility test in the store count the other provider’s answers', () => {
    const w = four()
    const st = new SorterStore(w)
    try {
      const luna = { sorterVersion: SORTER_VERSION, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', others: [{ model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1' }] }
      st.saveCloudResults([{ hash: hashOf('d1'), verdict: 'unsure', confidence: 0.5, reason: 'x', model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1', askedAt: '2026-10-11T00:00:00Z' }], [])
      st.saveCloudResults([{ hash: hashOf('d2'), verdict: 'unsure', confidence: 0.5, reason: 'x', model: 'claude-haiku-4', promptVersion: 'haiku-prompt-0', askedAt: '2026-10-11T00:00:00Z' }], [])
      const pending = st.cloudPending(luna.sorterVersion, luna.model, luna.promptVersion, luna.others).map((p) => p.hash)
      expect(pending).not.toContain(hashOf('d1')) // answered by Haiku under its current model and prompt
      expect(pending).toContain(hashOf('d2')) // an answer under an older model or prompt does not count
      const claimed = st.claimForCloud([hashOf('d1'), hashOf('d2')], { ...luna, night: 'n', limit: 10, runId: 'r', now: new Date('2026-10-11T01:00:00Z') }).claimed
      expect(claimed).toEqual([hashOf('d2')])
      expect(st.admitForRequest([hashOf('d1'), hashOf('d2')], { ...luna, runId: 'r', night: 'n', limit: 10 })).toEqual({ admitted: [hashOf('d2')], overLimit: 0 })
    } finally {
      st.close()
    }
  })
})

describe('the dialogs name the company that receives the pictures', () => {
  it('Luna’s dialogs are worded as before', () => {
    const on = turnOnPrompt(4, 300)
    expect(on).toMatchObject({ kind: 'turn-on', provider: 'openai', count: 4, message: 'Turn on asking Luna?', confirmLabel: 'Turn on' })
    expect(on.detail).toMatch(/^4 doubtful screenshots are waiting now; 4 screenshots would go at the next sort\. Estimated cost: /)
    expect(on.detail).toMatch(/OpenAI \(gpt-6-luna\) receives the picture, resized to 1456 pixels on its long edge, with the app name and window title/)
    expect(on.detail).not.toMatch(/Anthropic|credits|list price/)
    const send = sendPrompt(4)
    expect(send).toMatchObject({ kind: 'send', provider: 'openai', message: 'Send 4 screenshots to Luna?', confirmLabel: 'Send 4' })
    expect(send.detail).toMatch(/will go to OpenAI in 1 request\. Estimated cost: /)
  })

  it('Haiku’s dialogs name Anthropic, say what is sent, show the list-price estimate and mention the free credits', () => {
    const on = turnOnPrompt(4, 300, HAIKU_PROVIDER)
    expect(on).toMatchObject({ kind: 'turn-on', provider: 'anthropic', count: 4, message: 'Turn on asking Haiku?' })
    expect(on.detail).toMatch(/Anthropic \(claude-haiku-5-5\) receives the picture, resized to 1456 pixels on its long edge, with the app name and window title from its file name/)
    expect(on.detail).toMatch(/Estimated cost at list price: (about \$|under \$)/)
    expect(on.detail).toMatch(/At most 300 screenshots a night \((about \$|under \$)[^)]*\)\. The calls draw on the free monthly Anthropic API credits where they are available/)
    expect(on.detail).not.toMatch(/OpenAI|Luna/)
    const send = sendPrompt(4, HAIKU_PROVIDER)
    expect(send).toMatchObject({ kind: 'send', provider: 'anthropic', message: 'Send 4 screenshots to Haiku?' })
    expect(send.detail).toMatch(/will go to Anthropic in 1 request\. Estimated cost at list price: .*free monthly Anthropic API credits.*Anthropic \(claude-haiku-5-5\) receives the picture.*app name and window title/s)
    expect(send.detail).not.toMatch(/OpenAI|Luna/)
    expect(send.estimate).toEqual(HAIKU_PROVIDER.estimateCost(4))
  })

  it('changing provider while on says which company it was and which it will be', () => {
    const p = turnOnPrompt(4, 300, HAIKU_PROVIDER, LUNA_PROVIDER)
    expect(p).toMatchObject({ kind: 'turn-on', provider: 'anthropic', message: 'Ask Haiku instead of Luna?', confirmLabel: 'Ask Haiku' })
    expect(p.detail).toMatch(/^Until now OpenAI’s Luna was asked\. From now on the screenshots go to Anthropic instead; this is a separate agreement\./)
    expect(p.detail).toMatch(/Anthropic \(claude-haiku-5-5\) receives the picture/)
  })

  it('the Sort now preview carries the provider, its estimate and its cost wording', async () => {
    const w = four()
    const luna = await new CloudSorter(cloudDeps(w)).prepare()
    expect(luna).toMatchObject({ provider: 'openai', toSend: 4, costLabel: 'Estimated cost', costNote: '', message: 'Ask Luna about 4 screenshots?' })
    const haiku = await new CloudSorter(cloudDeps(w, { settings: { provider: 'anthropic' } })).prepare()
    expect(haiku).toMatchObject({ provider: 'anthropic', toSend: 4, costLabel: 'Estimated cost at list price', message: 'Ask Haiku about 4 screenshots?' })
    expect(haiku.costNote).toMatch(/free monthly Anthropic API credits/)
    expect(haiku.estimate).toEqual(HAIKU_PROVIDER.estimateCost(4))
  })
})

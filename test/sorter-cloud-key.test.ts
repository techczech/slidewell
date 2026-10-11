import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { ApiKeyStore, checkKeyShape } = await import('../src/main/sorter/cloud/key-store')
const { CloudSorter } = await import('../src/main/sorter/cloud/service')
const { makeCloudWell, cloudDeps } = await import('./sorter-cloud-fixture')

// a made-up key; it must never appear in config.json, a log line or a run summary
const FAKE_KEY = 'sk-test-LEAKCHECK-0123456789abcdefghijklmnopqrstuvwxyz'

// stands in for safeStorage: reversible, and its output does not contain the plain text
const box = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8')
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A config.json written exactly as index.ts writeConfig does (read, merge, JSON with 2 spaces). */
function configFile(): { path: string; read: () => Record<string, any>; write: (patch: Record<string, unknown>) => void } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const dir = mkdtempSync(join(tmpdir(), 'sw-cloud-key-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  const read = (): Record<string, any> => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}) // eslint-disable-line @typescript-eslint/no-explicit-any
  const write = (patch: Record<string, unknown>): void => writeFileSync(path, JSON.stringify({ ...read(), ...patch }, null, 2), 'utf8')
  return { path, read, write }
}

function storeOn(cfg: ReturnType<typeof configFile>, b = box): InstanceType<typeof ApiKeyStore> {
  return new ApiKeyStore(
    () => cfg.read().sorterCloud?.keyEnc,
    (enc) => cfg.write({ sorterCloud: { ...(cfg.read().sorterCloud ?? {}), keyEnc: enc } }),
    b
  )
}

describe('API key at rest', () => {
  it('is stored only encrypted: config.json never holds it in plain text', () => {
    const cfg = configFile()
    cfg.write({ wellRoot: '/scratch/well', sorterCloud: { batchTime: '02:00' } })
    const keys = storeOn(cfg)
    expect(keys.set(`  ${FAKE_KEY}\n`)).toEqual({ ok: true, saved: true })
    const text = readFileSync(cfg.path, 'utf8')
    expect(text).not.toContain(FAKE_KEY)
    expect(text).not.toContain('LEAKCHECK')
    expect(cfg.read().sorterCloud.keyEnc).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(cfg.read().sorterCloud.batchTime).toBe('02:00') // other settings kept
    expect(keys.has()).toBe(true)
    expect(keys.get()).toBe(FAKE_KEY) // main process only
    keys.clear()
    expect(keys.has()).toBe(false)
    expect(readFileSync(cfg.path, 'utf8')).not.toContain('keyEnc')
  })

  it('without a keychain nothing is written', () => {
    const cfg = configFile()
    const keys = storeOn(cfg, { ...box, available: () => false })
    const r = keys.set(FAKE_KEY)
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain(FAKE_KEY)
    expect(existsSync(cfg.path)).toBe(false)
  })

  it('an encryption failure does not echo anything', () => {
    const cfg = configFile()
    const keys = storeOn(cfg, { ...box, encrypt: () => { throw new Error(`could not encrypt ${FAKE_KEY}`) } })
    expect(JSON.stringify(keys.set(FAKE_KEY))).not.toContain(FAKE_KEY)
  })

  it('rejects things that are not a key', () => {
    expect(checkKeyShape('short')).toBeNull()
    expect(checkKeyShape('has a space in it 0123456789')).toBeNull()
    expect(checkKeyShape(42)).toBeNull()
    expect(checkKeyShape(` ${FAKE_KEY} `)).toBe(FAKE_KEY)
  })
})

describe('API key in logs', () => {
  it('no log line, console line or run summary carries the key, even when OpenAI echoes it', async () => {
    const well = makeCloudWell([
      { hash: 'a', proposal: 'doubtful', window: 'one' },
      { hash: 'b', proposal: 'doubtful', window: 'two' }
    ])
    dirs.push(well)
    const consoleLines: string[] = []
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(' '))))
    try {
      const echo = (status: number) => async () => ({
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: `Something about ${FAKE_KEY} and sk-test-****wxyz` } })
      })
      const runs = []
      for (const http of [echo(400), echo(500), echo(401)]) {
        const d = cloudDeps(well, { keyValue: FAKE_KEY, http })
        const svc = new CloudSorter(d)
        runs.push({ summary: await svc.runNightly(), logs: d.logs, status: svc.status() })
      }
      const everything = JSON.stringify(runs) + consoleLines.join('\n')
      expect(runs.map((r) => r.summary.skipped ?? r.summary.error)).toEqual([expect.stringContaining('OpenAI refused the request (400)'), expect.stringContaining('server error'), 'key-rejected'])
      expect(runs[0].logs.some((l) => l.includes('[key]'))).toBe(true) // the echoed key was there, and was removed
      expect(everything).not.toContain(FAKE_KEY)
      expect(everything).not.toContain('LEAKCHECK')
      expect(everything).not.toMatch(/sk-test/)
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})

// --- ticket 16: a second provider, each with its own key ---
const { PROVIDERS } = await import('../src/main/sorter/cloud/provider')
const { bothStubs } = await import('./sorter-cloud-fixture')

// a made-up key in Anthropic's shape; it must never appear in config.json, a log line or a run summary
const FAKE_ANT_KEY = 'sk-ant-api03-ANTLEAKCHECK-0123456789abcdefghijklmnop'

/** The two stores as index.ts builds them: one config field each, each with its provider's key rule. */
function bothStores(cfg: ReturnType<typeof configFile>): Record<'openai' | 'anthropic', InstanceType<typeof ApiKeyStore>> {
  const field = (name: 'keyEnc' | 'anthropicKeyEnc', rule: (k: string) => string | null): InstanceType<typeof ApiKeyStore> =>
    new ApiKeyStore(
      () => cfg.read().sorterCloud?.[name],
      (enc) => cfg.write({ sorterCloud: { ...(cfg.read().sorterCloud ?? {}), [name]: enc } }),
      box,
      rule
    )
  return { openai: field('keyEnc', PROVIDERS.openai.keyRule), anthropic: field('anthropicKeyEnc', PROVIDERS.anthropic.keyRule) }
}

describe('a key per provider', () => {
  it('each provider’s key has its own encrypted field; saving or removing one leaves the other', () => {
    const cfg = configFile()
    const keys = bothStores(cfg)
    expect(keys.openai.set(FAKE_KEY)).toEqual({ ok: true, saved: true })
    expect(keys.anthropic.has()).toBe(false) // an OpenAI key is not an Anthropic key
    expect(keys.anthropic.set(FAKE_ANT_KEY)).toEqual({ ok: true, saved: true })
    expect(keys.openai.get()).toBe(FAKE_KEY)
    expect(keys.anthropic.get()).toBe(FAKE_ANT_KEY)
    const text = readFileSync(cfg.path, 'utf8')
    expect(text).not.toContain('LEAKCHECK')
    expect(text).not.toContain('sk-ant')
    expect(Object.keys(cfg.read().sorterCloud).sort()).toEqual(['anthropicKeyEnc', 'keyEnc'])
    keys.openai.clear()
    expect(keys.openai.has()).toBe(false)
    expect(keys.anthropic.get()).toBe(FAKE_ANT_KEY)
    keys.anthropic.clear()
    expect(readFileSync(cfg.path, 'utf8')).not.toMatch(/keyEnc/i)
  })

  it('a key of the other provider is refused, and the refusal does not repeat it', () => {
    const cfg = configFile()
    const keys = bothStores(cfg)
    const a = keys.anthropic.set(FAKE_KEY)
    const o = keys.openai.set(FAKE_ANT_KEY)
    expect(a).toMatchObject({ ok: false, saved: false, error: expect.stringMatching(/Anthropic API key/) })
    expect(o).toMatchObject({ ok: false, saved: false, error: expect.stringMatching(/Anthropic key/) })
    expect(JSON.stringify([a, o])).not.toContain('LEAKCHECK')
    expect(existsSync(cfg.path)).toBe(false) // nothing was written
  })

  it('ciphertext moved by hand into the other provider’s field reads as no key there', () => {
    const cfg = configFile()
    const keys = bothStores(cfg)
    keys.openai.set(FAKE_KEY)
    keys.anthropic.set(FAKE_ANT_KEY)
    const c = cfg.read().sorterCloud
    cfg.write({ sorterCloud: { keyEnc: c.anthropicKeyEnc, anthropicKeyEnc: c.keyEnc } })
    expect(keys.openai.get()).toBeNull()
    expect(keys.anthropic.get()).toBeNull()
    expect(keys.openai.has() || keys.anthropic.has()).toBe(false)
  })

  it('a key in the environment is never used: with nothing stored, nothing is sent to either provider', async () => {
    const well = makeCloudWell([{ hash: 'a', proposal: 'doubtful', window: 'one' }])
    dirs.push(well)
    const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'] as const
    const before = names.map((n) => process.env[n])
    process.env.ANTHROPIC_API_KEY = FAKE_ANT_KEY
    process.env.ANTHROPIC_AUTH_TOKEN = FAKE_ANT_KEY
    process.env.OPENAI_API_KEY = FAKE_KEY
    try {
      for (const provider of ['anthropic', 'openai'] as const) {
        const net = bothStubs()
        const d = cloudDeps(well, { keyValue: null, anthropicKeyValue: null, http: net.http, settings: { provider } })
        const svc = new CloudSorter(d)
        expect(svc.status().hasKey).toBe(false)
        expect(await svc.prepare()).toMatchObject({ blocked: 'no-key', token: null })
        expect(await svc.runNightly()).toMatchObject({ skipped: 'no-key', asked: 0 })
        expect(net.urls).toEqual([])
      }
    } finally {
      names.forEach((n, i) => (before[i] === undefined ? delete process.env[n] : (process.env[n] = before[i])))
    }
  })

  it('the cloud step’s source reads no environment variable at all', () => {
    const dir = join(__dirname, '..', 'src', 'main', 'sorter', 'cloud')
    for (const f of ['client.ts', 'haiku.ts', 'key-store.ts', 'luna.ts', 'provider.ts', 'service.ts']) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/process\.env|ANTHROPIC_API_KEY|OPENAI_API_KEY/)
    }
  })

  it('a Haiku run with a key that is not Anthropic’s kind is not made', async () => {
    const well = makeCloudWell([{ hash: 'a', proposal: 'doubtful', window: 'one' }])
    dirs.push(well)
    const net = bothStubs()
    // a store without the rule (as a hand-built one might be) that hands back an OpenAI-shaped key
    const d = cloudDeps(well, { anthropicKeyValue: FAKE_KEY, http: net.http, settings: { provider: 'anthropic' } })
    expect(await new CloudSorter(d).runNightly()).toMatchObject({ skipped: 'no-key', asked: 0 })
    const d2 = cloudDeps(well, { keyValue: FAKE_ANT_KEY, http: net.http, settings: { provider: 'openai' } })
    expect(await new CloudSorter(d2).runNightly()).toMatchObject({ skipped: 'no-key', asked: 0 })
    expect(net.urls).toEqual([])
  })
})

describe('both keys in logs', () => {
  it('no log line, console line or run summary of a Haiku run carries either key, even when Anthropic echoes them', async () => {
    const well = makeCloudWell([
      { hash: 'a', proposal: 'doubtful', window: 'one' },
      { hash: 'b', proposal: 'doubtful', window: 'two' }
    ])
    dirs.push(well)
    const consoleLines: string[] = []
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(' '))))
    try {
      const echo = (status: number) => async () => ({
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Something about ${FAKE_ANT_KEY} and sk-ant-api03-ANT...mnop and x-api-key: ${FAKE_ANT_KEY} and the other one ${FAKE_KEY}` } })
      })
      const runs = []
      for (const http of [echo(400), echo(529), echo(401)]) {
        const d = cloudDeps(well, { keyValue: FAKE_KEY, anthropicKeyValue: FAKE_ANT_KEY, http, settings: { provider: 'anthropic' } })
        const svc = new CloudSorter(d)
        runs.push({ summary: await svc.runNightly(), logs: d.logs, status: svc.status() })
      }
      const everything = JSON.stringify(runs) + consoleLines.join('\n')
      expect(runs.map((r) => r.summary.skipped ?? r.summary.error)).toEqual([expect.stringContaining('Anthropic refused the request (400)'), expect.stringContaining('Anthropic had a server error'), 'key-rejected'])
      expect(runs[0].logs.some((l) => l.includes('[key]'))).toBe(true) // the echoed keys were there, and were removed
      expect(everything).not.toContain('LEAKCHECK')
      expect(everything).not.toMatch(/sk-ant|sk-test/)
      expect(runs[2].summary.message).toBe('Anthropic did not accept the API key. 2 screenshots still need a look.')
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})

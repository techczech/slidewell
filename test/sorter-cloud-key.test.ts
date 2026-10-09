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

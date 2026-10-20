// The R2 card's save: the endpoint/bucket/account (settings file) and the key ciphertext (config.json) land
// together or not at all, and the answer is ok only when both did. Fakes stand in for the two files.
import { describe, expect, test } from 'vitest'
import { PARTIAL_R2_SAVE, saveR2, type R2Ciphertext, type R2Prefs, type R2SaveDeps } from '../src/main/r2-save'

function files(o: { prefsFail?: boolean; cipherFail?: boolean; enc?: boolean } = {}) {
  const prefs: R2Prefs = { endpoint: 'https://old.r2.cloudflarestorage.com', bucket: 'old' }
  let cipher: R2Ciphertext | null = { accessKeyIdEnc: 'old-id', secretEnc: 'old-secret' }
  let prefWrites = 0
  const deps: R2SaveDeps = {
    encAvailable: () => o.enc !== false,
    encrypt: (plain) => `enc(${plain.length})`,
    snapshot: (fields) => Object.fromEntries(fields.map((f) => [f, prefs[f]])),
    async writePrefs(next) {
      prefWrites++
      if (o.prefsFail && prefWrites === 1) return { ok: false, error: 'The settings file is locked' }
      Object.assign(prefs, next)
      return { ok: true }
    },
    writeCiphertext(enc) {
      if (o.cipherFail) throw Object.assign(new Error('no'), { code: 'EACCES' })
      cipher = enc
    }
  }
  return { deps, prefs, cipher: () => cipher }
}
const change = { endpoint: ' https://new.r2.cloudflarestorage.com ', bucket: 'new', accessKeyId: 'ID', secretAccessKey: 'SECRET' }

describe('saving the R2 connection', () => {
  test('both land: ok, keys saved', async () => {
    const f = files()
    const r = await saveR2(change, f.deps)
    expect(r).toMatchObject({ ok: true, savedCreds: true })
    expect(f.prefs).toEqual({ endpoint: 'https://new.r2.cloudflarestorage.com', bucket: 'new' })
    expect(f.cipher()?.accessKeyIdEnc).toBe('enc(2)')
  })
  test('preferences refused: no ciphertext written, the failure returned', async () => {
    const f = files({ prefsFail: true })
    const r = await saveR2(change, f.deps)
    expect(r).toMatchObject({ ok: false, savedCreds: false, error: 'The settings file is locked' })
    expect(f.cipher()?.accessKeyIdEnc).toBe('old-id')
    expect(f.prefs.endpoint).toBe('https://old.r2.cloudflarestorage.com')
  })
  test('ciphertext refused: the preferences are put back, the failure returned', async () => {
    const f = files({ cipherFail: true })
    const r = await saveR2(change, f.deps)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('EACCES')
    expect(f.prefs).toEqual({ endpoint: 'https://old.r2.cloudflarestorage.com', bucket: 'old' })
    expect(f.cipher()?.accessKeyIdEnc).toBe('old-id')
  })
  test('no keychain: nothing is written', async () => {
    const f = files({ enc: false })
    const r = await saveR2(change, f.deps)
    expect(r).toMatchObject({ ok: false, encAvailable: false })
    expect(f.prefs.bucket).toBe('old')
  })
  test('preferences only (no keys): ok without touching the ciphertext', async () => {
    const f = files({ cipherFail: true })
    expect(await saveR2({ bucket: 'b2' }, f.deps)).toMatchObject({ ok: true, gotKeys: false, savedCreds: false })
    expect(f.prefs.bucket).toBe('b2')
  })

  test('ciphertext refused and the put-back fails too: the answer says the R2 settings were not saved completely', async () => {
    const f = files({ cipherFail: true })
    const write = f.deps.writePrefs
    let n = 0
    f.deps.writePrefs = async (next) => (++n === 1 ? write(next) : { ok: false, error: 'locked' })
    const r = await saveR2(change, f.deps)
    expect(r).toMatchObject({ ok: false, savedCreds: false, error: PARTIAL_R2_SAVE })
  })
  test('the put-back restores only what this save wrote and is still there, never another writer’s change', async () => {
    const f = files({ cipherFail: true })
    const write = f.deps.writePrefs
    f.deps.writePrefs = async (next) => {
      const r = await write(next)
      if ('bucket' in next && next.bucket === 'new') f.prefs.bucket = 'someone-else' // another writer (CLI, Settings) lands in between
      return r
    }
    const r = await saveR2(change, f.deps)
    expect(r.ok).toBe(false)
    expect(f.prefs).toEqual({ endpoint: 'https://old.r2.cloudflarestorage.com', bucket: 'someone-else' })
  })
  test('overlapping saves run one after the other: a failing save never undoes the one that succeeded', async () => {
    const f = files()
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => (release = res))
    const write = f.deps.writePrefs
    const order: string[] = []
    f.deps.writePrefs = async (next) => {
      order.push(String(next.bucket))
      if (next.bucket === 'A') {
        await gate
        return { ok: false, error: 'The settings file is locked' }
      }
      return write(next)
    }
    const a = saveR2({ bucket: 'A' }, f.deps)
    const b = saveR2({ bucket: 'B' }, f.deps)
    await Promise.resolve()
    expect(order).toEqual(['A']) // B waits for A
    release()
    expect(await a).toMatchObject({ ok: false })
    expect(await b).toMatchObject({ ok: true })
    expect(f.prefs.bucket).toBe('B')
    expect(order).toEqual(['A', 'B'])
  })
})

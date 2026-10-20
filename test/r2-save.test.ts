// The R2 card's save: the endpoint/bucket/account (settings file) and the key ciphertext (config.json) land
// together or not at all, and the answer is ok only when both did. Fakes stand in for the two files.
import { describe, expect, test } from 'vitest'
import { saveR2, type R2Ciphertext, type R2Prefs, type R2SaveDeps } from '../src/main/r2-save'

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
})

/**
 * The OpenAI API key for the cloud step, held the same way as the R2 credentials: encrypted with
 * Electron safeStorage (the OS keychain) and kept in config.json only as that ciphertext (base64).
 *
 * The key is write-only from the renderer: set / clear / has. Only the main process reads it back
 * (get), for the Authorization header of a Luna request. It is never logged and never returned
 * over IPC. The SecretBox is injected so tests can check what reaches disk without a keychain.
 */
export type SecretBox = {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

export type KeySetResult = { ok: boolean; saved: boolean; error?: string }

/** A pasted key: trimmed, one token, of plausible length. */
export function checkKeyShape(key: unknown): string | null {
  if (typeof key !== 'string') return null
  const k = key.trim()
  return /^[\x21-\x7e]{20,400}$/.test(k) ? k : null
}

export class ApiKeyStore {
  constructor(
    private readEnc: () => string | undefined,
    private writeEnc: (enc: string | undefined) => void,
    private box: SecretBox
  ) {}

  encryptionAvailable(): boolean {
    try {
      return this.box.available()
    } catch {
      return false
    }
  }

  set(key: unknown): KeySetResult {
    const k = checkKeyShape(key)
    if (!k) return { ok: false, saved: false, error: 'That does not look like an API key.' }
    if (!this.encryptionAvailable()) return { ok: false, saved: false, error: 'The macOS keychain is not available, so the key cannot be stored safely.' }
    try {
      const enc = this.box.encrypt(k).toString('base64')
      this.writeEnc(enc)
      return { ok: true, saved: true }
    } catch {
      return { ok: false, saved: false, error: 'The key could not be encrypted.' } // never echo the underlying message
    }
  }

  clear(): void {
    this.writeEnc(undefined)
  }

  has(): boolean {
    return this.get() !== null
  }

  /** Main process only. */
  get(): string | null {
    const enc = this.readEnc()
    if (!enc || !this.encryptionAvailable()) return null
    try {
      return this.box.decrypt(Buffer.from(enc, 'base64')) || null
    } catch {
      return null
    }
  }
}

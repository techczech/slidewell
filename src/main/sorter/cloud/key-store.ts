/**
 * An API key for the cloud step, held the same way as the R2 credentials: encrypted with Electron
 * safeStorage (the OS keychain) and kept in config.json only as that ciphertext (base64). There is
 * one store per provider (index.ts: the OpenAI key in sorterCloud.keyEnc, the Anthropic key in
 * sorterCloud.anthropicKeyEnc), and that stored ciphertext is the only place a key ever comes from:
 * no environment variable, no other file, no lookup by name.
 *
 * The key is write-only from the renderer: set / clear / has. Only the main process reads it back
 * (get), for the key header of a request to that store's provider. It is never logged and never
 * returned over IPC. The SecretBox is injected so tests can check what reaches disk without a keychain.
 *
 * A store may be given a rule for whose key it holds (KeyRule; provider.ts keyRule). The rule is
 * applied when a key is saved and again whenever it is read, so a key of the other provider is
 * neither stored here nor, should the ciphertext in config.json be swapped by hand, sent to the
 * wrong company.
 */
export type SecretBox = {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

export type KeySetResult = { ok: boolean; saved: boolean; error?: string; shape?: boolean }

/** A pasted key: trimmed, one token, of plausible length. */
export function checkKeyShape(key: unknown): string | null {
  if (typeof key !== 'string') return null
  const k = key.trim()
  return /^[\x21-\x7e]{20,400}$/.test(k) ? k : null
}

/** Why this store does not take the key (a sentence for Settings, never containing the key); null when it does. */
export type KeyRule = (key: string) => string | null

export class ApiKeyStore {
  constructor(
    private readEnc: () => string | undefined,
    private writeEnc: (enc: string | undefined) => void,
    private box: SecretBox,
    private rule: KeyRule = () => null
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
    if (!k) return { ok: false, saved: false, error: 'That does not look like an API key.', shape: true }
    const refused = this.rule(k)
    if (refused) return { ok: false, saved: false, error: refused, shape: true }
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
      const k = this.box.decrypt(Buffer.from(enc, 'base64'))
      return k && this.rule(k) === null ? k : null
    } catch {
      return null
    }
  }
}

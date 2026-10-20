// Settings › Accounts and keys over the keys SlideWell already keeps: each one safeStorage-encrypted
// (the macOS keychain) and stored in config.json only as that ciphertext. Nothing here reads a key's
// value: the list goes by whether the ciphertext is there, a save hands the typed value straight to the
// backend that encrypts it, and no result carries the value or the backend's own words.
import { SLOT_MESSAGES, type SecretSlots, type SlotInfo, type SlotResult } from '@bridle/settings-electron'
import type { SecretKey } from '../shared/settings-schema'

export type KeyBackend = {
  label: string
  /** True when the ciphertext is stored (never decrypted for this). */
  has(): boolean
  /** Encrypts and stores the key; ok false when it was refused (shape, keychain unavailable). shape: true when the key is the wrong kind. */
  set(value: string): { ok: boolean; error?: string; shape?: boolean }
  remove(): void
}

export function keySlots(backends: Record<SecretKey, KeyBackend>, encryptionAvailable: () => boolean): SecretSlots {
  const known = (id: string): id is SecretKey => Object.hasOwn(backends, id)
  return {
    list(): SlotInfo[] {
      const usable = encryptionAvailable()
      return (Object.keys(backends) as SecretKey[]).map((id) => {
        const b = backends[id]
        const saved = b.has()
        return { id, label: b.label, status: saved && usable ? 'connected' : saved ? 'problem' : 'missing' }
      })
    },
    set(id, value): SlotResult {
      if (!known(id)) return { ok: false, error: 'unknown' }
      if (!encryptionAvailable()) return { ok: false, error: 'keychain' }
      try {
        const r = backends[id].set(value.trim())
        if (r.ok) return { ok: true }
        // a wrong-shape key gets the package's own shape message (the window shows only those); anything else passes its fixed sentence through; never the value
        if (r.shape) return { ok: false, error: SLOT_MESSAGES.shape }
        return { ok: false, error: r.error ?? 'refused' }
      } catch {
        return { ok: false, error: 'failed' }
      }
    },
    remove(id): SlotResult {
      if (!known(id)) return { ok: false, error: 'unknown' }
      try {
        backends[id].remove()
        return { ok: true }
      } catch {
        return { ok: false, error: 'failed' }
      }
    }
  }
}

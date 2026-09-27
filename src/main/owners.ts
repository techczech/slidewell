/**
 * "My decks": which PPTX authors count as the user. The owner names are a setting
 * (config.json `ownerNames`); when unset they default to the macOS account — the full name
 * (`id -F`) plus the login name — so a fresh install recognises its own user's decks and an
 * existing install keeps matching the same decks it did before the setting existed.
 *
 * Matching (all case- and diacritic-insensitive, so "Lukeš" ≡ "lukes"):
 *  - every name word of 3+ letters, and each whole name, matches as a SUBSTRING of the author
 *    ("Dominik Lukes" → "dominik", "lukes": matches "Lukes, Dominik", "dlukes", "dominik.lukes@…");
 *  - shorter words, and the initials of a multi-word name ("dl"), match only the WHOLE author field.
 * Pure except `accountProbe`, which is injected so tests never depend on the machine.
 */
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

export type OwnerMatcher = (value: string | null | undefined) => boolean

export function normaliseName(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function ownerMatcher(names: readonly string[]): OwnerMatcher {
  const contains = new Set<string>()
  const exact = new Set<string>()
  for (const raw of names) {
    const n = normaliseName(String(raw ?? ''))
    if (!n) continue
    ;(n.length >= 3 ? contains : exact).add(n)
    const words = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    for (const w of words) (w.length >= 3 ? contains : exact).add(w)
    if (words.length >= 2) exact.add(words.map((w) => w[0]).join(''))
  }
  return (value) => {
    const s = normaliseName(String(value ?? ''))
    if (!s) return false
    if (exact.has(s)) return true
    for (const c of contains) if (s.includes(c)) return true
    return false
  }
}

export interface AccountNames {
  username: string | null
  fullName: string | null
}

/** The OS account's login name and full name; either is null when it cannot be read. */
export function accountProbe(): AccountNames {
  let username: string | null = null
  let fullName: string | null = null
  try {
    username = userInfo().username || null
  } catch {
    username = null
  }
  try {
    // macOS: `id -F` prints the account's full name. Absent/failing elsewhere → no full name.
    fullName = execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    fullName = null
  }
  return { username, fullName }
}

/** Default owner names from the account: full name first, then the login name (deduplicated). */
export function defaultOwnerNames(probe: () => AccountNames = accountProbe): string[] {
  let acc: AccountNames
  try {
    acc = probe()
  } catch {
    return []
  }
  const out: string[] = []
  for (const v of [acc.fullName, acc.username]) {
    const t = (v ?? '').trim()
    if (t && !out.some((o) => normaliseName(o) === normaliseName(t))) out.push(t)
  }
  return out
}

/** Clean a user-entered list: trimmed, non-empty, deduplicated (by normalised form). */
export function cleanOwnerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (t && !out.some((o) => normaliseName(o) === normaliseName(t))) out.push(t)
  }
  return out
}

/** The effective owner names: the configured list when it has any name, else the account default. */
export function resolveOwnerNames(configured: unknown, probe: () => AccountNames = accountProbe): { names: string[]; isDefault: boolean } {
  const names = cleanOwnerNames(configured)
  if (names.length > 0) return { names, isDefault: false }
  return { names: defaultOwnerNames(probe), isDefault: true }
}

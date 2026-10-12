/**
 * The cloud step's settings: what config.json stores (sorterCloud) and how the service reads it.
 * Pure: no I/O, no key. service.ts re-exports all of it.
 *
 * Four things are stored, each on its own:
 *   - Agreement, per provider: the time he confirmed main's dialog naming that provider (optedInAt
 *     for OpenAI, anthropicOptedInAt for Anthropic). Turning the service off does not remove it;
 *     removing that provider's key does (withdrawAgreement). Nothing is ever sent to a provider
 *     without it.
 *   - The service: `enabled` and `provider`. It is on only when `enabled` is not false AND the
 *     selected provider has an agreement. A config written before `enabled` was stored has no such
 *     field, and reads as it always did: on exactly when the selected provider has an agreement.
 *   - `nightly`: whether the nightly batch runs (at batchTime). It runs only while the service is on.
 *   - `secondOpinions`: whether a provider may be asked about a screenshot the other one answered
 *     and was unsure about.
 *
 * A switch that was never stored (the property is absent) reads as on, which is how a config from
 * before it existed behaved. Stored as anything but true (null, a string, a number), it reads as off.
 */
import { DEFAULT_PROVIDER, isProviderId, type ProviderId } from './provider'
import { DEFAULT_BATCH_TIME, normaliseBatchTime } from './schedule'

/**
 * The settings as the service reads them. `enabled` is true only when the service is on and he has
 * agreed to `provider`. `agreedAt` is when he agreed to each provider (null: not agreed).
 */
export type CloudSettings = { enabled: boolean; batchTime: string; provider: ProviderId; nightly: boolean; secondOpinions: boolean; agreedAt: Record<ProviderId, string | null> }
/**
 * What config.json stores for them. `optedInAt` is his agreement to OpenAI (the name ticket 07 gave
 * it), `anthropicOptedInAt` his agreement to Anthropic; `provider` is absent in a config written
 * before there were two, which means OpenAI; `enabled`, `nightly` and `secondOpinions` are absent in
 * a config written before ticket 18.
 */
export type StoredCloudSettings = { enabled?: boolean; provider?: ProviderId; optedInAt?: string | null; anthropicOptedInAt?: string | null; batchTime?: string; nightly?: boolean; secondOpinions?: boolean }

const OPT_IN_FIELD: Record<ProviderId, 'optedInAt' | 'anthropicOptedInAt'> = { openai: 'optedInAt', anthropic: 'anthropicOptedInAt' }
type Raw = StoredCloudSettings | Record<string, unknown> | undefined
const fields = (raw: Raw): Record<string, unknown> => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {})

/** The provider selected in the stored settings (OpenAI when none or an unknown one is stored). */
export function storedProvider(raw: Raw): ProviderId {
  const p = fields(raw).provider
  return isProviderId(p) ? p : DEFAULT_PROVIDER
}

/** When he agreed to this provider, as stored (a readable time in its own field); null when he has not. */
export function agreedAt(raw: Raw, provider: ProviderId): string | null {
  const v = fields(raw)[OPT_IN_FIELD[provider]]
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null
}

/** Whether the stored settings hold his agreement to this provider. */
export function optedIn(raw: Raw, provider: ProviderId): boolean {
  return agreedAt(raw, provider) !== null
}

/** A stored switch: on when it was never stored (the property is absent) or is true; off for anything else, an explicit null included. */
export function storedSwitch(raw: Raw, field: 'enabled' | 'nightly' | 'secondOpinions'): boolean {
  const v = fields(raw)[field]
  return v === undefined || v === true
}

/** Whether the service is on: not turned off, and the selected provider has his agreement. */
export function serviceOn(raw: Raw): boolean {
  return storedSwitch(raw, 'enabled') && optedIn(raw, storedProvider(raw))
}

export function normaliseCloudSettings(raw: Raw): CloudSettings {
  return {
    enabled: serviceOn(raw),
    batchTime: normaliseBatchTime(fields(raw).batchTime ?? DEFAULT_BATCH_TIME),
    provider: storedProvider(raw),
    nightly: storedSwitch(raw, 'nightly'),
    secondOpinions: storedSwitch(raw, 'secondOpinions'),
    agreedAt: { openai: agreedAt(raw, 'openai'), anthropic: agreedAt(raw, 'anthropic') }
  }
}

/** Whether a value from the renderer is a switch position: true or false and nothing else. */
export function isSwitch(x: unknown): x is boolean {
  return x === true || x === false
}

/**
 * A settings change, as what to store. `provider` selects a provider (an unknown one is ignored);
 * `enabled: true` turns the service on and records the agreement now for the provider the patch
 * leaves selected (kept if already there) and for no other; `enabled: false` turns it off and keeps
 * both agreements; `batchTime` is normalised. Nothing else is read: `nightly` and `secondOpinions`
 * are carried over as stored and have their own setters (service.ts). Selecting a provider never
 * agrees to it: without its own agreement the result is off. Whether he confirmed the dialog for
 * that provider is changeSettings' business, which is the only caller outside tests.
 */
export function applySettingsPatch(cur: StoredCloudSettings, patch: unknown, now: Date): Required<StoredCloudSettings> {
  const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
  const provider = isProviderId(p.provider) ? p.provider : storedProvider(cur)
  const out: Required<StoredCloudSettings> = {
    enabled: false,
    provider,
    optedInAt: agreedAt(cur, 'openai'),
    anthropicOptedInAt: agreedAt(cur, 'anthropic'),
    batchTime: normaliseBatchTime(cur.batchTime ?? DEFAULT_BATCH_TIME),
    nightly: storedSwitch(cur, 'nightly'),
    secondOpinions: storedSwitch(cur, 'secondOpinions')
  }
  if (p.enabled === true && !out[OPT_IN_FIELD[provider]]) out[OPT_IN_FIELD[provider]] = now.toISOString()
  const wanted = p.enabled === true || (p.enabled !== false && serviceOn(cur))
  out.enabled = wanted && Boolean(out[OPT_IN_FIELD[provider]])
  if (p.batchTime !== undefined) out.batchTime = normaliseBatchTime(p.batchTime)
  return out
}

/**
 * His agreement to one provider withdrawn (its key was removed), as what to store: that provider's
 * agreement goes, the other's stays, and the service is off when the withdrawn one is selected.
 */
export function withdrawAgreement(cur: StoredCloudSettings, provider: ProviderId): Pick<Required<StoredCloudSettings>, 'enabled' | 'optedInAt' | 'anthropicOptedInAt'> {
  const kept = { optedInAt: agreedAt(cur, 'openai'), anthropicOptedInAt: agreedAt(cur, 'anthropic') }
  kept[OPT_IN_FIELD[provider]] = null
  return { ...kept, enabled: storedSwitch(cur, 'enabled') && Boolean(kept[OPT_IN_FIELD[storedProvider(cur)]]) }
}

/**
 * The cloud step's two providers behind one seam. A CloudProvider says everything that differs
 * between asking OpenAI's Luna and asking Anthropic's Haiku: where the request goes and how it
 * carries the key (Wire), how a request is built and its answer read, what it costs, the words the
 * dialogs and Settings use, the code and model recorded with each decision, and which keys belong
 * to it. Everything else is shared and lives in service.ts, schedule.ts, store.ts and images.ts:
 * main's consent dialog, the opt-in, the prepared batch, the one nightly allowance, the 02:00
 * schedule, the stop when a key changes, and the re-read of each file before it is sent.
 *
 *   PROVIDERS / providerOf(id)   the two, by id ('openai' is the default)
 *   isProviderId(x)              the only two ids there are; anything else is not a provider
 *   answerScopes()               each provider's current model + prompt (store.ts: an answer under
 *                                any of them means the screenshot is not asked again)
 *   voiceOfAnswer(model, prompt) whose stored answer this is (sorter/service.ts re-applies it)
 *
 * Nothing here does I/O or holds a key.
 */
import type { Wire } from './client'
import { LUNA_WIRE } from './client'
import type { CloudVoice } from './cascade'
import { buildHaikuRequest, estimateHaikuCost, HAIKU, haikuHeaders, parseHaikuResponse } from './haiku'
import { buildLunaRequest, estimateCost, LUNA, parseLunaResponse, type CostEstimate, type LunaItem, type LunaParsed, type LunaRequest } from './luna'

export type ProviderId = 'openai' | 'anthropic'
export const PROVIDER_IDS: readonly ProviderId[] = ['openai', 'anthropic']
/** Luna, as shipped in ticket 07, unless he chooses Haiku in Settings. */
export const DEFAULT_PROVIDER: ProviderId = 'openai'

export function isProviderId(x: unknown): x is ProviderId {
  return x === 'openai' || x === 'anthropic'
}

export type CloudProvider = Wire &
  CloudVoice & {
    id: ProviderId
    company: 'OpenAI' | 'Anthropic'
    name: 'Luna' | 'Haiku'
    promptVersion: string
    longEdge: number
    chunkSize: number
    concurrency: number
    buildRequest(items: LunaItem[]): LunaRequest
    /** Throws LunaResponseError when the body as a whole is unusable; an unusable entry is just missing. */
    parseResponse(body: unknown, ids: Map<string, string>): LunaParsed
    estimateCost(n: number): CostEstimate
    /** The words before a cost figure in the dialogs. */
    costLabel: string
    /** A sentence after the cost figure in the dialogs; '' when there is nothing to add. */
    costNote: string
    /** Why a pasted or stored key is not this provider's (a sentence for Settings, never the key); null when it may be. */
    keyRule(key: string): string | null
  }

const ANTHROPIC_KEY_PREFIX = 'sk-ant-'

export const LUNA_PROVIDER: CloudProvider = {
  ...LUNA_WIRE,
  id: 'openai',
  company: 'OpenAI',
  name: 'Luna',
  decidedBy: 'luna',
  model: LUNA.model,
  promptVersion: LUNA.promptVersion,
  longEdge: LUNA.longEdge,
  chunkSize: LUNA.chunkSize,
  concurrency: LUNA.concurrency,
  buildRequest: buildLunaRequest,
  parseResponse: parseLunaResponse,
  estimateCost: (n) => estimateCost(n),
  costLabel: 'Estimated cost',
  costNote: '',
  keyRule: (key) => (key.startsWith(ANTHROPIC_KEY_PREFIX) ? 'That is an Anthropic key. Save it as the Anthropic key instead.' : null)
}

export const HAIKU_PROVIDER: CloudProvider = {
  endpoint: HAIKU.endpoint,
  headers: haikuHeaders,
  timeoutMs: HAIKU.timeoutMs,
  maxAttempts: HAIKU.maxAttempts,
  id: 'anthropic',
  company: 'Anthropic',
  name: 'Haiku',
  decidedBy: 'haiku',
  model: HAIKU.model,
  promptVersion: HAIKU.promptVersion,
  longEdge: HAIKU.longEdge,
  chunkSize: HAIKU.chunkSize,
  concurrency: HAIKU.concurrency,
  buildRequest: buildHaikuRequest,
  parseResponse: parseHaikuResponse,
  estimateCost: (n) => estimateHaikuCost(n),
  costLabel: 'Estimated cost at list price',
  costNote: 'The calls draw on the free monthly Anthropic API credits where they are available; anything beyond them is billed at list price.',
  keyRule: (key) => (key.startsWith(ANTHROPIC_KEY_PREFIX) ? null : 'That does not look like an Anthropic API key (they start with sk-ant-).')
}

export const PROVIDERS: Record<ProviderId, CloudProvider> = { openai: LUNA_PROVIDER, anthropic: HAIKU_PROVIDER }

/** The provider for an id; anything that is not one of the two ids is the default (Luna). */
export function providerOf(id: unknown): CloudProvider {
  return PROVIDERS[isProviderId(id) ? id : DEFAULT_PROVIDER]
}

export type AnswerScope = { model: string; promptVersion: string }

/** Each provider's current model + prompt. */
export function answerScopes(): AnswerScope[] {
  return PROVIDER_IDS.map((id) => ({ model: PROVIDERS[id].model, promptVersion: PROVIDERS[id].promptVersion }))
}

/** The provider whose current model + prompt a stored answer was given under; null for any other (it does not count). */
export function voiceOfAnswer(model: string, promptVersion: string): CloudProvider | null {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]).find((p) => p.model === model && p.promptVersion === promptVersion) ?? null
}

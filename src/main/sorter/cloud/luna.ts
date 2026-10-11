/**
 * The sorter's cloud step, pure part: what is sent to OpenAI's Luna and how its answer is read.
 *
 *   planChunks(candidates)   → only the doubtful ones, in chunks of LUNA.chunkSize
 *   buildLunaRequest(items)  → one Responses API body (images as base64 data URLs, JSON-schema output)
 *   parseLunaResponse(json)  → one answer per screenshot that was asked about; unknown ids are dropped
 *   estimateCost(n)          → the estimate shown before a manual run
 *
 * Nothing here does I/O. The HTTP client is client.ts; the run is service.ts.
 *
 * Privacy: a screenshot is sent only when the local steps left it doubtful (the builder drops
 * anything else) and only when it is a screenshot: its file name is a CleanShot or macOS screenshot
 * name (screenshot-name.ts), so photographs or scans in a Triage folder never leave the Mac. Each request carries a short per-request id (s1, s2, …), the app and window title
 * read from the file name, and the shrunk picture. Content hashes and paths stay on this Mac.
 * `store: false` asks OpenAI not to keep the response.
 */

import { parseScreenshotName } from '../../screenshot-name'

/** Everything about the Luna call in one place. */
export const LUNA = {
  endpoint: 'https://api.openai.com/v1/responses',
  model: 'gpt-6-luna',
  /** Bump when the instructions or schema change: earlier answers are then asked again. */
  promptVersion: 'luna-prompt-1',
  /** Pictures are shrunk to this long edge before sending. */
  longEdge: 1456,
  jpegQuality: 80,
  imageDetail: 'high' as const,
  chunkSize: 15,
  concurrency: 2,
  timeoutMs: 120_000,
  maxAttempts: 4,
  maxOutputTokensPerItem: 120,
  /**
   * Inputs to the cost estimate. Prices: OpenAI's list prices for gpt-6-luna, short context
   * (≤272K), from developers.openai.com/api/docs/pricing, checked 2026-10-11: input $0.10, cached
   * input $0.01, output $0.50 per million tokens (the estimate assumes no cached input). Token counts
   * follow OpenAI's image-token rules for a 1456 × ~820 picture at high detail (about 1,100–1,200).
   */
  estimate: { tokensPerImage: 1200, tokensPerRequest: 450, outputTokensPerItem: 45, usdPerMillionInput: 0.1, usdPerMillionCachedInput: 0.01, usdPerMillionOutput: 0.5 }
} as const

export const LUNA_SCHEMA_NAME = 'screenshot_verdicts'

/** The structured output Luna must return. */
export const LUNA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'confidence', 'reason'],
        properties: {
          id: { type: 'string', description: 'The id given before the screenshot, exactly.' },
          verdict: { type: 'string', enum: ['keep', 'throwaway', 'unsure'] },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How likely the verdict is right, 0 to 1.' },
          reason: { type: 'string', description: 'One line in plain English, under 20 words.' }
        }
      }
    }
  }
} as const

export const LUNA_INSTRUCTIONS = [
  'You help one person sort his screenshots into keep or throwaway.',
  'He keeps screenshots that could be useful later: material for slides and talks, answers from AI tools worth quoting, charts, diagrams, interesting text or articles, designs and bugs in apps he works on.',
  'He throws away screenshots with no later value: accidental or blank captures, passing system dialogs, settings pages, file pickers, log-in screens, loading screens.',
  'Finding things in his history later is what matters most. When in doubt, answer keep or unsure, never throwaway.',
  'For every screenshot give a verdict (keep, throwaway or unsure), a confidence from 0 to 1 that the verdict is right, and a one-line reason in plain English under 20 words.',
  'Answer once for every id you are given, using the id exactly.'
].join(' ')

export type Verdict = 'keep' | 'throwaway' | 'unsure'

/** A screenshot the cloud step may ask about. Only `proposal: 'doubtful'` is ever sent. */
export type CloudCandidate = {
  hash: string
  proposal: 'keep' | 'throwaway' | 'doubtful'
  path: string
  /** The file's name; only a screenshot name (isScreenshotFile) is ever sent. */
  filename: string
  app: string
  windowTitle: string
  /** Local time from the file name, '' when unknown (newest are asked first). */
  takenAt: string
}

/** A candidate with its shrunk picture. */
export type LunaItem = Pick<CloudCandidate, 'hash' | 'proposal' | 'app' | 'windowTitle'> & { image: { mime: string; base64: string } }

export type LunaRequest = {
  body: Record<string, unknown>
  /** Short id in the request → content hash, for reading the answer. */
  ids: Map<string, string>
}

export type LunaAnswer = { verdict: Verdict; confidence: number; reason: string }

export type LunaParsed = {
  answers: Map<string, LunaAnswer>
  /** Hashes that were asked about but got no usable answer (they stay doubtful and are asked again later). */
  missing: string[]
  usage: { inputTokens: number; outputTokens: number } | null
}

export class LunaResponseError extends Error {
  constructor(
    message: string,
    readonly kind: 'refusal' | 'incomplete' | 'malformed'
  ) {
    super(message)
    this.name = 'LunaResponseError'
  }
}

const isDoubtful = <T extends { proposal: string }>(c: T): boolean => c.proposal === 'doubtful'

/**
 * A screenshot by provenance: the file name is one a screen-capture tool gave it (CleanShot or
 * macOS, screenshot-name.ts). Anything else in a Triage folder (photographs, scans, renamed files)
 * is not a screenshot for the cloud step and never leaves the Mac.
 */
export function isScreenshotFile(filename: string): boolean {
  return typeof filename === 'string' && parseScreenshotName(filename) !== null
}

/** Doubtful screenshots only, newest first, at most `cap`. */
export function selectForCloud(candidates: CloudCandidate[], cap: number): CloudCandidate[] {
  const n = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0
  return candidates
    .filter((c) => isDoubtful(c) && isScreenshotFile(c.filename))
    .slice()
    .sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || '') || a.hash.localeCompare(b.hash))
    .slice(0, n)
}

/** Only doubtful candidates, in chunks of `size`. */
export function planChunks<T extends { proposal: string }>(candidates: T[], size: number = LUNA.chunkSize): T[][] {
  const s = Math.max(1, Math.floor(size))
  const doubtful = candidates.filter(isDoubtful)
  const out: T[][] = []
  for (let i = 0; i < doubtful.length; i += s) out.push(doubtful.slice(i, i + s))
  return out
}

/** Text that goes beside a picture: at most one line, no control characters. */
function clean(s: string, max: number): string {
  return (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** One Responses API request for these items. Anything not doubtful is left out. */
export function buildLunaRequest(items: LunaItem[]): LunaRequest {
  const sendable = items.filter(isDoubtful)
  const ids = new Map<string, string>()
  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: `${sendable.length} screenshot${sendable.length === 1 ? '' : 's'} follow, each after its id.` }
  ]
  sendable.forEach((it, i) => {
    const id = `s${i + 1}`
    ids.set(id, it.hash)
    const facts = [`id: ${id}`]
    if (it.app) facts.push(`app: ${clean(it.app, 80)}`)
    if (it.windowTitle) facts.push(`window: ${clean(it.windowTitle, 160)}`)
    content.push({ type: 'input_text', text: facts.join(' · ') })
    content.push({ type: 'input_image', image_url: `data:${it.image.mime};base64,${it.image.base64}`, detail: LUNA.imageDetail })
  })
  return {
    ids,
    body: {
      model: LUNA.model,
      instructions: LUNA_INSTRUCTIONS,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: LUNA_SCHEMA_NAME, strict: true, schema: LUNA_SCHEMA } },
      max_output_tokens: Math.max(256, sendable.length * LUNA.maxOutputTokensPerItem),
      store: false
    }
  }
}

type OutputPart = { type?: string; text?: string; refusal?: string }
type OutputItem = { type?: string; content?: OutputPart[] }

/** The model's JSON text from a Responses API body (the first output_text part). */
function outputText(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string') return json.output_text
  const output = Array.isArray(json.output) ? (json.output as OutputItem[]) : []
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (part?.type === 'refusal') throw new LunaResponseError('Luna declined to answer', 'refusal')
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text
    }
  }
  if (json.status === 'incomplete') throw new LunaResponseError('Luna stopped before finishing its answer', 'incomplete')
  throw new LunaResponseError('Luna sent no answer text', 'malformed')
}

const VERDICTS = new Set<Verdict>(['keep', 'throwaway', 'unsure'])

/**
 * Luna's answers, keyed by content hash. Ids that were not in the request are ignored; a malformed
 * entry leaves that screenshot unanswered. Throws LunaResponseError when the body as a whole is unusable.
 */
export function parseLunaResponse(body: unknown, ids: Map<string, string>): LunaParsed {
  if (!body || typeof body !== 'object') throw new LunaResponseError('Luna sent no answer', 'malformed')
  const json = body as Record<string, unknown>
  const text = outputText(json)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new LunaResponseError(json.status === 'incomplete' ? 'Luna stopped before finishing its answer' : 'Luna’s answer was not valid JSON', json.status === 'incomplete' ? 'incomplete' : 'malformed')
  }
  const items = data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? ((data as { items: unknown[] }).items) : null
  if (!items) throw new LunaResponseError('Luna’s answer had no items', 'malformed')
  const answers = new Map<string, LunaAnswer>()
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const hash = typeof r.id === 'string' ? ids.get(r.id.trim()) : undefined
    if (!hash || answers.has(hash)) continue
    const verdict = typeof r.verdict === 'string' && VERDICTS.has(r.verdict as Verdict) ? (r.verdict as Verdict) : null
    const c = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : null
    if (!verdict || c === null) continue
    answers.set(hash, { verdict, confidence: Math.min(1, Math.max(0, c)), reason: clean(typeof r.reason === 'string' ? r.reason : '', 200) })
  }
  const usageRaw = json.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined
  const usage =
    usageRaw && typeof usageRaw.input_tokens === 'number' && typeof usageRaw.output_tokens === 'number'
      ? { inputTokens: usageRaw.input_tokens, outputTokens: usageRaw.output_tokens }
      : null
  return { answers, missing: [...ids.values()].filter((h) => !answers.has(h)), usage }
}

export type CostEstimate = { screenshots: number; requests: number; inputTokens: number; outputTokens: number; usd: number }

/** What sending `n` screenshots would cost, by LUNA.estimate (an estimate, not a quote). */
export function estimateCost(n: number, chunkSize: number = LUNA.chunkSize): CostEstimate {
  const screenshots = Math.max(0, Math.floor(n))
  const requests = screenshots ? Math.ceil(screenshots / Math.max(1, chunkSize)) : 0
  const e = LUNA.estimate
  const inputTokens = screenshots * e.tokensPerImage + requests * e.tokensPerRequest
  const outputTokens = screenshots * e.outputTokensPerItem
  const usd = (inputTokens * e.usdPerMillionInput + outputTokens * e.usdPerMillionOutput) / 1_000_000
  return { screenshots, requests, inputTokens, outputTokens, usd }
}

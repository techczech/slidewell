/**
 * The sorter's cloud step for the second provider, pure part: what is sent to Anthropic's Haiku and
 * how its answer is read. Same seam as luna.ts:
 *
 *   buildHaikuRequest(items)   → one Messages API body (images as base64 image blocks; the answer is
 *                                forced into one tool call whose input follows Luna's answer schema)
 *   parseHaikuResponse(json)   → one answer per screenshot that was asked about, read strictly:
 *                                anything that is not exactly the expected shape is no answer
 *   estimateHaikuCost(n)       → the list-price estimate shown before a manual run
 *   haikuHeaders(key)          → the request headers (x-api-key, anthropic-version)
 *
 * Nothing here does I/O and nothing here reads a key from anywhere: the caller hands it in.
 *
 * The prompt content is Luna's (LUNA_INSTRUCTIONS, the same id / app / window line before each
 * picture) and so is the structured answer (LUNA_SCHEMA). What may be sent is decided by the shared
 * code in luna.ts (doubtful screenshots only, by screenshot file name); the privacy rules there hold
 * unchanged: a short per-request id, the app name and window title from the file name and the shrunk
 * picture go; content hashes and paths stay on this Mac.
 *
 * Why a forced tool call: Anthropic's docs say Claude Haiku 5.5 accepts
 * `tool_choice: {type: 'tool'}` and that a forced call skips thinking, so the reply is the tool call
 * alone (platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools, checked 2026-10-11).
 * The tool is not `strict`, so the API does not guarantee the input matches the schema; the parser
 * below checks every field itself and never clamps or repairs a value.
 */
import { clean, LUNA, LUNA_INSTRUCTIONS, LUNA_SCHEMA, LUNA_SCHEMA_NAME, LunaResponseError, type CostEstimate, type LunaAnswer, type LunaItem, type LunaParsed, type LunaRequest, type Verdict } from './luna'

/** Everything about the Haiku call in one place. */
export const HAIKU = {
  endpoint: 'https://api.anthropic.com/v1/messages',
  apiVersion: '2023-06-01',
  model: 'claude-haiku-5-5',
  /** Bump when the instructions or schema change: earlier answers are then asked again. */
  promptVersion: 'haiku-prompt-1',
  /** The same shrunk picture as Luna gets (images.ts shrinkForLuna). */
  longEdge: LUNA.longEdge,
  chunkSize: 15,
  concurrency: 2,
  timeoutMs: 120_000,
  maxAttempts: 4,
  maxOutputTokensPerItem: 160,
  /**
   * Inputs to the cost estimate. Prices: Anthropic's list prices for Claude Haiku 5.5, prompts up to
   * 100,000 tokens, from https://platform.claude.com/docs/en/about-claude/pricing (the page
   * docs.anthropic.com/en/docs/about-claude/pricing redirects to), checked 2026-10-11: base input
   * $0.10, output $0.50 per million tokens. A request here is about 25,000 tokens (15 pictures), far
   * below the 100,000-token line above which Haiku 5.5 costs five times as much. Token counts: a
   * picture costs ⌈width / 28⌉ × ⌈height / 28⌉ visual tokens (platform.claude.com/docs/en/build-with-claude/vision),
   * 1,560 for 1456 × 819, plus its id line; a request adds the 406-token tool-use system prompt for
   * a forced tool (pricing page, "Tool use pricing"), the instructions and the schema.
   */
  estimate: { tokensPerImage: 1600, tokensPerRequest: 850, outputTokensPerItem: 60, usdPerMillionInput: 0.1, usdPerMillionOutput: 0.5 }
} as const

/** The tool Haiku must answer through; its input is Luna's answer schema. */
export const HAIKU_TOOL_NAME = LUNA_SCHEMA_NAME
const HAIKU_TOOL_DESCRIPTION = 'Record one verdict for every screenshot id you were given. confidence is a number from 0 to 1.'

export function haikuHeaders(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': HAIKU.apiVersion }
}

/** One Messages API request for these items. Anything not doubtful is left out. */
export function buildHaikuRequest(items: LunaItem[]): LunaRequest {
  const sendable = items.filter((it) => it.proposal === 'doubtful')
  const ids = new Map<string, string>()
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: `${sendable.length} screenshot${sendable.length === 1 ? '' : 's'} follow, each after its id.` }]
  sendable.forEach((it, i) => {
    const id = `s${i + 1}`
    ids.set(id, it.hash)
    const facts = [`id: ${id}`]
    if (it.app) facts.push(`app: ${clean(it.app, 80)}`)
    if (it.windowTitle) facts.push(`window: ${clean(it.windowTitle, 160)}`)
    content.push({ type: 'text', text: facts.join(' · ') })
    content.push({ type: 'image', source: { type: 'base64', media_type: it.image.mime, data: it.image.base64 } })
  })
  return {
    ids,
    body: {
      model: HAIKU.model,
      max_tokens: Math.max(512, sendable.length * HAIKU.maxOutputTokensPerItem),
      system: LUNA_INSTRUCTIONS,
      messages: [{ role: 'user', content }],
      tools: [{ name: HAIKU_TOOL_NAME, description: HAIKU_TOOL_DESCRIPTION, input_schema: LUNA_SCHEMA }],
      tool_choice: { type: 'tool', name: HAIKU_TOOL_NAME }
    }
  }
}

const VERDICTS = new Set<Verdict>(['keep', 'throwaway', 'unsure'])
/** The only properties an entry may have (LUNA_SCHEMA's item properties). */
const ITEM_KEYS = new Set(['id', 'verdict', 'confidence', 'reason'])
const isObject = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
const malformed = (message: string): LunaResponseError => new LunaResponseError(message, 'malformed')

/**
 * Haiku's answers, keyed by content hash. Read strictly; nothing is repaired:
 *   - the body must be an assistant message that ended normally, holding exactly one call of the
 *     answer tool whose input is { items: [...] }; a refusal, a reply cut off at max_tokens, an error
 *     body, plain text instead of the tool call, or two tool calls throw LunaResponseError, and every
 *     screenshot in the request stays doubtful;
 *   - the input may hold `items` and nothing else, and every entry that is an object may hold `id`,
 *     `verdict`, `confidence` and `reason` and nothing else (the schema's additionalProperties: false,
 *     which the API does not enforce for a tool that is not strict); any other property anywhere
 *     throws LunaResponseError, and every screenshot in the request stays doubtful;
 *   - an entry counts only when its id is one that was asked (exactly), its verdict is one of the
 *     three, its confidence is a finite number from 0 to 1 (a 93 is not read as 0.93 or as 1) and its
 *     reason is a string; any other entry is no answer for that screenshot;
 *   - an id answered twice is no answer for that screenshot.
 */
export function parseHaikuResponse(body: unknown, ids: Map<string, string>): LunaParsed {
  if (!isObject(body)) throw malformed('Haiku sent no answer')
  if (body.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content)) throw malformed('Haiku’s reply was not an answer')
  if (body.stop_reason === 'refusal') throw new LunaResponseError('Haiku declined to answer', 'refusal')
  if (body.stop_reason === 'max_tokens' || body.stop_reason === 'model_context_window_exceeded') throw new LunaResponseError('Haiku stopped before finishing its answer', 'incomplete')
  if (body.stop_reason !== 'tool_use' && body.stop_reason !== 'end_turn') throw malformed('Haiku’s reply did not end as an answer')
  const calls = (body.content as unknown[]).filter((b): b is Record<string, unknown> => isObject(b) && b.type === 'tool_use')
  if (calls.length !== 1 || calls[0].name !== HAIKU_TOOL_NAME) throw malformed('Haiku did not answer in the expected form')
  const input = calls[0].input
  if (!isObject(input) || !Array.isArray(input.items)) throw malformed('Haiku’s answer had no items')
  const unexpected = Object.keys(input).some((k) => k !== 'items') || (input.items as unknown[]).some((it) => isObject(it) && Object.keys(it).some((k) => !ITEM_KEYS.has(k)))
  if (unexpected) throw malformed('Haiku’s answer held something that was not asked for')
  const answers = new Map<string, LunaAnswer>()
  const seen = new Set<string>()
  for (const raw of input.items as unknown[]) {
    if (!isObject(raw)) continue
    const hash = typeof raw.id === 'string' ? ids.get(raw.id) : undefined
    if (!hash) continue
    if (seen.has(hash)) {
      answers.delete(hash) // a second entry for the same id, usable or not: no answer
      continue
    }
    seen.add(hash)
    const verdict = typeof raw.verdict === 'string' && VERDICTS.has(raw.verdict as Verdict) ? (raw.verdict as Verdict) : null
    const c = raw.confidence
    if (!verdict || typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1 || typeof raw.reason !== 'string') continue
    answers.set(hash, { verdict, confidence: c, reason: clean(raw.reason) })
  }
  const u = isObject(body.usage) ? body.usage : null
  const usage = u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number' ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens } : null
  return { answers, missing: [...ids.values()].filter((h) => !answers.has(h)), usage }
}

/** What sending `n` screenshots would cost at list price, by HAIKU.estimate (an estimate, not a quote). */
export function estimateHaikuCost(n: number, chunkSize: number = HAIKU.chunkSize): CostEstimate {
  const screenshots = Math.max(0, Math.floor(n))
  const requests = screenshots ? Math.ceil(screenshots / Math.max(1, chunkSize)) : 0
  const e = HAIKU.estimate
  const inputTokens = screenshots * e.tokensPerImage + requests * e.tokensPerRequest
  const outputTokens = screenshots * e.outputTokensPerItem
  const usd = (inputTokens * e.usdPerMillionInput + outputTokens * e.usdPerMillionOutput) / 1_000_000
  return { screenshots, requests, inputTokens, outputTokens, usd }
}

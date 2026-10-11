// The Haiku provider module (ticket 16), pure part: what one Messages API request holds and how the
// answer is read. Synthetic bodies only (fixtures/haiku); nothing here makes a request.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHaikuRequest, estimateHaikuCost, HAIKU, HAIKU_TOOL_NAME, haikuHeaders, parseHaikuResponse } from '../src/main/sorter/cloud/haiku'
import { buildLunaRequest, LUNA, LUNA_INSTRUCTIONS, LUNA_SCHEMA, LunaResponseError, type LunaItem } from '../src/main/sorter/cloud/luna'

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'haiku', name), 'utf8'))

const img = { mime: 'image/jpeg', base64: 'AAAA' }
const item = (hash: string, proposal: LunaItem['proposal'], app = '', windowTitle = ''): LunaItem => ({ hash, proposal, app, windowTitle, image: img })
const ids = new Map([
  ['s1', 'hash-one'],
  ['s2', 'hash-two'],
  ['s3', 'hash-three']
])

type Part = { type: string; text?: string; source?: { type: string; media_type: string; data: string } }
const parts = (body: Record<string, unknown>): Part[] => (body.messages as Array<{ role: string; content: Part[] }>)[0].content
/** A well-formed reply whose tool input is `input`. */
const reply = (input: unknown, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'tool_use', id: 'toolu_synthetic', name: HAIKU_TOOL_NAME, input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 5 },
  ...patch
})
const ok = (id: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id, verdict: 'keep', confidence: 0.9, reason: 'A chart.', ...patch })

describe('Haiku request: the Messages API body', () => {
  const req = buildHaikuRequest([item('hash-one', 'doubtful', 'Test Browser', 'A page\nsecond line'), item('hash-keep', 'keep'), item('hash-two', 'doubtful')])
  const body = req.body

  it('goes to the Messages endpoint with the key in x-api-key and the API version header', () => {
    expect(HAIKU.endpoint).toBe('https://api.anthropic.com/v1/messages')
    expect(haikuHeaders('sk-ant-api03-SYNTHETIC')).toEqual({ 'Content-Type': 'application/json', 'x-api-key': 'sk-ant-api03-SYNTHETIC', 'anthropic-version': '2023-06-01' })
    expect(JSON.stringify(body)).not.toContain('sk-ant') // the key is a header, never part of the body
  })

  it('names the model, gives a token limit and forces the one answer tool with Luna’s answer schema', () => {
    expect(body.model).toBe('claude-haiku-5-5')
    expect(body.max_tokens).toBeGreaterThanOrEqual(512)
    expect(body.tools).toEqual([{ name: 'screenshot_verdicts', description: expect.any(String), input_schema: LUNA_SCHEMA }])
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'screenshot_verdicts' })
  })

  it('carries the same instructions as Luna, and the same id, app and window lines', () => {
    expect(body.system).toBe(LUNA_INSTRUCTIONS)
    const texts = parts(body).filter((p) => p.type === 'text').map((p) => p.text)
    const lunaTexts = ((buildLunaRequest([item('hash-one', 'doubtful', 'Test Browser', 'A page\nsecond line'), item('hash-two', 'doubtful')]).body.input as Array<{ content: Array<{ type: string; text?: string }> }>)[0].content)
      .filter((p) => p.type === 'input_text')
      .map((p) => p.text)
    expect(texts).toEqual(lunaTexts)
    expect(texts).toEqual(['2 screenshots follow, each after its id.', 'id: s1 · app: Test Browser · window: A page second line', 'id: s2'])
  })

  it('sends each doubtful picture as a base64 image block, and nothing that is not doubtful', () => {
    const images = parts(body).filter((p) => p.type === 'image')
    expect(images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }
    ])
    expect([...req.ids.entries()]).toEqual([
      ['s1', 'hash-one'],
      ['s2', 'hash-two']
    ])
  })

  it('never sends a content hash, and sends nothing when nothing is doubtful', () => {
    expect(JSON.stringify(body)).not.toMatch(/hash-(one|two|keep)/)
    const none = buildHaikuRequest([item('hk', 'keep'), item('ht', 'throwaway')])
    expect(none.ids.size).toBe(0)
    expect(parts(none.body).filter((p) => p.type === 'image')).toHaveLength(0)
  })

  it('shrinks to the same long edge as Luna and asks in the same chunk size', () => {
    expect(HAIKU.longEdge).toBe(LUNA.longEdge)
    expect(HAIKU.chunkSize).toBe(LUNA.chunkSize)
  })
})

describe('Haiku answer: read strictly', () => {
  it('reads one answer per asked id from the tool call; an id that was not asked is dropped', () => {
    const p = parseHaikuResponse(fixture('messages-tool-use.json'), ids)
    expect([...p.answers.entries()]).toEqual([
      ['hash-one', { verdict: 'keep', confidence: 0.91, reason: 'A chart from a talk, worth keeping for slides.' }],
      ['hash-two', { verdict: 'throwaway', confidence: 0.96, reason: 'A Wi-Fi settings pane.' }],
      ['hash-three', { verdict: 'unsure', confidence: 0.5, reason: 'A half-loaded page.' }]
    ])
    expect(p.missing).toEqual([])
    expect(p.usage).toEqual({ inputTokens: 5312, outputTokens: 148 })
  })

  it('a refusal, a reply cut off at the token limit and an error body give no decision at all', () => {
    for (const [name, kind] of [
      ['messages-refusal.json', 'refusal'],
      ['messages-max-tokens.json', 'incomplete'],
      ['error-401.json', 'malformed']
    ] as const) {
      const e = (() => {
        try {
          parseHaikuResponse(fixture(name), ids)
          return null
        } catch (x) {
          return x
        }
      })()
      expect(e, name).toBeInstanceOf(LunaResponseError)
      expect((e as LunaResponseError).kind, name).toBe(kind)
    }
  })

  it('anything that is not exactly one call of the answer tool gives no decision', () => {
    const bad: unknown[] = [
      null,
      'a string',
      [],
      {},
      reply({ items: [ok('s1')] }, { type: 'error' }),
      reply({ items: [ok('s1')] }, { role: 'user' }),
      reply({ items: [ok('s1')] }, { stop_reason: 'pause_turn' }),
      reply({ items: [ok('s1')] }, { stop_reason: undefined }),
      reply({ items: [ok('s1')] }, { content: 'not a list' }),
      // the verdicts as prose or as JSON in a text block are not the answer tool
      reply(null, { content: [{ type: 'text', text: JSON.stringify({ items: [ok('s1')] }) }], stop_reason: 'end_turn' }),
      // another tool, or the tool called twice
      reply(null, { content: [{ type: 'tool_use', id: 't', name: 'some_other_tool', input: { items: [ok('s1')] } }] }),
      reply(null, { content: [{ type: 'tool_use', id: 't1', name: HAIKU_TOOL_NAME, input: { items: [ok('s1')] } }, { type: 'tool_use', id: 't2', name: HAIKU_TOOL_NAME, input: { items: [ok('s2')] } }] }),
      // the input is not { items: [...] }
      reply('{"items":[]}'),
      reply({ items: 'none' }),
      reply([ok('s1')]),
      reply({ verdicts: [ok('s1')] })
    ]
    for (const body of bad) expect(() => parseHaikuResponse(body, ids), JSON.stringify(body)).toThrow(LunaResponseError)
  })

  it('an entry that is not exactly right is no answer for that screenshot; nothing is repaired', () => {
    const entries: unknown[] = [
      ok('s1', { verdict: 'delete' }),
      ok('s1', { verdict: 'Keep' }),
      ok('s1', { confidence: '0.9' }),
      ok('s1', { confidence: 93 }), // a percentage is not read as 0.93, nor as 1
      ok('s1', { confidence: 1.01 }),
      ok('s1', { confidence: -0.1 }),
      ok('s1', { confidence: Number.NaN }),
      ok('s1', { confidence: null }),
      ok('s1', { reason: 7 }),
      ok('s1', { reason: undefined }),
      ok(' s1'), // the id must be the one given, exactly
      ok('S1'),
      { verdict: 'keep', confidence: 0.9, reason: 'no id' },
      'keep',
      null,
      [ok('s1')]
    ]
    for (const entry of entries) {
      const p = parseHaikuResponse(reply({ items: [entry, ok('s2')] }), ids)
      expect([...p.answers.keys()], JSON.stringify(entry)).toEqual(['hash-two'])
      expect(p.missing).toEqual(['hash-one', 'hash-three'])
    }
  })

  it('a throwaway with an out-of-range confidence can never become a confident throwaway', () => {
    const p = parseHaikuResponse(reply({ items: [{ id: 's1', verdict: 'throwaway', confidence: 97, reason: 'A settings pane.' }] }), ids)
    expect(p.answers.size).toBe(0)
  })

  it('an id answered twice is no answer for it, whichever entry was usable', () => {
    for (const pair of [
      [ok('s1'), ok('s1', { verdict: 'throwaway', confidence: 0.99 })],
      [ok('s1', { confidence: 'x' }), ok('s1')],
      [ok('s1'), ok('s1'), ok('s1')]
    ]) {
      const p = parseHaikuResponse(reply({ items: [...pair, ok('s2')] }), ids)
      expect([...p.answers.keys()]).toEqual(['hash-two'])
    }
  })

  it('a reason is one line with no control characters; missing usage is null', () => {
    const p = parseHaikuResponse(reply({ items: [ok('s1', { reason: 'line one\nline\u0000two  ' })] }, { usage: undefined }), ids)
    expect(p.answers.get('hash-one')?.reason).toBe('line one line two')
    expect(p.usage).toBeNull()
  })
})

describe('Haiku cost estimate at list price', () => {
  it('uses the list prices and stays under the 100,000-token line per request', () => {
    expect(HAIKU.estimate.usdPerMillionInput).toBe(0.1)
    expect(HAIKU.estimate.usdPerMillionOutput).toBe(0.5)
    const perRequest = HAIKU.chunkSize * HAIKU.estimate.tokensPerImage + HAIKU.estimate.tokensPerRequest
    expect(perRequest).toBeLessThan(100_000) // above it Haiku 5.5 costs five times as much
  })

  it('counts requests, tokens and dollars for a batch', () => {
    expect(estimateHaikuCost(0)).toEqual({ screenshots: 0, requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 })
    const e = estimateHaikuCost(300)
    expect(e).toMatchObject({ screenshots: 300, requests: 20, inputTokens: 300 * 1600 + 20 * 850, outputTokens: 300 * 60 })
    expect(e.usd).toBeCloseTo((497_000 * 0.1 + 18_000 * 0.5) / 1_000_000, 10)
    expect(e.usd).toBeLessThan(0.1)
  })
})

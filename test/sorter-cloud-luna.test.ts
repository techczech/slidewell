import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLunaRequest, estimateCost, isScreenshotFile, LUNA, LUNA_SCHEMA, LunaResponseError, parseLunaResponse, planChunks, selectForCloud, type CloudCandidate, type LunaItem } from '../src/main/sorter/cloud/luna'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'luna', name), 'utf8'))

const img = { mime: 'image/jpeg', base64: 'AAAA' }
const item = (hash: string, proposal: LunaItem['proposal'], app = '', windowTitle = ''): LunaItem => ({ hash, proposal, app, windowTitle, image: img })
const cand = (hash: string, proposal: CloudCandidate['proposal'], takenAt = '', filename = `CleanShot 2026-10-01 at 10.00.00 from Test App with ${hash}.png`): CloudCandidate => ({ hash, proposal, path: `/pics/${hash}.png`, filename, app: '', windowTitle: '', takenAt })

type Part = { type: string; text?: string; image_url?: string; detail?: string }
const parts = (body: Record<string, unknown>): Part[] => (body.input as Array<{ content: Part[] }>)[0].content

describe('request builder: only doubtful screenshots are sent', () => {
  it('drops keep and throwaway proposals and sends one picture per doubtful one', () => {
    const req = buildLunaRequest([item('hk', 'keep'), item('hd1', 'doubtful'), item('ht', 'throwaway'), item('hd2', 'doubtful')])
    const images = parts(req.body).filter((p) => p.type === 'input_image')
    expect(images).toHaveLength(2)
    expect([...req.ids.values()]).toEqual(['hd1', 'hd2'])
    expect([...req.ids.keys()]).toEqual(['s1', 's2'])
  })

  it('sends nothing when nothing is doubtful', () => {
    const req = buildLunaRequest([item('hk', 'keep'), item('ht', 'throwaway')])
    expect(req.ids.size).toBe(0)
    expect(parts(req.body).filter((p) => p.type === 'input_image')).toHaveLength(0)
  })

  it('planChunks and selectForCloud keep only doubtful ones too', () => {
    const mixed = [cand('a', 'keep'), cand('b', 'doubtful', '2026-10-01T09:00:00'), cand('c', 'throwaway'), cand('d', 'doubtful', '2026-10-02T09:00:00')]
    expect(planChunks(mixed, 15).flat().map((c) => c.hash)).toEqual(['b', 'd'])
    expect(selectForCloud(mixed, 10).map((c) => c.hash)).toEqual(['d', 'b']) // newest first
    expect(selectForCloud(mixed, 1).map((c) => c.hash)).toEqual(['d']) // capped
    expect(selectForCloud(mixed, 0)).toEqual([])
  })

  it('selectForCloud keeps screenshots only: a CleanShot or macOS screenshot name', () => {
    expect(isScreenshotFile('CleanShot 2026-10-08 at 0801 from Test App with Some Window.png')).toBe(true)
    expect(isScreenshotFile('Screenshot 2026-10-08 at 10.05.01.png')).toBe(true)
    expect(isScreenshotFile('IMG_0042.jpg')).toBe(false)
    expect(isScreenshotFile('holiday photo.png')).toBe(false)
    const mixed = [cand('shot', 'doubtful', '2026-10-02T09:00:00'), cand('photo', 'doubtful', '2026-10-03T09:00:00', 'IMG_0042.jpg'), cand('blank', 'doubtful', '2026-10-04T09:00:00', '')]
    expect(selectForCloud(mixed, 10).map((c) => c.hash)).toEqual(['shot'])
  })

  it('chunks at the chunk size', () => {
    const many = Array.from({ length: 32 }, (_, i) => cand(`h${i}`, 'doubtful'))
    expect(planChunks(many, LUNA.chunkSize).map((c) => c.length)).toEqual([15, 15, 2])
  })
})

describe('request builder: the Responses API body', () => {
  const req = buildLunaRequest([item('hash-one', 'doubtful', 'Google Chrome', 'ChatGPT\nsecond line'), item('hash-two', 'doubtful')])
  const body = req.body

  it('names the model, asks for strict JSON-schema output and not to store the response', () => {
    expect(body.model).toBe('gpt-6-luna')
    expect(body.store).toBe(false)
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'screenshot_verdicts', strict: true, schema: LUNA_SCHEMA } })
    expect(typeof body.instructions).toBe('string')
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(256)
  })

  it('sends each picture as a base64 data URL after a line with its short id, app and window', () => {
    const p = parts(body)
    expect(p[1]).toEqual({ type: 'input_text', text: 'id: s1 · app: Google Chrome · window: ChatGPT second line' })
    expect(p[2]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA', detail: 'high' })
    expect(p[3]).toEqual({ type: 'input_text', text: 'id: s2' })
  })

  it('carries no content hash and no path', () => {
    const json = JSON.stringify(body)
    expect(json).not.toContain('hash-one')
    expect(json).not.toContain('hash-two')
    expect(json).not.toContain('/pics/')
  })
})

describe('response parser (recorded-shape fixtures)', () => {
  const ids = new Map([
    ['s1', 'h1'],
    ['s2', 'h2'],
    ['s3', 'h3'],
    ['s4', 'h4'],
    ['s5', 'h5']
  ])

  it('maps answers back to hashes, ignores ids it never asked about, lists the unanswered', () => {
    const r = parseLunaResponse(fixture('responses-completed.json'), ids)
    expect(r.answers.get('h1')).toEqual({ verdict: 'keep', confidence: 0.93, reason: 'A chart comparing model costs, useful for a slide.' })
    expect(r.answers.get('h2')?.verdict).toBe('throwaway')
    expect(r.answers.get('h4')?.verdict).toBe('unsure')
    expect(r.answers.size).toBe(4)
    expect(r.missing).toEqual(['h5'])
    expect(r.usage).toEqual({ inputTokens: 5120, outputTokens: 180 })
  })

  it('a refusal, a cut-off answer and a body with no text throw a LunaResponseError', () => {
    expect(() => parseLunaResponse(fixture('responses-refusal.json'), ids)).toThrow(LunaResponseError)
    try {
      parseLunaResponse(fixture('responses-incomplete.json'), ids)
    } catch (e) {
      expect((e as LunaResponseError).kind).toBe('incomplete')
    }
    expect(() => parseLunaResponse({ status: 'completed', output: [] }, ids)).toThrow(/no answer text/)
    expect(() => parseLunaResponse(null, ids)).toThrow(LunaResponseError)
  })

  it('skips malformed entries, clamps confidence, cleans the reason', () => {
    const text = JSON.stringify({
      items: [
        { id: 's1', verdict: 'maybe', confidence: 0.9, reason: 'bad verdict' },
        { id: 's2', verdict: 'keep', confidence: 'high', reason: 'bad confidence' },
        { id: 's3', verdict: 'throwaway', confidence: 1.7, reason: 'line one\nline two\u0007' },
        { id: 's3', verdict: 'keep', confidence: 0.2, reason: 'a second answer for s3 is ignored' }
      ]
    })
    const r = parseLunaResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }, ids)
    expect([...r.answers.keys()]).toEqual(['h3'])
    expect(r.answers.get('h3')).toEqual({ verdict: 'throwaway', confidence: 1, reason: 'line one line two' })
  })
})

describe('cost estimate', () => {
  it('counts requests by chunk and tokens per picture', () => {
    const e = estimateCost(31, 15)
    expect(e.requests).toBe(3)
    expect(e.inputTokens).toBe(31 * LUNA.estimate.tokensPerImage + 3 * LUNA.estimate.tokensPerRequest)
    expect(e.outputTokens).toBe(31 * LUNA.estimate.outputTokensPerItem)
    expect(e.usd).toBeCloseTo((e.inputTokens * LUNA.estimate.usdPerMillionInput + e.outputTokens * LUNA.estimate.usdPerMillionOutput) / 1e6, 10)
    expect(estimateCost(0)).toMatchObject({ requests: 0, usd: 0 })
    // gpt-6-luna list prices per million tokens (short context), checked 2026-10-11
    expect(LUNA.estimate).toMatchObject({ usdPerMillionInput: 0.1, usdPerMillionCachedInput: 0.01, usdPerMillionOutput: 0.5 })
  })
})

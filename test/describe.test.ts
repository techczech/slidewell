import { describe, it, expect } from 'vitest'
import {
  resolveDescribeSettings,
  buildDescribePrompt,
  buildDescribeBody,
  parseDescribeResponse,
  chooseModel,
  setSidecarField,
  createDescribeRunner
} from '../src/main/describe'

describe('resolveDescribeSettings', () => {
  it('defaults to LM Studio, enabled, auto model', () => {
    expect(resolveDescribeSettings(undefined)).toEqual({ enabled: true, endpoint: 'http://localhost:1234/v1', model: '' })
  })
  it('keeps explicit values and trims a trailing slash', () => {
    expect(resolveDescribeSettings({ enabled: false, endpoint: 'http://localhost:11434/v1/', model: ' qwen2.5vl ' })).toEqual({
      enabled: false,
      endpoint: 'http://localhost:11434/v1',
      model: 'qwen2.5vl'
    })
  })
})

describe('prompt + body', () => {
  it('passes OCR as context, truncated', () => {
    const p = buildDescribePrompt('x'.repeat(5000))
    expect(p).toContain('OCR text, for context')
    expect(p.length).toBeLessThan(2500)
  })
  it('says when OCR found nothing', () => {
    expect(buildDescribePrompt('')).toContain('OCR found no text')
  })
  it('builds an OpenAI-style vision message', () => {
    const b = buildDescribeBody('m', 'data:image/jpeg;base64,AAA', 'hi') as { model: string; messages: Array<{ content: Array<{ type: string }> }> }
    expect(b.model).toBe('m')
    expect(b.messages[0].content.map((c) => c.type)).toEqual(['text', 'image_url'])
  })
})

describe('parseDescribeResponse', () => {
  it('extracts content, strips reasoning and a leading label, collapses whitespace', () => {
    const json = { choices: [{ message: { content: '<think>hmm\nok</think>\nDescription:  A bar chart\n in Keynote.' } }] }
    expect(parseDescribeResponse(json)).toBe('A bar chart in Keynote.')
  })
  it('handles content given as parts', () => {
    expect(parseDescribeResponse({ choices: [{ message: { content: [{ type: 'text', text: 'A slide.' }] } }] })).toBe('A slide.')
  })
  it('returns empty string on malformed responses', () => {
    expect(parseDescribeResponse({})).toBe('')
    expect(parseDescribeResponse(null)).toBe('')
  })
})

describe('chooseModel', () => {
  it('prefers a vision model and skips embedding models', () => {
    expect(chooseModel(['text-embedding-nomic', 'llama-3.2-3b', 'qwen2.5-vl-7b-instruct'])).toBe('qwen2.5-vl-7b-instruct')
  })
  it('falls back to the first non-embedding model', () => {
    expect(chooseModel(['text-embedding-x', 'mistral-7b'])).toBe('mistral-7b')
  })
  it('returns null when nothing is usable', () => {
    expect(chooseModel(['text-embedding-x'])).toBeNull()
  })
})

describe('setSidecarField', () => {
  const yml = 'id: abc1234\nalt: ""\nnotes: ""\n'
  it('appends a missing key with YAML-safe quoting', () => {
    expect(setSidecarField(yml, 'description', 'A "quoted" chart: sales')).toBe(yml + 'description: "A \\"quoted\\" chart: sales"\n')
  })
  it('replaces an existing key in place', () => {
    const once = setSidecarField(yml, 'description', 'first')
    expect(setSidecarField(once, 'description', 'second $& literal')).toBe(yml + 'description: "second $& literal"\n')
  })
})

describe('createDescribeRunner', () => {
  it('skips cleanly when disabled', async () => {
    const r = createDescribeRunner({
      settings: () => ({ enabled: false, endpoint: 'http://x', model: 'm' }),
      pending: async () => [],
      save: async () => undefined
    })
    expect(await r.run()).toEqual({ described: 0, failed: 0, skipped: 'disabled' })
  })
  it('reports an unreachable server without throwing', async () => {
    const r = createDescribeRunner({
      settings: () => ({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', model: '' }),
      pending: async () => [],
      save: async () => undefined
    })
    const res = await r.run()
    expect(res.skipped).toMatch(/no server/)
  })
  it('coalesces overlapping calls into one run', async () => {
    let passes = 0
    const r = createDescribeRunner({
      settings: () => ({ enabled: true, endpoint: 'http://x', model: 'm' }),
      pending: async () => {
        passes++
        await new Promise((res) => setTimeout(res, 20))
        return []
      },
      save: async () => undefined
    })
    const a = r.run()
    const b = r.run() // during the first pass → flags one more pass, same promise
    expect(b).toBe(a)
    await a
    expect(passes).toBe(2)
    expect(r.running()).toBe(false)
  })
})

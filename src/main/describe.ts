/**
 * Local-LLM descriptions for well images, on top of OCR. OCR only finds a screenshot by the words
 * in it; a description ("bar chart of survey results in a Keynote window") makes diagrams, photos
 * and UI findable too. Runs against any OpenAI-compatible local server — LM Studio by default
 * (http://localhost:1234/v1), Ollama works at http://localhost:11434/v1 — so images never leave the
 * machine. Best-effort: if the server is off, images simply stay undescribed and are picked up on a
 * later pass ("describe missing" is idempotent).
 *
 * Pure helpers (settings, prompt, request body, response parsing, sidecar edit) are exported for
 * unit tests; the IO is describeImage + describeMissing.
 */
import sharp from 'sharp'

export type DescribeSettings = { enabled: boolean; endpoint: string; model: string }

export const DESCRIBE_DEFAULTS: DescribeSettings = { enabled: true, endpoint: 'http://localhost:1234/v1', model: '' }

export function resolveDescribeSettings(cfg?: Partial<DescribeSettings> | null): DescribeSettings {
  const endpoint = (cfg?.endpoint || DESCRIBE_DEFAULTS.endpoint).trim().replace(/\/+$/, '')
  return {
    enabled: cfg?.enabled ?? DESCRIBE_DEFAULTS.enabled,
    endpoint,
    model: (cfg?.model ?? '').trim()
  }
}

export function buildDescribePrompt(ocr: string): string {
  const text = (ocr || '').trim().slice(0, 1500)
  return [
    'You are indexing a screenshot so it can be found later by search.',
    'Describe in 2–4 plain sentences what it shows: the app or website if recognisable, the kind of content',
    '(chart, diagram, slide, chat, code, document, photo, interface), its main subject, and notable visual elements.',
    'Do not transcribe the text word for word — it has already been captured by OCR. Output only the description.',
    text ? `\nOCR text, for context:\n${text}` : '\n(OCR found no text in this image.)'
  ].join(' ')
}

export function buildDescribeBody(model: string, imageDataUrl: string, ocr: string): Record<string, unknown> {
  return {
    model,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildDescribePrompt(ocr) },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }
    ]
  }
}

/** Extract the description from a chat-completions response ('' when absent). Strips reasoning blocks. */
export function parseDescribeResponse(json: unknown): string {
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
  const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string })?.text ?? '').join('') : ''
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*(description|here is (a|the) description)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pick a model from an OpenAI-style /models list: prefer a vision-capable name, skip embedding models. */
export function chooseModel(ids: string[]): string | null {
  const usable = ids.filter((id) => !/embed/i.test(id))
  const vision = usable.find((id) => /(-vl|vl-|vision|llava|pixtral|moondream|gemma-?3|minicpm-v|smolvlm)/i.test(id))
  return vision ?? usable[0] ?? null
}

/** Set (or append) `key: "value"` in a flat YAML sidecar. JSON quoting is valid YAML double-quoted. */
export function setSidecarField(yml: string, key: string, value: string): string {
  const line = `${key}: ${JSON.stringify(value)}`
  const re = new RegExp(`^${key}:.*$`, 'm')
  if (re.test(yml)) return yml.replace(re, () => line)
  return (yml.endsWith('\n') || yml === '' ? yml : `${yml}\n`) + `${line}\n`
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

/** List the server's models; throws when the server is unreachable. */
export async function listModels(endpoint: string): Promise<string[]> {
  const json = (await fetchJson(`${endpoint}/models`, {}, 4000)) as { data?: Array<{ id?: string }> }
  return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean)
}

/** Resolve the model to use: the configured one, else the best guess from the server's list. */
export async function resolveModel(s: DescribeSettings): Promise<string | null> {
  if (s.model) return s.model
  return chooseModel(await listModels(s.endpoint))
}

/** Describe one image. Returns null on any failure (server off, model error, empty answer). */
export async function describeImage(s: DescribeSettings, model: string, absPath: string, ocr: string): Promise<string | null> {
  try {
    // Downscale: local vision models are slow on full-resolution Retina screenshots and gain little.
    const jpeg = await sharp(absPath).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
    const body = buildDescribeBody(model, `data:image/jpeg;base64,${jpeg.toString('base64')}`, ocr)
    const json = await fetchJson(
      `${s.endpoint}/chat/completions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      180000 // first call may wait for the server to load the model
    )
    const text = parseDescribeResponse(json)
    return text || null
  } catch (e) {
    console.error(`[describe] ${absPath}: ${(e as Error).message}`)
    return null
  }
}

export type DescribeTarget = { id: string; absPath: string; ocr: string }
export type DescribeRunResult = { described: number; failed: number; skipped: string | null }

/**
 * Describe every pending image, one at a time (a local model handles one request well; parallel
 * calls just queue on the server). Calls made while a run is in progress set a flag so the running
 * pass loops once more instead of starting a second, overlapping run.
 */
export function createDescribeRunner(deps: {
  settings: () => DescribeSettings
  pending: () => Promise<DescribeTarget[]>
  save: (id: string, description: string) => Promise<void>
}): { run: () => Promise<DescribeRunResult>; running: () => boolean } {
  let active: Promise<DescribeRunResult> | null = null
  let again = false
  const failedThisSession = new Set<string>()

  const pass = async (): Promise<DescribeRunResult> => {
    const s = deps.settings()
    if (!s.enabled) return { described: 0, failed: 0, skipped: 'disabled' }
    let model: string | null
    try {
      model = await resolveModel(s)
    } catch {
      return { described: 0, failed: 0, skipped: `no server at ${s.endpoint}` }
    }
    if (!model) return { described: 0, failed: 0, skipped: 'server has no model loaded' }
    let described = 0
    let failed = 0
    for (const t of await deps.pending()) {
      if (failedThisSession.has(t.id)) continue
      const d = await describeImage(s, model, t.absPath, t.ocr)
      if (d) {
        await deps.save(t.id, d)
        described++
      } else {
        failedThisSession.add(t.id) // don't hammer a failing image every pass; retried next launch
        failed++
      }
    }
    return { described, failed, skipped: null }
  }

  const run = (): Promise<DescribeRunResult> => {
    if (active) {
      again = true
      return active
    }
    active = (async () => {
      const total: DescribeRunResult = { described: 0, failed: 0, skipped: null }
      do {
        again = false
        const r = await pass()
        total.described += r.described
        total.failed += r.failed
        total.skipped = r.skipped
      } while (again)
      return total
    })().finally(() => {
      active = null
    })
    return active
  }

  return { run, running: () => active !== null }
}

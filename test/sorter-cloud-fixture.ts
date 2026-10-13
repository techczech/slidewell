// Shared fixture for the sorter cloud-step tests: a scratch well whose triage.db holds screenshots
// (real small PNGs) with sorter proposals, transports that answer like Luna and like Haiku, and fake
// deps. Nothing here touches the network; every key is made up.
// Each shot has a short test name ('d1'); its content hash is the real hash of its bytes (hashOf),
// because the cloud step re-hashes a file before sending it. File names are invented CleanShot names
// unless a shot gives its own.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { SorterStore, type ProposalRow } from '../src/main/sorter/store'
import { SORTER_VERSION } from '../src/main/sorter/decide'
import type { HttpPost } from '../src/main/sorter/cloud/client'
import type { CloudDeps, CloudSettings, CloudState, ConsentPrompt, KeyAccess } from '../src/main/sorter/cloud/service'
import { contentHash } from '../src/main/sorter/cloud/images'

// a 1×1 PNG; the tests' shrink stub never decodes it
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex')

export type ShotSpec = { hash: string; proposal: ProposalRow['proposal']; window?: string; takenAt?: string; decided?: string; answered?: boolean; offline?: boolean; filename?: string }

/** The bytes written for a shot: the PNG plus its name, so every shot hashes differently. */
export const bytesOf = (name: string): Buffer => Buffer.concat([PNG, Buffer.from(name)])
/** The content hash of a shot's file (as triage.ts records it). */
export const hashOf = (name: string): string => contentHash(bytesOf(name))
/** The file path of a shot inside its well. */
export const relOf = (s: ShotSpec): string => join(s.hash, s.filename ?? `CleanShot 2026-10-01 at 10.00.00 from Test App with ${s.window ?? s.hash}.png`)

export function makeCloudWell(shots: ShotSpec[]): string {
  const well = mkdtempSync(join(tmpdir(), 'sw-sorter-cloud-'))
  const src = join(well, 'source')
  mkdirSync(src, { recursive: true })
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);`)
  const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', ?, '', ?, ?, 'Test App', ?)")
  const dec = t.prepare('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)')
  for (const s of shots) {
    const rel = relOf(s)
    mkdirSync(dirname(join(src, rel)), { recursive: true })
    writeFileSync(join(src, rel), bytesOf(s.hash))
    row.run(hashOf(s.hash), rel, rel.slice(rel.lastIndexOf('/') + 1), s.offline ? '1' : '0', src, s.takenAt ?? '', s.window ?? s.hash)
    if (s.decided) dec.run(hashOf(s.hash), s.decided, '2026-10-01')
  }
  t.close()
  const st = new SorterStore(well)
  st.writeProposals(
    shots.map((s) => ({ hash: hashOf(s.hash), proposal: s.proposal, confidence: 0.6, pKeep: s.proposal === 'keep' ? 0.9 : 0.4, reason: `local reason for ${s.hash}`, rule: null, decidedBy: s.proposal === 'doubtful' ? null : 'history' })),
    SORTER_VERSION,
    'model-test'
  )
  for (const s of shots) if (s.answered) st.setAnswer(hashOf(s.hash), { answer: 'keep', answeredAt: '2026-10-02' })
  st.close()
  return well
}

/** Source folder of a fixture well (files are at join(sourceOf(well), relOf(shot))). */
export const sourceOf = (well: string): string => join(well, 'source')

export function readProposal(well: string, name: string): { proposal: string; decided_by: string | null; decided_model: string | null; reason: string; throwaway_since: string | null } | undefined {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return db.prepare('SELECT proposal, decided_by, decided_model, reason, throwaway_since FROM sorter_proposals WHERE hash = ?').get(hashOf(name)) as never
  } finally {
    db.close()
  }
}

type Part = { type: string; text?: string; image_url?: string }
export type SeenRequest = { windows: string[]; images: number; headers: Record<string, string>; body: string; url: string }

/** What a stub answers for a window title, when a test gives a stub its own answers (ticket 17: the two providers may disagree). */
export type Says = (window: string) => { verdict: string; confidence: number; reason: string }
export type StubOpts = { delayMs?: number; says?: Says }

/** The verdict both stubs give for a window title, unless the stub has its own `says`. */
function verdictFor(id: string, w: string, says?: Says): { id: string; verdict: string; confidence: number; reason: string } {
  if (says) return { id, ...says(w) }
  if (w.startsWith('keep')) return { id, verdict: 'keep', confidence: 0.93, reason: 'A chart worth keeping.' }
  if (w.startsWith('toss')) return { id, verdict: 'throwaway', confidence: 0.97, reason: 'A settings pane.' }
  if (w.startsWith('weak')) return { id, verdict: 'throwaway', confidence: 0.7, reason: 'Probably a file picker.' }
  return { id, verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.' }
}

/**
 * Answers like Luna: the verdict comes from the window title sent beside each picture
 * ('keep…' keep 0.93, 'toss…' throwaway 0.97, 'weak…' throwaway 0.7, anything else unsure).
 */
export function lunaStub(opts: StubOpts = {}): { http: HttpPost; seen: SeenRequest[]; peak: () => number } {
  const seen: SeenRequest[] = []
  let inFlight = 0
  let peak = 0
  const http: HttpPost = async (url, init) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const body = JSON.parse(init.body) as { input: Array<{ content: Part[] }> }
      const parts = body.input[0].content
      const lines = parts.filter((p) => p.type === 'input_text' && p.text?.startsWith('id: ')).map((p) => p.text as string)
      const windows = lines.map((l) => /window: ([^·]+)/.exec(l)?.[1].trim() ?? '')
      seen.push({ windows, images: parts.filter((p) => p.type === 'input_image').length, headers: init.headers, body: init.body, url })
      const items = lines.map((l, i) => verdictFor(/^id: (s\d+)/.exec(l)![1], windows[i], opts.says))
      const text = JSON.stringify({ items })
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }) }
    } finally {
      inFlight--
    }
  }
  return { http, seen, peak: () => peak }
}

type HaikuPart = { type: string; text?: string; source?: { type: string; media_type: string; data: string } }

/**
 * Answers like Haiku on the Messages API: one forced tool call whose input holds the verdicts, by the
 * same window-title rule as lunaStub.
 */
export function haikuStub(opts: StubOpts = {}): { http: HttpPost; seen: SeenRequest[] } {
  const seen: SeenRequest[] = []
  const http: HttpPost = async (url, init) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    const body = JSON.parse(init.body) as { messages: Array<{ content: HaikuPart[] }>; tools: Array<{ name: string }> }
    const parts = body.messages[0].content
    const lines = parts.filter((p) => p.type === 'text' && p.text?.startsWith('id: ')).map((p) => p.text as string)
    const windows = lines.map((l) => /window: ([^·]+)/.exec(l)?.[1].trim() ?? '')
    seen.push({ windows, images: parts.filter((p) => p.type === 'image').length, headers: init.headers, body: init.body, url })
    const items = lines.map((l, i) => verdictFor(/^id: (s\d+)/.exec(l)![1], windows[i], opts.says))
    const reply = { id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_synthetic', name: body.tools[0].name, input: { items } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } }
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(reply) }
  }
  return { http, seen }
}

export const OPENAI_URL = 'https://api.openai.com/v1/responses'
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
/** Made-up keys in each provider's shape. */
export const FAKE_OPENAI_KEY = 'sk-test-FAKEKEY0123456789abcdefWXYZ'
export const FAKE_ANTHROPIC_KEY = 'sk-ant-api03-FAKEKEY0123456789abcdefWXYZ-synthetic'

/**
 * One transport for both providers: each stub answers only at its own provider's address; any other
 * address fails the test. `lunaSays` / `haikuSays` give one of them its own answers.
 */
export function bothStubs(opts: { delayMs?: number; lunaSays?: Says; haikuSays?: Says } = {}): { http: HttpPost; luna: ReturnType<typeof lunaStub>; haiku: ReturnType<typeof haikuStub>; urls: string[] } {
  const luna = lunaStub({ delayMs: opts.delayMs, says: opts.lunaSays })
  const haiku = haikuStub({ delayMs: opts.delayMs, says: opts.haikuSays })
  const urls: string[] = []
  const http: HttpPost = async (url, init) => {
    urls.push(url)
    if (url === OPENAI_URL) return luna.http(url, init)
    if (url === ANTHROPIC_URL) return haiku.http(url, init)
    throw new Error(`unexpected address in a test: ${url}`)
  }
  return { http, luna, haiku, urls }
}

const access = (read: () => string | null): KeyAccess => ({ get: read, has: () => Boolean(read()), encryptionAvailable: () => true })

/**
 * Fake deps. `confirmAnswer` is what main's native dialog returns (default: he confirms); every
 * dialog shown is recorded in `prompts`. `key` / `keyValue` are the OpenAI key (as in the tests
 * written when there was one provider), `anthropicKey` / `anthropicKeyValue` the Anthropic one; the
 * default transport answers for whichever provider's address is called.
 */
export function cloudDeps(
  well: string,
  extra: Partial<CloudDeps> & { key?: KeyAccess; keyValue?: string | null; anthropicKey?: KeyAccess; anthropicKeyValue?: string | null; settings?: Partial<CloudSettings>; confirmAnswer?: boolean } = {}
): CloudDeps & { stateBox: CloudState; logs: string[]; localRuns: number; prompts: ConsentPrompt[] } {
  const { key: openaiAccess, keyValue, anthropicKey, anthropicKeyValue, settings: settingsPatch, confirmAnswer, ...rest } = extra
  const prompts: ConsentPrompt[] = []
  const stateBox: CloudState = { lastRunAt: null, since: null, lastRun: null }
  const logs: string[] = []
  const key = keyValue === undefined ? FAKE_OPENAI_KEY : keyValue
  const antKey = anthropicKeyValue === undefined ? FAKE_ANTHROPIC_KEY : anthropicKeyValue
  const settings: CloudSettings = { enabled: true, batchTime: '02:00', provider: 'openai', nightly: true, secondOpinions: true, agreedAt: { openai: '2026-10-01T09:00:00.000Z', anthropic: '2026-10-01T09:00:00.000Z' }, ...settingsPatch }
  const out = {
    wellRoot: () => well,
    sortLocal: async () => {
      out.localRuns++
      return { ok: true, sorted: 0 }
    },
    canSortLocal: () => true,
    rulesChangedSinceTest: () => false,
    keys: { openai: openaiAccess ?? access(() => key), anthropic: anthropicKey ?? access(() => antKey) },
    online: () => true,
    http: bothStubs().http,
    shrink: async () => ({ mime: 'image/jpeg', base64: 'AAAA' }),
    settings: () => settings,
    state: () => ({ ...stateBox }),
    saveState: (p: Partial<CloudState>) => Object.assign(stateBox, p),
    broadcast: () => undefined,
    log: (l: string) => void logs.push(l),
    sleep: async () => undefined,
    confirm: async (p: ConsentPrompt) => {
      prompts.push(p)
      return confirmAnswer ?? true
    },
    ...rest,
    stateBox,
    logs,
    prompts,
    localRuns: 0
  }
  return out
}

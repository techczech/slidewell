// Shared fixture for the sorter cloud-step tests: a scratch well whose triage.db holds screenshots
// (real small PNGs) with sorter proposals, a transport that answers like Luna, and fake deps.
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
import type { CloudDeps, CloudSettings, CloudState } from '../src/main/sorter/cloud/service'
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

export function readProposal(well: string, name: string): { proposal: string; decided_by: string | null; reason: string; throwaway_since: string | null } | undefined {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return db.prepare('SELECT proposal, decided_by, reason, throwaway_since FROM sorter_proposals WHERE hash = ?').get(hashOf(name)) as never
  } finally {
    db.close()
  }
}

type Part = { type: string; text?: string; image_url?: string }
export type SeenRequest = { windows: string[]; images: number; headers: Record<string, string>; body: string }

/**
 * Answers like Luna: the verdict comes from the window title sent beside each picture
 * ('keep…' keep 0.93, 'toss…' throwaway 0.97, 'weak…' throwaway 0.7, anything else unsure).
 */
export function lunaStub(opts: { delayMs?: number } = {}): { http: HttpPost; seen: SeenRequest[]; peak: () => number } {
  const seen: SeenRequest[] = []
  let inFlight = 0
  let peak = 0
  const http: HttpPost = async (_url, init) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const body = JSON.parse(init.body) as { input: Array<{ content: Part[] }> }
      const parts = body.input[0].content
      const lines = parts.filter((p) => p.type === 'input_text' && p.text?.startsWith('id: ')).map((p) => p.text as string)
      const windows = lines.map((l) => /window: ([^·]+)/.exec(l)?.[1].trim() ?? '')
      seen.push({ windows, images: parts.filter((p) => p.type === 'input_image').length, headers: init.headers, body: init.body })
      const items = lines.map((l, i) => {
        const id = /^id: (s\d+)/.exec(l)![1]
        const w = windows[i]
        if (w.startsWith('keep')) return { id, verdict: 'keep', confidence: 0.93, reason: 'A chart worth keeping.' }
        if (w.startsWith('toss')) return { id, verdict: 'throwaway', confidence: 0.97, reason: 'A settings pane.' }
        if (w.startsWith('weak')) return { id, verdict: 'throwaway', confidence: 0.7, reason: 'Probably a file picker.' }
        return { id, verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.' }
      })
      const text = JSON.stringify({ items })
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }) }
    } finally {
      inFlight--
    }
  }
  return { http, seen, peak: () => peak }
}

export function cloudDeps(well: string, extra: Partial<CloudDeps> & { keyValue?: string | null; settings?: Partial<CloudSettings> } = {}): CloudDeps & { stateBox: CloudState; logs: string[]; localRuns: number } {
  const { keyValue, settings: settingsPatch, ...rest } = extra
  const stateBox: CloudState = { lastRunAt: null, since: null, lastRun: null }
  const logs: string[] = []
  const key = keyValue === undefined ? 'sk-test-FAKEKEY0123456789abcdefWXYZ' : keyValue
  const settings: CloudSettings = { enabled: true, batchTime: '02:00', ...settingsPatch }
  const out = {
    wellRoot: () => well,
    sortLocal: async () => {
      out.localRuns++
      return { ok: true, sorted: 0 }
    },
    canSortLocal: () => true,
    key: { get: () => key, has: () => Boolean(key), encryptionAvailable: () => true },
    online: () => true,
    http: lunaStub().http,
    shrink: async () => ({ mime: 'image/jpeg', base64: 'AAAA' }),
    settings: () => settings,
    state: () => ({ ...stateBox }),
    saveState: (p: Partial<CloudState>) => Object.assign(stateBox, p),
    broadcast: () => undefined,
    log: (l: string) => void logs.push(l),
    sleep: async () => undefined,
    ...rest,
    stateBox,
    logs,
    localRuns: 0
  }
  return out
}

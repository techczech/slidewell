// Integration: inbox → well → triage marker → local-LLM description, against real sqlite3 + sharp
// and a fake OpenAI-compatible server. Skipped where the sqlite3 CLI is absent. OCR degrades to ''
// off macOS (no Vision helper), which the code treats as "no text".
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ensureWell, drainInbox, listUndescribed, countUndescribed, saveDescription, searchWell } from '../src/main/well'
import { markKeptInTriage, scanTriageSource } from '../src/main/triage'
import { createDescribeRunner, setSidecarField } from '../src/main/describe'
import { query } from '../src/main/sqlite'

const hasSqlite = existsSync('/usr/bin/sqlite3')

describe.skipIf(!hasSqlite)('inbox → well → description', () => {
  let dir: string
  let well: string
  let engine: string
  let server: Server
  let endpoint = ''
  let lastBody: { model?: string; messages?: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> } = {}

  const png = (r: number): Promise<Buffer> => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g: 40, b: 90 } } }).png().toBuffer()
  const old = (p: string): void => utimesSync(p, new Date(Date.now() - 60000), new Date(Date.now() - 60000))

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sw-it-'))
    well = join(dir, 'well')
    engine = join(dir, 'engine') // no tools/ocr → OCR returns ''
    await ensureWell(well)
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'text-embedding-x' }, { id: 'qwen2.5-vl-7b' }] }))
        lastBody = JSON.parse(body)
        res.end(JSON.stringify({ choices: [{ message: { content: 'A purple bar chart comparing survey answers.' } }] }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`
  })
  afterAll(() => {
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ingests settled files, defers fresh ones, ignores dot-files, routes videos, and marks triage', async () => {
    const inbox = join(well, '_inbox')
    const a = join(inbox, 'CleanShot 2026-10-01 at 10.00.00.png')
    writeFileSync(a, await png(120))
    old(a)
    const fresh = join(inbox, 'still-writing.png')
    writeFileSync(fresh, await png(200)) // mtime = now → deferred
    writeFileSync(join(inbox, '.partial.png.part'), 'x')
    const vid = join(inbox, 'recording.mp4')
    writeFileSync(vid, Buffer.from('not really a video'))
    old(vid)

    const kept: Array<[string, string]> = []
    const r = await drainInbox(engine, well, async (h, id) => {
      kept.push([h, id])
      await markKeptInTriage(well, h, id)
    })
    expect(r).toEqual({ kept: 2, deferred: 1 })
    expect(readdirSync(inbox).sort()).toEqual(['.partial.png.part', 'still-writing.png'])
    expect(readdirSync(join(well, 'images')).some((f) => f.endsWith('.webp'))).toBe(true)
    expect(readdirSync(join(well, 'videos')).some((f) => f.endsWith('.mp4'))).toBe(true)
    expect(kept.every(([h]) => /^[0-9a-f]{12}$/.test(h))).toBe(true)
    const decisions = await query<{ state: string }>(join(well, 'triage.db'), 'SELECT state FROM triage_decisions', [])
    expect(decisions.map((d) => d.state)).toEqual(['included', 'included'])
  })

  it('describes undescribed screenshots once, into search and the sidecar', async () => {
    expect(await countUndescribed(well)).toBe(1)
    const runner = createDescribeRunner({
      settings: () => ({ enabled: true, endpoint, model: '' }),
      pending: () => listUndescribed(well),
      save: (id, d) => saveDescription(well, id, d, setSidecarField)
    })
    expect(await runner.run()).toEqual({ described: 1, failed: 0, skipped: null })
    expect(lastBody.model).toBe('qwen2.5-vl-7b') // auto-picked the vision model
    expect(lastBody.messages?.[0].content[1].image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(await countUndescribed(well)).toBe(0)
    const hits = await searchWell(well, 'survey chart')
    expect(hits).toHaveLength(1)
    expect(hits[0].notes).toBe('A purple bar chart comparing survey answers.')
    const yml = readdirSync(join(well, 'images')).find((f) => f.endsWith('.yml'))!
    expect(readFileSync(join(well, 'images', yml), 'utf8')).toContain('description: "A purple bar chart comparing survey answers."')
    expect(await runner.run()).toEqual({ described: 0, failed: 0, skipped: null }) // idempotent
  })

  it('triage rescan forgets files deleted from the source folder', async () => {
    const src = join(dir, 'screenshots')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(src)
    writeFileSync(join(src, 'one.png'), await png(10))
    writeFileSync(join(src, 'two.png'), await png(20))
    const tdb = join(well, 'triage.db')
    await scanTriageSource(engine, well, src)
    expect((await query(tdb, 'SELECT rel_path FROM triage_fts', [])).length).toBe(2)
    unlinkSync(join(src, 'two.png'))
    await scanTriageSource(engine, well, src)
    expect((await query<{ rel_path: string }>(tdb, 'SELECT rel_path FROM triage_fts', [])).map((r) => r.rel_path)).toEqual(['one.png'])
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The model counts as downloaded and verified; nothing else about the model store is faked.
vi.mock('../src/main/picture-search/model-store', async (orig) => ({ ...(await orig<object>()), modelState: () => 'ready' }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))

const { PictureSearchService } = await import('../src/main/picture-search/service')
const { startPictureQueryServer } = await import('../src/main/picture-search/query-socket')
const { VectorStore, STORE_FILE, wellImageId } = await import('../src/main/picture-search/vector-store')
const { normalise } = await import('../src/main/picture-search/engine')

const v = (...xs: number[]): Float32Array => normalise(Float32Array.from(xs))

function ask(path: string, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = connect({ path })
    let reply = ''
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'picture-query', text, limit: 10 }) + '\n'))
    s.on('data', (d) => (reply += d))
    s.on('close', () => resolve(JSON.parse(reply)))
    s.on('error', reject)
  })
}

/** Every file in the folder with its size, mtime and content hash. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.sock')) continue
    const p = join(dir, f)
    const st = statSync(p)
    if (st.isFile()) out[f] = `${st.size} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`
  }
  return out
}

let base: string
let wellRoot: string
let ud: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'swqs-')))
  wellRoot = join(base, 'well')
  ud = join(base, 'ud')
  mkdirSync(wellRoot)
  mkdirSync(ud)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function service() {
  return new PictureSearchService({
    modelsRoot: join(base, 'models'),
    wellRoot: () => wellRoot,
    archiveRoot: () => null,
    vaultRoot: () => null,
    settings: () => ({ paused: true }),
    saveSettings: () => undefined,
    fetch: (() => Promise.reject(new Error('no network in tests'))) as never,
    makeEmbedder: () => ({ embedText: async () => v(1, 0, 0, 0), embedImage: async () => v(0, 1, 0, 0) }),
    broadcast: () => undefined
  })
}

describe('picture query endpoint over the real service: no store writes on account of a socket query', () => {
  it('an existing index the service has not opened is not touched by a query; the app opens it first', async () => {
    // an index written earlier (different metadata, so any meta upsert would change the file)
    const earlier = new VectorStore(join(wellRoot, STORE_FILE), { model: 'earlier' })
    earlier.put({ id: wellImageId('abc1234'), kind: 'well-image', path: '/x/robot.png', size: 1, mtimeMs: 1, wellId: 'abc1234' }, v(1, 0, 0, 0))
    earlier.close()
    const before = snapshot(wellRoot)

    const svc = service()
    const res = await startPictureQueryServer({ socketPath: join(ud, 'picture-query.sock'), engine: svc.queryEndpoint() })
    if (!res.ok) throw new Error(res.reason)
    expect(await ask(res.server.socketPath, 'robots')).toEqual({ v: 1, ok: false, reason: 'model-not-ready' })
    await expect(svc.queryEndpoint().query('robots', 5)).rejects.toThrow()
    expect(snapshot(wellRoot)).toEqual(before)

    // under the app's own authority (launch), the index is opened and initialised; then queries answer
    svc.prepareForQueries()
    expect(await ask(res.server.socketPath, 'robots')).toEqual({ v: 1, ok: true, hits: [{ id: 'well:abc1234', score: expect.closeTo(1, 5) }] })
    await res.server.close()
    svc.dispose()
  })

  it('a corrupt index: preparation reports failure without throwing, the endpoint answers model-not-ready', async () => {
    writeFileSync(join(wellRoot, STORE_FILE), 'this is not a SQLite database '.repeat(200))
    const svc = service()
    let prep: ReturnType<typeof svc.prepareForQueries> | undefined
    expect(() => (prep = svc.prepareForQueries())).not.toThrow()
    expect(prep).toEqual({ ok: false, reason: expect.stringMatching(/^picture-search\.db could not be opened/) })
    expect((prep as { reason: string }).reason).not.toContain(base) // no user paths in the logged reason
    const res = await startPictureQueryServer({ socketPath: join(ud, 'picture-query.sock'), engine: svc.queryEndpoint() })
    if (!res.ok) throw new Error(res.reason)
    expect(await ask(res.server.socketPath, 'robots')).toEqual({ v: 1, ok: false, reason: 'model-not-ready' })
    await res.server.close()
    svc.dispose()
  })

  it('an injected throwing open (unwritable folder): reported, not thrown; the caller carries on', () => {
    const svc = service()
    writeFileSync(join(wellRoot, STORE_FILE), '')
    ;(svc as unknown as { openStore: () => never }).openStore = () => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${wellRoot}/picture-search.db'`), { code: 'EACCES' })
    }
    const prep = svc.prepareForQueries()
    expect(prep).toEqual({ ok: false, reason: 'picture-search.db could not be opened (EACCES)' })
    expect(svc.queryEndpoint().ready()).toBe(false)
    svc.dispose()
  })

  it('no index on disk: the endpoint stays unavailable and prepareForQueries creates nothing', async () => {
    const svc = service()
    svc.prepareForQueries()
    expect(svc.queryEndpoint().ready()).toBe(false)
    expect(readdirSync(wellRoot)).toEqual([])
    svc.dispose()
  })
})

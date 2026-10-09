import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTalkUsageService, type TalkUsageDeps } from '../src/main/talk-usage-service'
import type { ScanOutcome, UsageMap } from '../src/main/talk-usage'

const scratch = realpathSync(mkdtempSync(join(__dirname, '.scratch-service-')))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fresh = (name: string): string => { const d = join(scratch, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d }

const gate = (): { wait: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined
  const wait = new Promise<void>((r) => { open = r })
  return { wait, open }
}
const usageFor = (vault: string): UsageMap => new Map([[vault, [{ title: vault, relPath: 'x-outline.md', slide: 1 }]]])
const ok: ScanOutcome = { status: 'ok', summary: { talks: 1, references: 1, images: 1 } }

/** A service over fake I/O: real folders (so the containment check passes), recorded watchers and writes. */
function harness(over: Partial<TalkUsageDeps> = {}) {
  const well = fresh('well')
  const cfg = { vault: null as string | null }
  const watchers: Array<{ vault: string; live: boolean }> = []
  const log: string[] = []
  const notes: Array<{ ok: boolean; reason: string }> = []
  const svc = createTalkUsageService({
    wellRoot: () => well,
    vaultRoot: () => cfg.vault,
    watch: (vault) => { const w = { vault, live: true }; watchers.push(w); return { close: () => { w.live = false } } },
    notify: (r) => { notes.push(r) },
    log: (m) => { log.push(m) },
    load: async (_w, v) => usageFor(v),
    scan: async () => ok,
    ...over
  })
  return { svc, well, cfg, watchers, log, notes, live: () => watchers.filter((w) => w.live).map((w) => w.vault) }
}

describe('talk usage service: one queue for switches and scans', () => {
  it("overlapping switches: A paused at its await, B requested and completed, A resumed -> only B's watcher, B's usage", async () => {
    const A = fresh('vault-a')
    const B = fresh('vault-b')
    const g = gate()
    const order: string[] = []
    const h = harness({
      load: async (_w, v) => { order.push(`load ${v === A ? 'A' : 'B'}`); if (v === A) await g.wait; return usageFor(v) },
      scan: async (_w, v) => { order.push(`scan ${v === A ? 'A' : 'B'}`); return ok }
    })
    h.cfg.vault = A
    const syncA = h.svc.sync()
    await new Promise((r) => setTimeout(r, 10)) // A is now waiting inside load
    h.cfg.vault = B
    const syncB = h.svc.sync()
    g.open()
    await Promise.all([syncA, syncB])
    await h.svc.idle()
    expect(h.live()).toEqual([B])
    expect(h.watchers.some((w) => w.vault === A)).toBe(false) // the overtaken switch installed nothing
    expect([...h.svc.usage().keys()]).toEqual([B])
    expect(order).toEqual(['load A', 'load B', 'scan B', 'load B']) // B runs only once A has stood down
  })

  it('a switch requested while a scan is writing waits for it, and the overtaken scan does not write', async () => {
    const A = fresh('vault-a')
    const B = fresh('vault-b')
    const g = gate()
    const order: string[] = []
    const writes: string[] = []
    let first = true
    const h = harness({
      scan: async (_w, v, isCurrent) => {
        const name = v === A ? 'A' : 'B'
        order.push(`scan ${name} start`)
        if (first) { first = false; await g.wait }
        // the real scan asks isCurrent() immediately before its write
        if (!isCurrent()) { order.push(`scan ${name} superseded`); return { status: 'kept', reason: 'superseded' } }
        writes.push(name)
        order.push(`scan ${name} wrote`)
        return ok
      },
      load: async (_w, v) => { order.push(`load ${v === A ? 'A' : 'B'}`); return usageFor(v) }
    })
    h.cfg.vault = A
    await h.svc.sync() // load A, watch A, queue scan A
    await new Promise((r) => setTimeout(r, 10)) // scan A is now paused before its write
    h.cfg.vault = B
    const switched = h.svc.sync()
    g.open()
    await switched
    await h.svc.idle()
    expect(order).toEqual(['load A', 'scan A start', 'scan A superseded', 'load B', 'scan B start', 'scan B wrote', 'load B'])
    expect(writes).toEqual(['B'])
    expect(h.live()).toEqual([B])
    expect([...h.svc.usage().keys()]).toEqual([B])
  })

  it('requests while busy coalesce: a burst of changes costs at most one extra scan', async () => {
    const A = fresh('vault-a')
    const g = gate()
    let scans = 0
    const h = harness({ scan: async () => { scans++; if (scans === 1) await g.wait; return ok } })
    h.cfg.vault = A
    await h.svc.sync()
    const burst = [h.svc.refresh(), h.svc.refresh(), h.svc.refresh()]
    g.open()
    await Promise.all(burst)
    await h.svc.idle()
    expect(scans).toBe(2)
    expect(h.notes.filter((r) => r.ok).length).toBeGreaterThanOrEqual(2)
  })

  it('an unchanged vault is a no-op; a cleared vault drops the watcher and the usage', async () => {
    const A = fresh('vault-a')
    const h = harness()
    h.cfg.vault = A
    await h.svc.sync()
    await h.svc.sync()
    await h.svc.idle()
    expect(h.watchers.length).toBe(1)
    h.cfg.vault = null
    await h.svc.sync()
    expect(h.live()).toEqual([])
    expect(h.svc.usage().size).toBe(0)
  })

  it('a refused well.db keeps the feature off: no watcher, no load, no scan, a logged reason', async () => {
    const vault = fresh('vault')
    let touched = 0
    const h = harness({ load: async () => { touched++; return new Map() }, scan: async () => { touched++; return ok } })
    symlinkSync(join(vault, 'well.db'), join(h.well, 'well.db')) // dangling, into the vault
    h.cfg.vault = vault
    await h.svc.sync()
    await h.svc.refresh()
    await h.svc.idle()
    expect(touched).toBe(0)
    expect(h.watchers).toEqual([])
    expect(h.log.join('\n')).toMatch(/talk usage is off for this vault: well\.db is a symbolic link/)
    expect(h.notes).toContainEqual({ ok: false, reason: 'db-refused' })
    expect(existsSync(join(vault, 'well.db'))).toBe(false)
  })

  it('end to end on real files: switching vaults publishes the new vault and never writes into either', async () => {
    const fixture = join(__dirname, 'fixtures', 'talk-vault')
    const A = fresh('vault-a'); cpSync(fixture, A, { recursive: true })
    const B = fresh('vault-b'); cpSync(fixture, B, { recursive: true })
    rmSync(join(B, 'robots-talk'), { recursive: true })
    const well = fresh('well')
    const cfg = { vault: A as string | null }
    const live: string[] = []
    const svc = createTalkUsageService({
      wellRoot: () => well,
      vaultRoot: () => cfg.vault,
      watch: (v) => { live.push(v); return { close: () => { live.splice(live.indexOf(v), 1) } } },
      notify: () => undefined,
      log: () => undefined
    })
    await svc.sync()
    await svc.idle()
    expect(svc.usage().get('aaaaaaa')?.length).toBe(2)
    cfg.vault = B
    await svc.sync()
    await svc.idle()
    expect(live).toEqual([B])
    expect(svc.usage().get('aaaaaaa')?.length).toBe(1)
    expect(existsSync(join(A, 'well.db')) || existsSync(join(B, 'well.db'))).toBe(false)
    svc.close()
    expect(live).toEqual([])
  })
})

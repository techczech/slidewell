/**
 * Keeps "which talks use which picture" pointed at the current vault. Every vault switch and every
 * scan runs through ONE serial queue, so a switch never overlaps a scan or another switch: a switch
 * requested while a scan writes waits for that write, and a switch that was overtaken by a newer
 * vault (it notices after its await) installs nothing and hands over to a fresh switch.
 *
 * Small interface: `sync()` points the feature at whatever vault and well are configured now (a
 * no-op when unchanged), `refresh()` rescans the current vault, `usage()` is the published map.
 * The watcher and the I/O are injected so the ordering can be tested without Electron.
 *
 * When the containment check refuses well.db (`checkWellDb`), the feature stays off for that vault:
 * no watcher, no scan, no table touched, and the reason is logged.
 */
import { checkWellDb, loadUsage, scanTalkUsage, type ScanOutcome, type UsageMap } from './talk-usage'

export interface UsageWatch { close(): void }

export interface TalkUsageDeps {
  wellRoot: () => string
  vaultRoot: () => string | null
  /** Watch a vault; `onChange` requests a rescan (the watcher does its own debouncing). */
  watch: (vault: string, onChange: () => void) => UsageWatch
  /** Told when the published usage may have changed, and why not when it did not. */
  notify: (r: { ok: boolean; reason: string }) => void
  log?: (message: string) => void
  scan?: (wellRoot: string, vaultRoot: string, isCurrent: () => boolean) => Promise<ScanOutcome>
  load?: (wellRoot: string, vaultRoot: string) => Promise<UsageMap>
}

export interface TalkUsageService {
  usage(): UsageMap
  /** Point at the configured vault: tear the old watcher down, load its snapshot, watch, rescan. */
  sync(): Promise<void>
  /** Rescan the current vault (coalesced with a rescan already waiting). */
  refresh(): Promise<void>
  /** Resolves once the queue is empty. */
  idle(): Promise<void>
  close(): void
}

type Kind = 'sync' | 'scan'
interface Task { kind: Kind; promise: Promise<void>; resolve: () => void }
interface Active { key: string; well: string; vault: string; watch: UsageWatch }

export function createTalkUsageService(deps: TalkUsageDeps): TalkUsageService {
  const scan = deps.scan ?? scanTalkUsage
  const load = deps.load ?? loadUsage
  const log = deps.log ?? ((m: string) => console.warn(m))
  let usage: UsageMap = new Map()
  let active: Active | null = null
  let closed = false
  const pending: Task[] = []
  // `running` is set and cleared synchronously inside the pump, so a request made from a finished
  // task's continuation always either joins the running pump or starts a new one
  let running = false
  let drained: Promise<void> = Promise.resolve()

  // a waiting task of the same kind already covers a new request: both read the config when they run
  const enqueue = (kind: Kind): Promise<void> => {
    if (closed) return Promise.resolve()
    const waiting = pending.find((t) => t.kind === kind)
    if (waiting) return waiting.promise
    let resolve: () => void = () => undefined
    const promise = new Promise<void>((r) => { resolve = r })
    pending.push({ kind, promise, resolve })
    if (!running) { running = true; drained = pump() }
    return promise
  }
  const pump = async (): Promise<void> => {
    try {
      while (pending.length) {
        const t = pending.shift()!
        try { await (t.kind === 'sync' ? doSync() : doScan()) } catch (e) { log(`talk usage: ${e instanceof Error ? e.message : String(e)}`) }
        t.resolve()
      }
    } finally {
      running = false
    }
  }

  const keyOf = (well: string, vault: string | null): string => (vault ? `${well}\n${vault}` : '')

  async function doSync(): Promise<void> {
    if (closed) return
    const well = deps.wellRoot()
    const vault = deps.vaultRoot()
    const key = keyOf(well, vault)
    if (active && active.key === key) return
    active?.watch.close()
    active = null
    usage = new Map()
    if (!vault) { deps.notify({ ok: true, reason: '' }); return }
    const db = checkWellDb(well, vault)
    if (!db.ok) {
      log(`talk usage is off for this vault: ${db.reason}`)
      deps.notify({ ok: false, reason: 'db-refused' })
      return
    }
    let loaded: UsageMap
    try { loaded = await load(well, vault) } catch { loaded = new Map() }
    // overtaken while loading: install nothing, publish nothing; a fresh switch reads the new config
    if (closed || keyOf(deps.wellRoot(), deps.vaultRoot()) !== key) { void enqueue('sync'); return }
    usage = loaded
    let live = true
    const inner = deps.watch(vault, () => { if (live) void enqueue('scan') })
    active = { key, well, vault, watch: { close: () => { live = false; inner.close() } } }
    deps.notify({ ok: true, reason: '' })
    void enqueue('scan')
  }

  async function doScan(): Promise<void> {
    const a = active
    if (closed || !a) return
    const isCurrent = (): boolean => !closed && active === a && keyOf(deps.wellRoot(), deps.vaultRoot()) === a.key
    const outcome = await scan(a.well, a.vault, isCurrent)
    if (outcome.status === 'ok') {
      let loaded: UsageMap | null = null
      try { loaded = await load(a.well, a.vault) } catch { /* keep what is published */ }
      if (!isCurrent()) return
      if (loaded) usage = loaded
    } else if (outcome.reason === 'superseded') {
      return
    } else {
      log(`talk usage kept as it was: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`)
    }
    deps.notify({ ok: outcome.status === 'ok', reason: outcome.status === 'ok' ? '' : outcome.reason })
  }

  return {
    usage: () => usage,
    sync: () => enqueue('sync'),
    refresh: () => enqueue('scan'),
    idle: async () => { while (running) await drained },
    close: () => {
      closed = true
      active?.watch.close()
      active = null
      for (const t of pending.splice(0)) t.resolve()
    }
  }
}

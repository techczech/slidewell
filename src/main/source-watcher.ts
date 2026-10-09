/**
 * Debounced folder watcher for capture sources. A small interface over fs.watch: `setSources` replaces
 * the watched set (idempotent per path), and `onChange(path)` fires once per quiet period per source,
 * so a burst of writes (a screenshot being saved) triggers one scan. Read-only: never touches files.
 */
import { watch, existsSync, type FSWatcher } from 'node:fs'

export type WatchedSource = {
  path: string
  recursive: boolean
  /** Only events whose path relative to the source passes this count (default: all non-dot names). `event` is fs.watch's 'rename' (add or remove) or 'change'. */
  accept?: (relName: string, event: string) => boolean
}

export function createSourceWatcher(onChange: (path: string) => void, debounceMs = 1500, maxWaitMs = Infinity): { setSources: (sources: WatchedSource[]) => void; close: () => void } {
  const watchers = new Map<string, { w: FSWatcher; recursive: boolean }>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const firstAt = new Map<string, number>()
  // fires once per quiet period, but never later than maxWaitMs after the first pending event
  const fire = (path: string): void => {
    clearTimeout(timers.get(path))
    const now = Date.now()
    if (!firstAt.has(path)) firstAt.set(path, now)
    const wait = Math.max(0, Math.min(debounceMs, firstAt.get(path)! + maxWaitMs - now))
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path)
        firstAt.delete(path)
        onChange(path)
      }, wait)
    )
  }
  const drop = (path: string): void => {
    watchers.get(path)?.w.close()
    watchers.delete(path)
    clearTimeout(timers.get(path))
    timers.delete(path)
    firstAt.delete(path)
  }

  return {
    setSources(sources) {
      const want = new Map(sources.map((s) => [s.path, s.recursive]))
      const accepts = new Map(sources.map((s) => [s.path, s.accept]))
      for (const [p, cur] of [...watchers]) if (!want.has(p) || want.get(p) !== cur.recursive) drop(p)
      for (const [p, recursive] of want) {
        if (watchers.has(p) || !existsSync(p)) continue
        try {
          const w = watch(p, { recursive, persistent: false }, (ev, name) => {
            const accept = accepts.get(p)
            if (accept) { if (!name || !accept(String(name), String(ev))) return }
            else if (name && String(name).startsWith('.')) return
            fire(p)
          })
          w.on('error', () => drop(p))
          watchers.set(p, { w, recursive })
        } catch {
          /* unwatchable folder: manual scan still works */
        }
      }
    },
    close() {
      for (const p of [...watchers.keys()]) drop(p)
    }
  }
}

import { realpath } from 'node:fs/promises'
import createWorker from './catalogue-worker?nodeWorker'
import type { FinderScope } from './catalogue'
import type { Rendition } from './rendition'

type Job =
  | { method: 'words' | 'resolve'; argument: string }
  | { method: 'eligibleWellIds' | 'generation' }

export type CatalogueRequest = Job & { id: number }
type Value = Rendition | Rendition[] | string | string[] | null
export type CatalogueReply = { id: number; value: Value } | { id: number; failed: true }

const RESTART_DELAYS_MS = [250, 1_000, 4_000]
const STABLE_WORKER_MS = 60_000

export async function createCatalogue(scope: FinderScope, onUnavailable?: () => void) {
  // Resolve the managed roots before listening, as with the original in-process catalogue.
  const workerData: FinderScope = {
    ...scope,
    archiveRoot: scope.presentations.length ? await realpath(scope.archiveRoot) : '',
    wellRoot: scope.wellImages.length ? await realpath(scope.wellRoot) : ''
  }
  const presentations = new Set(scope.presentations)
  const pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>()
  let worker: ReturnType<typeof createWorker> | undefined
  let restart: ReturnType<typeof setTimeout> | undefined
  let nextId = 0
  let attempts = 0
  let closed = false

  function failPending() {
    for (const job of pending.values()) job.reject(new Error('Finder catalogue unavailable'))
    pending.clear()
  }

  function scheduleRestart() {
    const delay = RESTART_DELAYS_MS[attempts++]
    if (delay === undefined) {
      onUnavailable?.()
      return
    }
    restart = setTimeout(() => {
      restart = undefined
      start()
    }, delay)
    restart.unref()
  }

  function start() {
    const started = process.hrtime.bigint()
    let current: ReturnType<typeof createWorker>
    try {
      current = createWorker({ workerData })
    } catch {
      scheduleRestart()
      return
    }
    worker = current

    current.on('message', (reply: CatalogueReply) => {
      if (worker !== current) return
      const job = pending.get(reply.id)
      if (!job) return
      pending.delete(reply.id)
      if ('failed' in reply) job.reject(new Error('Finder catalogue read failed'))
      else job.resolve(reply.value)
    })
    // Worker errors are followed by an exit. Refuse requests as soon as the
    // error arrives, then wait for exit before allocating the replacement.
    current.on('error', () => {
      if (worker !== current) return
      worker = undefined
      failPending()
    })
    current.once('exit', () => {
      if (closed) return
      worker = undefined
      failPending()
      if (process.hrtime.bigint() - started >= BigInt(STABLE_WORKER_MS) * 1_000_000n) attempts = 0
      scheduleRestart()
    })
  }

  function send(job: Job): Promise<Value> {
    return new Promise((resolve, reject) => {
      if (!worker) return reject(new Error('Finder catalogue unavailable'))
      const id = nextId++
      worker.postMessage({ id, ...job })
      pending.set(id, { resolve, reject })
    })
  }

  start()

  return {
    libraryId: scope.libraryId,
    words: (argument: string) => send({ method: 'words', argument }) as Promise<Rendition[]>,
    resolve: (argument: string) => send({ method: 'resolve', argument }) as Promise<Rendition | null>,
    generation: () => send({ method: 'generation' }) as Promise<string>,
    async eligibleIds() {
      const wells = new Set(await send({ method: 'eligibleWellIds' }) as string[])
      return (id: string) => wells.has(id) || (id.startsWith('slide:') && presentations.has(id.slice(6, id.lastIndexOf('#'))))
    },
    close() {
      closed = true
      clearTimeout(restart)
      const current = worker
      worker = undefined
      failPending()
      return current?.terminate()
    }
  }
}

export type Catalogue = Awaited<ReturnType<typeof createCatalogue>>

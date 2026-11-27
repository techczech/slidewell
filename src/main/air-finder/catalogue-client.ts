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

export async function createCatalogue(scope: FinderScope) {
  // Resolve the managed roots before listening, as with the original in-process catalogue.
  const workerData: FinderScope = {
    ...scope,
    archiveRoot: scope.presentations.length ? await realpath(scope.archiveRoot) : '',
    wellRoot: scope.wellImages.length ? await realpath(scope.wellRoot) : ''
  }
  const presentations = new Set(scope.presentations)
  const worker = createWorker({ workerData })
  const pending = new Map<number, { resolve: (value: Value) => void; reject: (error: Error) => void }>()
  let nextId = 0
  let closed = false

  function failPending() {
    closed = true
    for (const job of pending.values()) job.reject(new Error('Finder catalogue unavailable'))
    pending.clear()
  }

  worker.on('message', (reply: CatalogueReply) => {
    const job = pending.get(reply.id)
    if (!job) return
    pending.delete(reply.id)
    if ('failed' in reply) job.reject(new Error('Finder catalogue read failed'))
    else job.resolve(reply.value)
  })
  worker.on('error', failPending)
  worker.on('exit', failPending)

  function send(job: Job): Promise<Value> {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Finder catalogue unavailable'))
      const id = nextId++
      worker.postMessage({ id, ...job })
      pending.set(id, { resolve, reject })
    })
  }

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
      failPending()
      return worker.terminate()
    }
  }
}

export type Catalogue = Awaited<ReturnType<typeof createCatalogue>>

import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { rank, SEARCH_KINDS, type Scored } from '../picture-search/engine'
import { readStoredVector, readStoredVectors, type StoredVector } from '../picture-search/vector-store'
import { finderAllows, FINDER_RANK_LIMIT, type FinderRankingScope } from './ranking-scope'

export type RelatedRequest = FinderRankingScope & { imageId: string }
export type RelatedReply = { hits: Scored[] | null } | { failed: true }

if (parentPort) {
  const port = parentPort
  // The picture service has already opened and initialised this index as its sole writer.
  const db = new DatabaseSync(workerData as string, { readOnly: true })
  db.exec('PRAGMA busy_timeout=500')
  const dataVersion = db.prepare('PRAGMA data_version')
  let snapshot: { version: number; vectors: Map<string, StoredVector> } | undefined

  port.on('message', (request: RelatedRequest) => {
    let reply: RelatedReply
    try {
      // Compare on this same read connection so WAL commits by the app invalidate the cache.
      const version = dataVersion.get()!.data_version as number
      if (snapshot?.version !== version) {
        snapshot = undefined
        const vectors = new Map<string, StoredVector>()
        for (const vector of readStoredVectors(db, SEARCH_KINDS)) vectors.set(vector.id, vector)
        snapshot = { version, vectors }
      }
      const seed = snapshot.vectors.get(request.imageId) ?? readStoredVector(db, request.imageId)
      reply = {
        hits: seed ? rank(seed.vector, snapshot.vectors.values(), FINDER_RANK_LIMIT, request.imageId,
          SEARCH_KINDS, finderAllows(request)) : null
      }
    } catch {
      reply = { failed: true }
    }
    port.postMessage(reply)
  })
}

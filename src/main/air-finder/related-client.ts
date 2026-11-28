import createWorker from './related-worker?nodeWorker'
import { NotIndexedError, type Scored } from '../picture-search/engine'
import type { RelatedReply } from './related-worker'
import type { FinderRankingScope } from './ranking-scope'

export function createRelatedRanker(indexFile: string) {
  let worker: ReturnType<typeof createWorker> | undefined
  let pending: { resolve: (hits: Scored[]) => void; reject: (error: Error) => void } | undefined
  let closed = false

  function settle(reply: RelatedReply) {
    const request = pending
    pending = undefined
    if (!request) return
    if ('failed' in reply) request.reject(new Error('Finder picture index unavailable'))
    else if (reply.hits === null) request.reject(new NotIndexedError('Seed has no stored vector'))
    else request.resolve(reply.hits)
  }

  function start() {
    const current = createWorker({ workerData: indexFile })
    current.on('message', (reply: RelatedReply) => {
      if (worker === current) settle(reply)
    })
    const stopped = () => {
      if (worker !== current) return
      worker = undefined
      settle({ failed: true })
    }
    current.on('error', stopped)
    current.on('exit', stopped)
    return current
  }

  return {
    query(imageId: string, scope: FinderRankingScope): Promise<Scored[]> {
      return new Promise((resolve, reject) => {
        if (closed || pending) return reject(new Error('Finder picture index unavailable'))
        worker ??= start()
        pending = { resolve, reject }
        try {
          worker.postMessage({ imageId, ...scope })
        } catch {
          settle({ failed: true })
        }
      })
    },
    close() {
      closed = true
      const current = worker
      worker = undefined
      settle({ failed: true })
      return current?.terminate()
    }
  }
}

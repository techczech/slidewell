import { parentPort, workerData } from 'node:worker_threads'
import { openCatalogue, type FinderScope } from './catalogue'
import type { CatalogueReply, CatalogueRequest } from './catalogue-client'

if (parentPort) {
  const port = parentPort
  const catalogue = openCatalogue(workerData as FinderScope)
  port.on('message', async (request: CatalogueRequest) => {
    const { id } = request
    let reply: CatalogueReply
    try {
      const value = 'argument' in request
        ? await catalogue[request.method](request.argument)
        : await catalogue[request.method]()
      reply = { id, value }
    } catch {
      reply = { id, failed: true }
    }
    port.postMessage(reply)
  })
}

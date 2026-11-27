import { createHash, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import sharp from 'sharp'
import { NotIndexedError, type PictureQuery, type QueryOptions, type Scored } from '../picture-search/engine'
import type { Catalogue } from './catalogue-client'
import { readRendition, verifyRendition, type Rendition } from './rendition'
import page from './finder.html?raw'
import script from './finder.js?raw'
import style from './finder.css?raw'

const PREVIEW_WIDTH = 480
const PREVIEW_TTL_MS = 2 * 60_000
const PREVIEW_BYTES = 4 * 1024 * 1024
const PREVIEW_ENTRIES = 128
const EXPIRES_MS = 10 * 60_000
const MAX_REFS = 720
const SEARCH_LIMIT = 40
type Ref = { itemId: string; sourceRevision: string; indexGeneration: string; expires: number }
export type FinderQueries = {
  ready(): boolean
  query(input: PictureQuery, options: QueryOptions): Promise<Scored[]>
}

function reply(res: ServerResponse, status: number, body: string | Buffer, type: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra
  }).end(body)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  reply(res, status, JSON.stringify(value), 'application/json')
}

function sourceFields(item: Rendition, libraryId: string, indexGeneration: string) {
  return {
    libraryId, indexGeneration, itemId: item.itemId, corpusId: item.corpusId, sourceRevision: item.sourceRevision,
    title: item.title.slice(0, 240), snippet: item.snippet, source: item.source
  }
}

async function renditionImage(original: Buffer, expectedMime: string) {
  const image = sharp(original, { limitInputPixels: 64_000_000, failOn: 'warning' })
  const metadata = await image.metadata().catch(() => null)
  const mime = metadata?.format === 'jpeg' ? 'image/jpeg' : `image/${metadata?.format}`
  return mime === expectedMime && (metadata?.pages ?? 1) <= 1 ? image : null
}

export function finderServer(opts: {
  catalogue: Catalogue; pictures?: FinderQueries; available?: () => boolean; browserPort: number; now?: () => number
}) {
  const { catalogue, pictures } = opts
  const now = opts.now ?? Date.now
  const refs = new Map<string, Ref>()
  const previews = new Map<string, { bytes: Buffer; expires: number }>()
  let previewBytes = 0
  let previewTurn = Promise.resolve()
  const origin = `http://127.0.0.1:${opts.browserPort}`
  const allowedHost = new URL(origin).host
  let active = 0
  let pictureBusy = false

  function wire(item: Rendition, indexGeneration: string, reason: 'Words' | 'Meaning' | 'Similar appearance') {
    if (refs.size === MAX_REFS) refs.delete(refs.keys().next().value!)
    const ref = randomUUID()
    refs.set(ref, { itemId: item.itemId, sourceRevision: item.sourceRevision, indexGeneration, expires: now() + EXPIRES_MS })
    return { ...sourceFields(item, catalogue.libraryId, indexGeneration), reason, ref }
  }

  function valid(ref: Ref): boolean {
    return ref.expires > now() && opts.available?.() !== false
  }

  async function current(ref: Ref): Promise<Rendition | null> {
    if (!valid(ref)) return null
    const item = await catalogue.resolve(ref.itemId)
    return valid(ref) && item?.sourceRevision === ref.sourceRevision ? item : null
  }

  function forgetPreview(key: string) {
    const entry = previews.get(key)
    if (!entry) return
    previewBytes -= entry.bytes.length
    previews.delete(key)
  }

  async function servePreview(ref: Ref, res: ServerResponse): Promise<void> {
    // At most six requests can reach this queue. Only its head can hold source bytes or decode.
    const previous = previewTurn
    let release!: () => void
    previewTurn = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (res.destroyed) return
      const item = await current(ref)
      if (!item) return json(res, 404, { error: 'Result changed or is no longer available' })

      const key = JSON.stringify([item.itemId, item.path, item.mime, item.sourceRevision, PREVIEW_WIDTH])
      const cached = previews.get(key)
      const hit = cached && cached.expires > now() ? cached : null
      forgetPreview(key)
      let thumb: Buffer
      if (hit) {
        if (!await verifyRendition(item)) return json(res, 404, { error: 'Rendition is missing or changed' })
        thumb = hit.bytes
      } else {
        const original = await readRendition(item)
        if (!original) return json(res, 404, { error: 'Rendition is missing or changed' })
        const image = await renditionImage(original, item.mime)
        if (!image) return json(res, 415, { error: 'Rendition format unavailable' })
        // Sharp shrinks JPEG/WebP during loading. PNG still needs the full raster decoded.
        thumb = await image.resize({
          width: PREVIEW_WIDTH, height: PREVIEW_WIDTH, fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true
        }).webp().toBuffer()
      }

      const latest = await current(ref)
      if (latest?.path !== item.path || latest.mime !== item.mime) {
        return json(res, 404, { error: 'Result changed or is no longer available' })
      }
      if (thumb.length <= PREVIEW_BYTES) {
        while (previewBytes + thumb.length > PREVIEW_BYTES || previews.size >= PREVIEW_ENTRIES) {
          forgetPreview(previews.keys().next().value!)
        }
        previews.set(key, { bytes: thumb, expires: hit?.expires ?? now() + PREVIEW_TTL_MS })
        previewBytes += thumb.length
      }
      reply(res, 200, thumb, 'image/webp')
    } finally {
      release()
    }
  }

  async function rank(input: PictureQuery, seed?: Rendition): Promise<Rendition[] | null> {
    if (!pictures?.ready() || pictureBusy) return null
    pictureBusy = true
    try {
      const allowed = await catalogue.eligibleIds()
      const ranked = await pictures.query(input, {
        limit: SEARCH_LIMIT, kinds: ['slide', 'well-image'],
        allow: (id) => allowed(id) && (!seed || seed.corpusId !== 'slides' || !id.startsWith(seed.itemId.split('#')[0] + '#'))
      })
      const hits = await Promise.all(ranked.filter((hit) => allowed(hit.id)).map((hit) => catalogue.resolve(hit.id)))
      return hits.filter((item) => item !== null)
    } finally {
      pictureBusy = false
    }
  }

  const server = createServer({ maxHeaderSize: 4096, headersTimeout: 5_000, requestTimeout: 5_000 }, async (req, res) => {
    // The supported browser origin is the local end of the authenticated SSH forward.
    if (req.headers.host !== allowedHost || (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
      return json(res, 403, { error: 'Connection denied' })
    }
    if (req.method !== 'GET' || req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      return json(res, 405, { error: 'Read-only finder' })
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || req.url.length > 2100) {
      return json(res, 400, { error: 'Invalid request' })
    }
    const url = new URL(req.url, origin)
    if (url.pathname === '/') return reply(res, 200, page, 'text/html; charset=utf-8')
    if (url.pathname === '/finder.js') return reply(res, 200, script, 'text/javascript; charset=utf-8')
    if (url.pathname === '/finder.css') return reply(res, 200, style, 'text/css; charset=utf-8')

    if (active >= 6) return json(res, 503, { error: 'Finder busy. Try again.' })
    active++
    try {
      if (opts.available?.() === false) return json(res, 503, { error: 'Library changed. Restart the finder on the host.' })
      if (url.pathname === '/api/library' && !url.search) {
        return json(res, 200, {
          protocol: 1, libraryId: catalogue.libraryId, indexGeneration: await catalogue.generation(),
          words: true, meaning: pictures?.ready() ?? false
        })
      }
      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q')?.trim()
        const mode = url.searchParams.get('mode')
        if (!q || [...q].length > 200 || /[\u0000-\u001f\u007f]/.test(q) ||
          (mode !== 'words' && mode !== 'meaning') || url.searchParams.size !== 2) {
          return json(res, 400, { error: 'Enter a search of up to 200 characters' })
        }
        const indexGeneration = await catalogue.generation()
        const items = mode === 'words' ? await catalogue.words(q) : await rank({ text: q })
        if (!items) return json(res, 503, { error: 'Meaning unavailable. Search by Words or try again.' })
        if (opts.available?.() === false) return json(res, 503, { error: 'Library changed. Run the search again.' })
        return json(res, 200, { items: items.slice(0, SEARCH_LIMIT).map((it) => wire(it, indexGeneration, mode === 'words' ? 'Words' : 'Meaning')) })
      }
      const match = /^\/api\/(preview|download|related)\/([a-f0-9-]{36})$/.exec(url.pathname)
      if (!match || url.search) return json(res, 404, { error: 'Unavailable in this library' })
      const ref = refs.get(match[2])
      if (!ref || ref.expires <= now()) return json(res, 410, { error: 'Result expired. Run the search again.' })
      if (match[1] === 'preview') return await servePreview(ref, res)
      const item = await current(ref)
      if (!item) return json(res, 404, { error: 'Result changed or is no longer available' })
      if (match[1] === 'related') {
        try {
          const indexGeneration = await catalogue.generation()
          const items = await rank({ imageId: item.itemId }, item)
          if (!items) return json(res, 503, { error: 'Related items unavailable. Try again.' })
          if (!await current(ref)) return json(res, 404, { error: 'Result changed or is no longer available' })
          return json(res, 200, { items: items.slice(0, 12).map((it) => wire(it, indexGeneration, 'Similar appearance')) })
        } catch (error) {
          if (!(error instanceof NotIndexedError)) throw error
          return json(res, 404, { error: 'This item has no picture index entry yet' })
        }
      }
      const original = await readRendition(item)
      if (!original) return json(res, 404, { error: 'Rendition is missing or changed' })
      if (!await renditionImage(original, item.mime)) return json(res, 415, { error: 'Rendition format unavailable' })
      const hash = createHash('sha256').update(original).digest('hex')
      if (!await current(ref)) return json(res, 404, { error: 'Result changed or is no longer available' })
      const extension = item.mime.split('/')[1]
      return reply(res, 200, original, item.mime, {
        'Content-Disposition': `attachment; filename="slidewell-${hash.slice(0, 12)}.${extension}"`,
        'X-SlideWell-SHA256': hash
      })
    } catch {
      json(res, 503, { error: 'Library or index unavailable on the host. Try again.' })
    } finally {
      active--
    }
  })

  server.once('close', () => { void catalogue.close() })
  server.maxConnections = 24
  server.keepAliveTimeout = 3_000
  server.setTimeout(20_000, (socket) => socket.destroy())
  return server
}

const byId = (id) => document.getElementById(id)
const status = byId('status')
const results = byId('results')
const detail = byId('detail')
const similar = byId('similar')
const transfer = byId('transfer')
const provenance = byId('provenance')
let selection
let searchRequest = new AbortController()
let selectionRequest
let provenanceUrl
let libraryId

async function request(path, signal) {
  let response
  try {
    response = await fetch(path, { signal })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    byId('connection').textContent = 'Cannot reach the host'
    throw new Error('The host is offline or the connection was lost. Reconnect and try again.')
  }
  if (!response.ok) throw new Error((await response.json()).error)
  return response
}

async function describe(signal) {
  const library = await (await request('/api/library', signal)).json()
  signal.throwIfAborted()
  if (library.protocol !== 1 || (libraryId && libraryId !== library.libraryId)) {
    throw new Error('A different library or finder version answered. Check your connection.')
  }
  libraryId = library.libraryId
  byId('connection').textContent = library.meaning ? libraryId : libraryId + ' · Meaning unavailable'
  byId('match').hidden = !library.meaning
  byId('related').hidden = !library.meaning
  byId('query').placeholder = library.meaning ? 'Words you remember or a topic' : 'Words you remember'
  if (!library.meaning) byId('mode').value = 'words'
}

function resetDetail() {
  selectionRequest?.abort()
  selection = undefined
  detail.hidden = true
  similar.replaceChildren()
  byId('neighbours').hidden = true
  provenance.hidden = true
  if (provenanceUrl) URL.revokeObjectURL(provenanceUrl)
  provenanceUrl = undefined
  transfer.textContent = ''
  byId('download').disabled = false
  byId('related').disabled = false
}

function render(target, items) {
  target.replaceChildren(...items.map((item, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'card'
    button.setAttribute('aria-pressed', 'false')
    const image = document.createElement('img')
    if (index > 2) image.loading = 'lazy'
    image.alt = ''
    image.src = '/api/preview/' + item.ref
    const heading = document.createElement('strong')
    heading.textContent = item.title
    const source = document.createElement('small')
    source.textContent = item.source + ' · ' + item.reason
    button.append(image, heading, source)
    button.addEventListener('click', () => {
      for (const card of document.querySelectorAll('.card[aria-pressed="true"]')) {
        card.setAttribute('aria-pressed', 'false')
      }
      select(item)
      button.setAttribute('aria-pressed', 'true')
    })
    return button
  }))
}

function select(item) {
  resetDetail()
  selection = item
  selectionRequest = new AbortController()
  const preview = byId('preview')
  preview.src = '/api/preview/' + item.ref
  preview.alt = item.title
  byId('title').textContent = item.title
  byId('source').textContent = item.source + ' · ' + item.libraryId
  byId('snippet').textContent = item.snippet
  byId('download').textContent = item.corpusId === 'slides' ? 'Download slide render' : 'Download image'
  detail.hidden = false
}

byId('search').addEventListener('submit', async (event) => {
  event.preventDefault()
  const q = byId('query').value.trim()
  if (!q) return
  searchRequest.abort()
  searchRequest = new AbortController()
  const { signal } = searchRequest
  resetDetail()
  results.replaceChildren()
  status.textContent = 'Searching…'
  try {
    await describe(signal)
    const query = new URLSearchParams({ q, mode: byId('mode').value })
    const { items } = await (await request('/api/search?' + query, signal)).json()
    if (signal.aborted) return
    render(results, items)
    status.textContent = items.length ? `${items.length} shown` : 'No matches in the available library.'
  } catch (error) {
    if (!signal.aborted) status.textContent = error.message
  }
})

byId('related').addEventListener('click', async () => {
  const item = selection
  const { signal } = selectionRequest
  const button = byId('related')
  button.disabled = true
  byId('neighbours').hidden = true
  transfer.textContent = 'Finding similar items…'
  try {
    const { items } = await (await request('/api/related/' + item.ref, signal)).json()
    if (signal.aborted) return
    render(similar, items)
    byId('neighbours').hidden = !items.length
    transfer.textContent = items.length ? '' : 'No similar items in this library.'
  } catch (error) {
    if (!signal.aborted) transfer.textContent = error.message
  } finally {
    if (!signal.aborted) button.disabled = false
  }
})

byId('download').addEventListener('click', async () => {
  const item = selection
  const { signal } = selectionRequest
  const button = byId('download')
  button.disabled = true
  transfer.textContent = 'Verifying the full-size rendition…'
  try {
    const response = await request('/api/download/' + item.ref, signal)
    const bytes = await response.arrayBuffer()
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (signal.aborted) return
    if (sha256 !== response.headers.get('X-SlideWell-SHA256')) {
      throw new Error('The download did not match its expected hash. Try again.')
    }
    const type = response.headers.get('Content-Type')
    const filename = 'slidewell-' + sha256.slice(0, 12)
    const url = URL.createObjectURL(new Blob([bytes], { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename + '.' + type.split('/')[1]
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    const { libraryId, corpusId, itemId, source, sourceRevision, indexGeneration, title } = item
    if (provenanceUrl) URL.revokeObjectURL(provenanceUrl)
    provenanceUrl = URL.createObjectURL(new Blob(
      [JSON.stringify({ libraryId, corpusId, itemId, source, sourceRevision, indexGeneration, title, sha256 }, null, 2)],
      { type: 'application/json' }
    ))
    provenance.href = provenanceUrl
    provenance.download = filename + '.json'
    provenance.hidden = false
    transfer.textContent = 'Verified. Your browser is saving the rendition.'
  } catch (error) {
    if (!signal.aborted) transfer.textContent = error.message
  } finally {
    if (!signal.aborted) button.disabled = false
  }
})

const initialSignal = searchRequest.signal
describe(initialSignal).catch((error) => {
  if (!initialSignal.aborted) byId('connection').textContent = error.message
})

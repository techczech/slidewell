import { useEffect, useRef, useState } from 'react'
import type { SlideResult } from '../../preload'

type Scope = 'all' | 'archive' | 'well'

export default function App(): JSX.Element {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [archiveOk, setArchiveOk] = useState<boolean | null>(null)
  const [archivePath, setArchivePath] = useState<string>('')
  const [results, setResults] = useState<SlideResult[]>([])
  const [loading, setLoading] = useState(false)
  const reqId = useRef(0)

  useEffect(() => {
    void (async () => {
      const paths = await window.sw.settings.getPaths()
      setArchiveOk(paths.archiveAvailable)
      setArchivePath(paths.archiveRoot ?? paths.archiveDefault)
    })()
  }, [])

  // Debounce typing → the query we actually run.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  // Run search when the debounced query or scope changes. reqId guards against
  // out-of-order async responses (a slow earlier query resolving after a newer one).
  useEffect(() => {
    if (scope === 'well') {
      setResults([])
      setLoading(false)
      return
    }
    if (!debounced) {
      setResults([])
      setLoading(false)
      return
    }
    const id = ++reqId.current
    setLoading(true)
    void window.sw.archive.searchSlides(debounced).then((hits) => {
      if (id !== reqId.current) return // a newer search superseded this one
      setResults(hits)
      setLoading(false)
    })
  }, [debounced, scope])

  async function chooseArchive(): Promise<void> {
    const picked = await window.sw.settings.chooseArchive()
    if (picked) {
      setArchivePath(picked)
      setArchiveOk(await window.sw.archive.available())
    }
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">
          Slide<span className="well">Well</span>
        </span>
        <span className="tagline">the well — your slides &amp; images in one place</span>
      </header>

      <div className="searchbar">
        <input
          className="search-input"
          placeholder="Search slides, images, OCR text…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="scope" role="tablist" aria-label="Provenance scope">
          {(['all', 'archive', 'well'] as Scope[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              className={scope === s ? 'scope-tab active' : 'scope-tab'}
              onClick={() => setScope(s)}
            >
              {s === 'all' ? 'All' : s === 'archive' ? 'Archive' : 'Well'}
            </button>
          ))}
        </div>
      </div>

      <main className="results">
        {scope === 'well' ? (
          <Empty
            title="The well is empty — no added images yet."
            sub="Adding images you collect for later is the next milestone. For now, search the Archive."
          />
        ) : !debounced ? (
          <Empty
            title="Search 40,000 slides and their images."
            sub="Type a query — matches come from slide text and OCR'd text on renders and embedded images."
          />
        ) : loading ? (
          <div className="results-head">searching…</div>
        ) : results.length === 0 ? (
          <Empty title={`No matches for “${debounced}”.`} sub="Try a different term, or check the archive is connected." />
        ) : (
          <>
            <div className="results-head">
              {results.length} result{results.length === 1 ? '' : 's'} for “{debounced}”
            </div>
            <div className="grid">
              {results.map((r, i) => (
                <Card key={`${r.deck}-${r.slideOrder}-${i}`} hit={r} />
              ))}
            </div>
          </>
        )}
      </main>

      <footer className="statusbar">
        {archiveOk === null ? (
          <span>checking archive…</span>
        ) : archiveOk ? (
          <span className="ok">● archive connected</span>
        ) : (
          <span className="warn">
            ● archive not found
            <button className="link" onClick={chooseArchive}>
              choose folder
            </button>
          </span>
        )}
        <span className="path" title={archivePath}>
          {archivePath}
        </span>
      </footer>
    </div>
  )
}

function Empty({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p className="empty-sub">{sub}</p>
    </div>
  )
}

function Card({ hit }: { hit: SlideResult }): JSX.Element {
  const [copied, setCopied] = useState(false)
  async function copyRef(): Promise<void> {
    await navigator.clipboard.writeText(hit.reference)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="card">
      <div className="thumb-wrap">
        {hit.thumbUrl ? (
          <img
            className="thumb"
            src={hit.thumbUrl}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden'
            }}
          />
        ) : (
          <div className="thumb placeholder" aria-hidden />
        )}
        {hit.kind !== 'slide' && <span className="ocr-tag">OCR</span>}
      </div>
      <div className="meta">
        <div className="card-title" title={hit.title}>
          {hit.title}
        </div>
        {hit.snippet && <div className="snippet">{hit.snippet}</div>}
        <div className="card-foot">
          <span className="deck" title={hit.deck}>
            {hit.deck || '—'}
          </span>
          {hit.usedInDecks > 1 && <span className="badge">in {hit.usedInDecks} decks</span>}
          <button className="copyref" onClick={copyRef}>
            {copied ? 'copied ✓' : 'copy ref'}
          </button>
        </div>
      </div>
    </div>
  )
}

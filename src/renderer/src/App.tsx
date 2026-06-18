import { useEffect, useState } from 'react'

type Scope = 'all' | 'archive' | 'well'

export default function App(): JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [archiveOk, setArchiveOk] = useState<boolean | null>(null)
  const [archivePath, setArchivePath] = useState<string>('')

  useEffect(() => {
    void (async () => {
      const paths = await window.sw.settings.getPaths()
      setArchiveOk(paths.archiveAvailable)
      setArchivePath(paths.archiveRoot ?? paths.archiveDefault)
    })()
  }, [])

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
        <div className="empty">
          <p className="empty-title">Nothing wired up yet — this is the scaffold.</p>
          <p className="empty-sub">
            Search will draw from Core A&apos;s extraction store (slides, OCR, images) plus the
            image well. See <code>_TASK-LOG/RESUME.md</code> for the build order.
          </p>
        </div>
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

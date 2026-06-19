import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlideResult, SlideClusterResult, SearchFilters, CategoryCount } from '../../preload'

const DEFAULT_FILTERS: SearchFilters = { owner: 'mine', era: 'all', category: '', role: 'content', cluster: true, scope: 'all' }

const ERA_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All dates' },
  { value: 'recent', label: '2023–present' },
  { value: 'mid', label: '2017–2022' },
  { value: 'early', label: 'pre-2017' },
  { value: '2026', label: '2026' },
  { value: '2025', label: '2025' },
  { value: '2024', label: '2024' },
  { value: '2023', label: '2023' }
]

export default function App(): JSX.Element {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS)
  const [archiveOk, setArchiveOk] = useState<boolean | null>(null)
  const [archivePath, setArchivePath] = useState('')
  const [categories, setCategories] = useState<CategoryCount[]>([])
  const [clusters, setClusters] = useState<SlideClusterResult[]>([])
  const [loading, setLoading] = useState(false)
  const [toast, setToastMsg] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ cluster: SlideClusterResult; x: number; y: number } | null>(null)
  const [lightbox, setLightbox] = useState<{ list: SlideResult[]; index: number } | null>(null)
  const [expanded, setExpanded] = useState<SlideClusterResult | null>(null)
  const [details, setDetails] = useState<SlideResult | null>(null)
  const reqId = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const setToast = useCallback((msg: string) => {
    setToastMsg(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 1400)
  }, [])

  const patch = (p: Partial<SearchFilters>): void => setFilters((f) => ({ ...f, ...p }))

  useEffect(() => {
    void (async () => {
      const paths = await window.sw.settings.getPaths()
      setArchiveOk(paths.archiveAvailable)
      setArchivePath(paths.archiveRoot ?? paths.archiveDefault)
      if (paths.archiveAvailable) setCategories(await window.sw.archive.categories())
    })()
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const id = ++reqId.current
    setLoading(true)
    void window.sw.archive.search(debounced, filters).then((res) => {
      if (id !== reqId.current) return
      setClusters(res)
      setLoading(false)
    })
  }, [debounced, filters])

  const reps = useMemo(() => clusters.map((c) => c.representative), [clusters])

  async function chooseArchive(): Promise<void> {
    const picked = await window.sw.settings.chooseArchive()
    if (picked) {
      setArchivePath(picked)
      const ok = await window.sw.archive.available()
      setArchiveOk(ok)
      if (ok) setCategories(await window.sw.archive.categories())
    }
  }

  // ----- actions -----
  const copyText = useCallback(
    async (s: string, label: string) => {
      await navigator.clipboard.writeText(s)
      setToast(`Copied ${label}`)
    },
    [setToast]
  )
  const copyImage = useCallback(
    async (h: SlideResult) => {
      setToast((await window.sw.archive.copyImage(h.thumbUrl)) ? 'Copied WebP (for TalkWeaver)' : 'No image to copy')
    },
    [setToast]
  )
  const copyImagePng = useCallback(
    async (h: SlideResult) => {
      setToast((await window.sw.archive.copyImagePng(h.thumbUrl)) ? 'Copied PNG' : 'No image to copy')
    },
    [setToast]
  )
  const copyStructure = useCallback(
    async (h: SlideResult) => {
      const s = await window.sw.archive.slideStructure(h.deck, h.slideOrder)
      if (s) await copyText(s, 'slide structure')
      else setToast('No structure found')
    },
    [copyText, setToast]
  )
  const reveal = useCallback(
    async (h: SlideResult) => {
      setToast((await window.sw.archive.reveal(h.thumbUrl)) ? 'Revealed in Finder' : 'No file on disk')
    },
    [setToast]
  )
  const openLightbox = useCallback((list: SlideResult[], index: number) => setLightbox({ list, index }), [])

  // lightbox keyboard nav
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLightbox(null)
      else if (e.key === 'ArrowRight') setLightbox((l) => (l ? { ...l, index: Math.min(l.index + 1, l.list.length - 1) } : l))
      else if (e.key === 'ArrowLeft') setLightbox((l) => (l ? { ...l, index: Math.max(l.index - 1, 0) } : l))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  // The backend searches on a query (≥2 chars) OR a date/category filter — owner/role just narrow.
  // The Well tab always browses (no query needed). So "type to search" shows only when none apply.
  const idle = !debounced && filters.era === 'all' && filters.category === '' && filters.scope !== 'well'

  return (
    <div className="app" onClick={() => menu && setMenu(null)}>
      <header className="titlebar">
        <span className="wordmark">
          Slide<span className="well">Well</span>
        </span>
        <span className="tagline">the well — your slides &amp; images in one place</span>
      </header>

      <div className="searchbar">
        <input
          className="search-input"
          placeholder="Search slide text &amp; OCR…  (try: year:2024 deck:roundup owner:all)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="filterbar">
        <label className="filter">
          <span className="filter-label">Source</span>
          <div className="scope" role="tablist" aria-label="Source scope">
            {(['all', 'archive', 'well'] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={filters.scope === s}
                className={filters.scope === s ? 'scope-tab active' : 'scope-tab'}
                onClick={() => patch({ scope: s })}
              >
                {s === 'all' ? 'All' : s === 'archive' ? 'Archive' : 'Well'}
              </button>
            ))}
          </div>
        </label>
        <Select label="Owner" value={filters.owner} onChange={(v) => patch({ owner: v as SearchFilters['owner'] })}
          options={[
            { value: 'mine', label: 'My decks' },
            { value: 'all', label: 'All owners' },
            { value: 'others', label: 'Other authors' },
            { value: 'unknown', label: 'Unattributed' }
          ]} />
        <Select label="Date" value={filters.era} onChange={(v) => patch({ era: v })} options={ERA_OPTIONS} />
        <Select label="Category" value={filters.category} onChange={(v) => patch({ category: v })}
          options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c.category, label: `${c.category} (${c.count})` }))]} />
        <Select label="Slides" value={filters.role} onChange={(v) => patch({ role: v as SearchFilters['role'] })}
          options={[{ value: 'content', label: 'Content only' }, { value: 'all', label: 'Incl. structural' }]} />
        <button
          className={filters.cluster ? 'toggle on' : 'toggle'}
          onClick={() => patch({ cluster: !filters.cluster })}
          title="Collapse near-identical slides into one result"
        >
          ▸ Group near-identical
        </button>
      </div>

      <main className="results">
        {idle ? (
          <Empty title="Search 40,000 slides and their images." sub="Type a query, or pick a Date/Category filter. Power tokens: year:2024 · after:2023 · deck:roundup · cat:mondai · owner:all" />
        ) : loading ? (
          <div className="results-head">searching…</div>
        ) : clusters.length === 0 ? (
          filters.scope === 'well' && !debounced ? (
            <Empty title="Your well is empty." sub="Stash a screenshot via the Raycast hotkey, or it fills automatically from images you use in TalkWeaver." />
          ) : (
            <Empty title={debounced ? `No matches for “${debounced}”.` : 'No matches for these filters.'} sub="Try a different term or widen the filters." />
          )
        ) : (
          <>
            <div className="results-head">
              {clusters.length} result{clusters.length === 1 ? '' : 's'}
              {debounced ? ` for “${debounced}”` : ''}
              {filters.cluster ? ' · grouped' : ''}
            </div>
            <div className="grid">
              {clusters.map((c, i) => (
                <Card
                  key={`${c.representative.deck}-${c.representative.slideOrder}-${i}`}
                  cluster={c}
                  onThumb={() => openLightbox(reps, i)}
                  onMenu={(x, y) => setMenu({ cluster: c, x, y })}
                  onExpand={() => setExpanded(c)}
                />
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
            <button className="link" onClick={chooseArchive}>choose folder</button>
          </span>
        )}
        <span className="path" title={archivePath}>{archivePath}</span>
      </footer>

      {menu && (
        <ContextMenu
          cluster={menu.cluster}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            const h = menu.cluster.representative
            setMenu(null)
            if (action === 'fullsize') openLightbox([h], 0)
            else if (action === 'copy-image') void copyImage(h)
            else if (action === 'copy-image-png') void copyImagePng(h)
            else if (action === 'copy-text') void copyText(h.text, 'slide text')
            else if (action === 'copy-structure') void copyStructure(h)
            else if (action === 'copy-ref') void copyText(h.reference, 'reference')
            else if (action === 'reveal') void reveal(h)
            else if (action === 'expand') setExpanded(menu.cluster)
            else if (action === 'details') setDetails(h)
          }}
        />
      )}

      {lightbox && (
        <Lightbox
          hit={lightbox.list[lightbox.index]}
          index={lightbox.index}
          total={lightbox.list.length}
          onClose={() => setLightbox(null)}
          onPrev={() => setLightbox((l) => (l ? { ...l, index: Math.max(l.index - 1, 0) } : l))}
          onNext={() => setLightbox((l) => (l ? { ...l, index: Math.min(l.index + 1, l.list.length - 1) } : l))}
          onCopyRef={(h) => void copyText(h.reference, 'reference')}
        />
      )}

      {expanded && (
        <ClusterModal
          cluster={expanded}
          onClose={() => setExpanded(null)}
          onOpen={(idx) => {
            setLightbox({ list: expanded.members, index: idx })
          }}
        />
      )}

      {details && (
        <DetailsModal
          hit={details}
          onClose={() => setDetails(null)}
          onCopyText={() => void copyText(details.text, 'slide text')}
          onCopyRef={() => void copyText(details.reference, 'reference')}
          onCopyStructure={() => void copyStructure(details)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Select({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): JSX.Element {
  return (
    <label className="filter">
      <span className="filter-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function clusterBadge(c: SlideClusterResult): string {
  if (c.size > 1) return `▸ ${c.size} near-identical in ${c.deckCount} deck${c.deckCount === 1 ? '' : 's'}`
  if (c.representative.usedInDecks > 1) return `used in ${c.representative.usedInDecks} decks`
  return ''
}

function Card({
  cluster,
  onThumb,
  onMenu,
  onExpand
}: {
  cluster: SlideClusterResult
  onThumb: () => void
  onMenu: (x: number, y: number) => void
  onExpand: () => void
}): JSX.Element {
  const h = cluster.representative
  const isWell = h.kind === 'well-image'
  const ocr = h.kind === 'ocr-render' || h.kind === 'ocr-image'
  const badge = clusterBadge(cluster)
  const foot = [h.filename || h.deck, h.slideOrder !== null ? `#${h.slideOrder}` : '', h.date ? h.date.slice(0, 10) : '', h.category]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="card" onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY) }}>
      <div className="thumb-wrap" onClick={onThumb} title="Open full size">
        {h.thumbUrl ? (
          <img className="thumb" src={h.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : (
          <div className="thumb placeholder" aria-hidden />
        )}
        {isWell ? <span className="ocr-tag well">WELL</span> : ocr ? <span className="ocr-tag">OCR</span> : null}
        <button
          className="more"
          title="Actions"
          onClick={(e) => { e.stopPropagation(); onMenu(e.clientX, e.clientY) }}
        >⋯</button>
      </div>
      <div className="meta">
        <div className="card-title" title={h.title}>{h.title}</div>
        {h.snippet && <div className="snippet">{ocr ? '[OCR] ' : ''}{h.snippet}</div>}
        <div className="card-foot">
          <span className="deck" title={foot}>{foot}</span>
          {badge && (
            <span className={cluster.size > 1 ? 'badge clickable' : 'badge'} onClick={cluster.size > 1 ? onExpand : undefined}>
              {badge}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

type ActionId = 'fullsize' | 'copy-image' | 'copy-image-png' | 'copy-text' | 'copy-structure' | 'copy-ref' | 'reveal' | 'expand' | 'details'

function ContextMenu({
  cluster,
  x,
  y,
  onClose,
  onAction
}: {
  cluster: SlideClusterResult
  x: number
  y: number
  onClose: () => void
  onAction: (a: ActionId) => void
}): JSX.Element {
  const items: { id: ActionId; label: string }[] = [
    { id: 'fullsize', label: 'Open full size' },
    { id: 'copy-image', label: 'Copy image (WebP → TalkWeaver)' },
    { id: 'copy-image-png', label: 'Copy as PNG' },
    { id: 'copy-text', label: 'Copy text' },
    { id: 'copy-structure', label: 'Copy structure (JSON)' },
    { id: 'copy-ref', label: 'Copy reference' },
    { id: 'reveal', label: 'Reveal in Finder' },
    ...(cluster.size > 1 ? [{ id: 'expand' as ActionId, label: `Expand cluster (${cluster.size})` }] : []),
    { id: 'details', label: 'Show details' }
  ]
  // keep the menu on-screen
  const left = Math.min(x, window.innerWidth - 220)
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16)
  return (
    <>
      <div className="menu-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div className="ctx-menu" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
        {items.map((it) => (
          <button key={it.id} className="ctx-item" onClick={() => onAction(it.id)}>{it.label}</button>
        ))}
      </div>
    </>
  )
}

function Lightbox({
  hit,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onCopyRef
}: {
  hit: SlideResult
  index: number
  total: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onCopyRef: (h: SlideResult) => void
}): JSX.Element {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="lb-stage">
          {total > 1 && <button className="lb-nav left" onClick={onPrev} disabled={index === 0}>‹</button>}
          {hit.thumbUrl ? <img className="lb-img" src={hit.thumbUrl} alt={hit.title} /> : <div className="lb-img placeholder">no render</div>}
          {total > 1 && <button className="lb-nav right" onClick={onNext} disabled={index === total - 1}>›</button>}
        </div>
        <div className="lb-bar">
          <div className="lb-title">{hit.title}</div>
          <div className="lb-meta">{[hit.deckTitle, hit.slideOrder !== null ? `slide ${hit.slideOrder + 1}` : '', total > 1 ? `${index + 1}/${total}` : ''].filter(Boolean).join(' · ')}</div>
          <button className="copyref" onClick={() => onCopyRef(hit)}>copy ref</button>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
      </div>
    </div>
  )
}

function ClusterModal({
  cluster,
  onClose,
  onOpen
}: {
  cluster: SlideClusterResult
  onClose: () => void
  onOpen: (index: number) => void
}): JSX.Element {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{cluster.size} near-identical slides</b> across {cluster.deckCount} deck{cluster.deckCount === 1 ? '' : 's'}
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        <div className="grid">
          {cluster.members.map((m, i) => (
            <div className="card" key={`${m.deck}-${m.slideOrder}-${i}`}>
              <div className="thumb-wrap" onClick={() => onOpen(i)} title="Open full size">
                {m.thumbUrl ? <img className="thumb" src={m.thumbUrl} alt="" loading="lazy" /> : <div className="thumb placeholder" />}
              </div>
              <div className="meta">
                <div className="card-foot"><span className="deck">{m.filename || m.deck}{m.slideOrder !== null ? ` · #${m.slideOrder}` : ''}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DetailsModal({
  hit,
  onClose,
  onCopyText,
  onCopyRef,
  onCopyStructure
}: {
  hit: SlideResult
  onClose: () => void
  onCopyText: () => void
  onCopyRef: () => void
  onCopyStructure: () => void
}): JSX.Element {
  const rows: [string, string][] = [
    ['Deck', hit.deckTitle || hit.deck],
    ['File', hit.filename],
    ['Slide', hit.slideOrder !== null ? String(hit.slideOrder + 1) : '—'],
    ['Date', hit.date ? hit.date.slice(0, 10) : '—'],
    ['Category', hit.category || '—'],
    ['Used in', `${hit.usedInDecks} deck${hit.usedInDecks === 1 ? '' : 's'}`],
    ['Matched', hit.kind === 'slide' ? 'slide body' : 'image text (OCR)'],
    ['Reference', hit.reference]
  ]
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal details" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{hit.title}</b>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        <div className="details-body">
          {hit.thumbUrl && <img className="details-img" src={hit.thumbUrl} alt={hit.title} />}
          <div className="details-table">
            {rows.map(([k, v]) => (
              <div className="drow" key={k}><span className="dk">{k}</span><span className="dv">{v}</span></div>
            ))}
            {hit.text && <div className="details-text">{hit.text}</div>}
            <div className="details-actions">
              <button className="copyref" onClick={onCopyText}>copy text</button>
              <button className="copyref" onClick={onCopyStructure}>copy structure</button>
              <button className="copyref" onClick={onCopyRef}>copy ref</button>
            </div>
          </div>
        </div>
      </div>
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

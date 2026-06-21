import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlideResult, SlideClusterResult, SearchFilters, CategoryCount, DeckInfo, DeckCard, DeckDetail, Stats, TriageItem, TriageCounts } from '../../preload'

type SortKey = 'date-desc' | 'date-asc' | 'title'

const DEFAULT_FILTERS: SearchFilters = { owner: 'mine', era: 'all', category: '', deck: '', role: 'content', cluster: true, scope: 'all', type: 'slides' }

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
  const [decks, setDecks] = useState<DeckInfo[]>([])
  const [sort, setSort] = useState<SortKey>('date-desc')
  const [groupByDeck, setGroupByDeck] = useState(false)
  const [clusters, setClusters] = useState<SlideClusterResult[]>([])
  const [deckCards, setDeckCards] = useState<DeckCard[]>([])
  const [selectedDeck, setSelectedDeck] = useState<(DeckDetail & { coverThumbUrl: string | null }) | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToastMsg] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ cluster: SlideClusterResult; x: number; y: number } | null>(null)
  const [lightbox, setLightbox] = useState<{ list: SlideResult[]; index: number } | null>(null)
  const [expanded, setExpanded] = useState<SlideClusterResult | null>(null)
  const [details, setDetails] = useState<SlideResult | null>(null)
  // "See in context": when set, the main grid shows this whole presentation in slide order,
  // every slide fully usable (not a read-only popup). Cleared by typing or changing a filter.
  const [deckFilter, setDeckFilter] = useState<{ pid: string; title: string } | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showTriage, setShowTriage] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  // keyboard selection + inspector + command palette
  const [sel, setSel] = useState(-1)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const reqId = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const setToast = useCallback((msg: string) => {
    setToastMsg(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 1400)
  }, [])

  // Changing any filter exits deck-context (you're back to searching/browsing the whole archive).
  const patch = (p: Partial<SearchFilters>): void => {
    setDeckFilter(null)
    setFilters((f) => ({ ...f, ...p }))
  }

  useEffect(() => {
    void (async () => {
      const paths = await window.sw.settings.getPaths()
      setArchiveOk(paths.archiveAvailable)
      setArchivePath(paths.archiveRoot ?? paths.archiveDefault)
      if (paths.archiveAvailable) {
        setCategories(await window.sw.archive.categories())
        setDecks(await window.sw.archive.decks())
      }
    })()
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const id = ++reqId.current
    setLoading(true)
    void (async () => {
      // Deck MODE (browse presentations) — unless we're scoped into one deck via "see in context".
      if (filters.type === 'decks' && !deckFilter) {
        const d = await window.sw.archive.listDecks(filters)
        if (id !== reqId.current) return
        setDeckCards(d)
        setClusters([])
        setLoading(false)
        return
      }
      const res = deckFilter
        ? (await window.sw.archive.deckSlides(deckFilter.pid)).map((s) => ({ representative: s, members: [s], size: 1, deckCount: 1 }))
        : await window.sw.archive.search(debounced, filters)
      if (id !== reqId.current) return
      setDeckCards([])
      setClusters(res)
      setLoading(false)
    })()
  }, [debounced, filters, refreshKey, deckFilter])

  // ----- actions (defined before selection/keyboard handlers that reference them) -----
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

  // Sort + optional group-by-presentation. Nested: groups order by date/title, slides within by number.
  const view = useMemo(() => {
    const primary = (a: SlideResult, b: SlideResult): number => {
      if (sort === 'title') return a.title.localeCompare(b.title)
      const da = a.date || ''
      const db = b.date || ''
      return sort === 'date-asc' ? da.localeCompare(db) : db.localeCompare(da)
    }
    if (!groupByDeck) {
      return { groups: null, flat: [...clusters].sort((x, y) => primary(x.representative, y.representative)) }
    }
    const byDeck = new Map<string, SlideClusterResult[]>()
    for (const c of clusters) {
      const k = c.representative.deck
      const arr = byDeck.get(k)
      if (arr) arr.push(c)
      else byDeck.set(k, [c])
    }
    const groups = [...byDeck.entries()].map(([deck, cs]) => ({
      deck,
      title: cs[0].representative.deckTitle || deck,
      date: cs[0].representative.date,
      slides: [...cs].sort((a, b) => (a.representative.slideOrder ?? 0) - (b.representative.slideOrder ?? 0))
    }))
    groups.sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'date-asc'
          ? String(a.date || '').localeCompare(String(b.date || ''))
          : String(b.date || '').localeCompare(String(a.date || ''))
    )
    return { groups, flat: null }
  }, [clusters, sort, groupByDeck])

  // deck-mode cards, sorted by the same Sort control
  const sortedDecks = useMemo(() => {
    return [...deckCards].sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'date-asc'
          ? String(a.date || '').localeCompare(String(b.date || ''))
          : String(b.date || '').localeCompare(String(a.date || ''))
    )
  }, [deckCards, sort])

  // representatives in render order, so the lightbox steps through what's shown
  const orderedReps = useMemo(
    () => (view.groups ? view.groups.flatMap((g) => g.slides.map((c) => c.representative)) : (view.flat ?? []).map((c) => c.representative)),
    [view]
  )

  // keyboard selection model: one list of items (slides/images OR decks), a current selection.
  const deckMode = filters.type === 'decks' && !deckFilter
  const navCount = deckMode ? sortedDecks.length : orderedReps.length
  const current: SlideResult | DeckCard | null = sel >= 0 && sel < navCount ? (deckMode ? sortedDecks[sel] : orderedReps[sel]) : null
  const selectedRep = !deckMode && sel >= 0 && sel < orderedReps.length ? orderedReps[sel] : null
  // the lightbox-aware target for ⌘K / shortcuts: the image being viewed in the slideshow, else the grid selection
  const activeItem: SlideResult | DeckCard | null = lightbox ? lightbox.list[lightbox.index] : current
  // other slides of the same group (group-by-presentation) — shown in the inspector
  const siblings = useMemo<SlideResult[]>(() => {
    if (!selectedRep || !view.groups) return []
    const g = view.groups.find((grp) => grp.slides.some((c) => c.representative === selectedRep))
    return g ? g.slides.map((c) => c.representative) : []
  }, [selectedRep, view])

  // reset selection when the result set changes
  useEffect(() => setSel(-1), [debounced, filters, deckFilter, refreshKey])

  const openStats = useCallback(() => {
    setShowStats(true)
    if (!stats) void window.sw.archive.stats().then(setStats)
  }, [stats])

  const activateCurrent = useCallback(() => {
    if (!current) return
    if (deckMode) {
      const d = current as DeckCard
      setFilters((f) => ({ ...f, type: 'slides' }))
      setDeckFilter({ pid: d.id, title: d.title })
    } else {
      openLightbox(orderedReps, sel)
    }
  }, [current, deckMode, orderedReps, sel, openLightbox])

  // run a command-palette action against the active item: the lightbox image if the slideshow is
  // open, otherwise the grid selection (deck card or slide). The lightbox path fixes the off-by-one
  // where ⌘K acted on `current` (the grid sel) instead of the image actually on screen.
  const runAction = useCallback(
    (action: ActionId) => {
      const target = activeItem
      if (!target) return
      // deck-mode actions apply only to a deck card in the grid, never to a lightbox image
      if (deckMode && !lightbox) {
        const d = target as DeckCard
        if (action === 'context' || action === 'fullsize') {
          setFilters((f) => ({ ...f, type: 'slides' }))
          setDeckFilter({ pid: d.id, title: d.title })
        } else if (action === 'details') setInspectorOpen(true)
        else if (action === 'reveal') void window.sw.archive.reveal(d.coverThumbUrl)
        return
      }
      const h = target as SlideResult
      if (action === 'fullsize') {
        if (!lightbox) openLightbox(orderedReps, sel)
      } else if (action === 'details') setInspectorOpen(true)
      else if (action === 'copy-image') void copyImage(h)
      else if (action === 'copy-image-png') void copyImagePng(h)
      else if (action === 'copy-text') void copyText(h.text, 'slide text')
      else if (action === 'copy-structure') void copyStructure(h)
      else if (action === 'copy-ref') void copyText(h.reference, 'reference')
      else if (action === 'reveal') void reveal(h)
      else if (action === 'context') {
        setLightbox(null)
        setDeckFilter({ pid: h.deck, title: h.deckTitle || h.deck })
      }
    },
    [activeItem, lightbox, deckMode, orderedReps, sel, openLightbox, copyImage, copyImagePng, copyText, copyStructure, reveal]
  )

  // global keyboard layer
  useEffect(() => {
    // move the selection one visual row up (dir=-1) or down (dir=+1). Works from the rendered card
    // geometry, so it respects the live column count and group boundaries; picks the card on the
    // nearest adjacent row whose horizontal centre is closest to the current one.
    const moveByRow = (dir: 1 | -1): void => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>('main .grid .card'))
      if (cards.length === 0) return
      if (sel < 0) {
        setSel(0)
        return
      }
      const cur = cards[sel]?.getBoundingClientRect()
      if (!cur) return
      const curMidX = cur.left + cur.width / 2
      let best = -1
      let bestScore = Infinity
      for (let k = 0; k < cards.length; k++) {
        const r = cards[k].getBoundingClientRect()
        const rowDelta = r.top - cur.top
        const onAdjacentSide = dir > 0 ? rowDelta > cur.height * 0.5 : rowDelta < -cur.height * 0.5
        if (!onAdjacentSide) continue
        const dx = Math.abs(r.left + r.width / 2 - curMidX)
        const score = Math.abs(rowDelta) * 10000 + dx // nearest row first, then nearest column
        if (score < bestScore) {
          bestScore = score
          best = k
        }
      }
      setSel(best >= 0 ? best : dir > 0 ? navCount - 1 : 0)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (showTriage) return // the Triage panel owns the keyboard while it is open
      const el = document.activeElement as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      const cmd = e.metaKey || e.ctrlKey
      if (cmd && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        // works over the lightbox too — acts on the image on screen, not the grid selection
        if (lightbox || navCount > 0) {
          if (!lightbox && sel < 0) setSel(0)
          setPaletteOpen(true)
        }
        return
      }
      if (cmd && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      // ⌘C copies the active image as WebP (TalkWeaver), ⌘⇧C as PNG — unless the user is
      // selecting text (e.g. in the inspector JSON), where native copy should win.
      if (cmd && e.key.toLowerCase() === 'c' && activeItem && !(deckMode && !lightbox)) {
        const hasSelection = (window.getSelection()?.toString().length ?? 0) > 0
        if (!hasSelection) {
          e.preventDefault()
          runAction(e.shiftKey ? 'copy-image-png' : 'copy-image')
          return
        }
      }
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        else if (lightbox) setLightbox(null)
        else if (showHelp) setShowHelp(false)
        else if (showStats) setShowStats(false)
        else if (showImport) setShowImport(false)
        else if (inspectorOpen) setInspectorOpen(false)
        else if (deckFilter) setDeckFilter(null)
        else if (typing) el?.blur()
        return
      }
      if (typing || cmd) return
      switch (e.key) {
        case '/':
          e.preventDefault()
          searchRef.current?.focus()
          break
        case '?':
          setShowHelp(true)
          break
        // arrows move the grid selection; while the lightbox is open it owns ←/→ (its own listener)
        case 'ArrowRight':
          if (navCount && !lightbox) {
            e.preventDefault()
            setSel((s) => Math.min(s < 0 ? 0 : s + 1, navCount - 1))
          }
          break
        case 'ArrowLeft':
          if (navCount && !lightbox) {
            e.preventDefault()
            setSel((s) => Math.max(s <= 0 ? 0 : s - 1, 0))
          }
          break
        case 'ArrowDown':
          if (navCount && !lightbox) {
            e.preventDefault()
            moveByRow(1)
          }
          break
        case 'ArrowUp':
          if (navCount && !lightbox) {
            e.preventDefault()
            moveByRow(-1)
          }
          break
        case 'Enter':
          if (!lightbox) activateCurrent()
          break
        case 'i':
        case 'I':
        case ' ':
          if (navCount) {
            e.preventDefault()
            if (sel < 0) setSel(0)
            setInspectorOpen((o) => !o)
          }
          break
        case '1':
          patch({ type: 'slides' })
          break
        case '2':
          patch({ type: 'images' })
          break
        case '3':
          patch({ type: 'decks' })
          break
        case 'g':
        case 'G':
          setGroupByDeck((x) => !x)
          break
        case 'c':
        case 'C':
          patch({ cluster: !filters.cluster })
          break
        case 's':
        case 'S':
          openStats()
          break
        case 'o':
        case 'O':
          setShowImport(true)
          break
        // action shortcuts (mirrored in the ⌘K palette) — act on the active item
        case 't':
        case 'T':
          if (activeItem) {
            e.preventDefault()
            runAction('copy-text')
          }
          break
        case 'j':
        case 'J':
          if (activeItem) {
            e.preventDefault()
            runAction('copy-structure')
          }
          break
        case 'r':
        case 'R':
          if (activeItem) {
            e.preventDefault()
            runAction('copy-ref')
          }
          break
        case 'f':
        case 'F':
          if (activeItem) {
            e.preventDefault()
            runAction('reveal')
          }
          break
        case 'x':
        case 'X':
          if (activeItem) {
            e.preventDefault()
            runAction('context')
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navCount, sel, activeItem, runAction, activateCurrent, paletteOpen, lightbox, deckMode, inspectorOpen, showHelp, showStats, showImport, showTriage, deckFilter, filters, openStats])

  // when inspecting a deck, fetch its full metadata (re-fetches as selection moves)
  useEffect(() => {
    if (inspectorOpen && deckMode && current) {
      const d = current as DeckCard
      void window.sw.archive.deckDetail(d.id).then((det) => {
        if (det) setSelectedDeck({ ...det, coverThumbUrl: d.coverThumbUrl })
      })
    }
  }, [inspectorOpen, deckMode, current])

  // keep the selected card scrolled into view as you arrow through
  useEffect(() => {
    if (sel >= 0) document.querySelector('.card.selected, .deck-card.selected')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  async function chooseArchive(): Promise<void> {
    const picked = await window.sw.settings.chooseArchive()
    if (picked) {
      setArchivePath(picked)
      const ok = await window.sw.archive.available()
      setArchiveOk(ok)
      if (ok) setCategories(await window.sw.archive.categories())
    }
  }

  return (
    <div className={inspectorOpen ? 'app has-sidebar' : 'app'} onClick={() => menu && setMenu(null)}>
      <header className="titlebar">
        <span className="wordmark">
          Slide<span className="well">Well</span>
        </span>
        <span className="tagline">the well — your slides &amp; images in one place</span>
        <div className="titlebar-actions">
          <button
            className="tb-btn"
            onClick={() => {
              setShowStats(true)
              if (!stats) void window.sw.archive.stats().then(setStats)
            }}
            title="Your PowerPoint history in numbers (S)"
          >
            📊 Stats
          </button>
          <button className="tb-btn" onClick={() => setShowTriage(true)} title="Triage screenshots & videos from your source folder">
            ⛏ Triage
          </button>
          <button className="tb-btn" onClick={() => setShowImport(true)} title="Import PowerPoint into the archive (O)">
            ⤓ Import
          </button>
          <button className="tb-btn" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (?)">
            ⌨
          </button>
        </div>
      </header>

      <div className="searchbar">
        <input
          ref={searchRef}
          className="search-input"
          placeholder="Search slide text &amp; OCR…   /  focus · ⌘K actions · ←→ navigate · I inspector"
          value={query}
          onChange={(e) => {
            setDeckFilter(null)
            setQuery(e.target.value)
          }}
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
        <label className="filter">
          <span className="filter-label">Type</span>
          <div className="scope" role="tablist" aria-label="Content type">
            {(['slides', 'images', 'decks'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={filters.type === t}
                className={filters.type === t ? 'scope-tab active' : 'scope-tab'}
                onClick={() => patch({ type: t })}
              >
                {t === 'slides' ? 'Slides' : t === 'images' ? 'Images' : 'Decks'}
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
        <SearchableSelect
          label="Category"
          value={filters.category}
          allLabel="All categories"
          options={categories.map((c) => ({ value: c.category, label: c.category, count: c.count }))}
          onChange={(v) => patch({ category: v })}
        />
        <SearchableSelect
          label="Deck"
          value={filters.deck}
          allLabel="All decks"
          options={decks.map((d) => ({ value: d.title, label: d.title }))}
          onChange={(v) => patch({ deck: v })}
        />
        <Select label="Role" value={filters.role} onChange={(v) => patch({ role: v as SearchFilters['role'] })}
          options={[{ value: 'content', label: 'Content only' }, { value: 'all', label: 'Incl. structural' }]} />
        <Select label="Sort" value={sort} onChange={(v) => setSort(v as SortKey)}
          options={[{ value: 'date-desc', label: 'Newest' }, { value: 'date-asc', label: 'Oldest' }, { value: 'title', label: 'Title A–Z' }]} />
        <button
          className={filters.cluster ? 'toggle on' : 'toggle'}
          onClick={() => patch({ cluster: !filters.cluster })}
          title="Collapse near-identical slides into one result"
        >
          ▸ Group near-identical
        </button>
        <button
          className={groupByDeck ? 'toggle on' : 'toggle'}
          onClick={() => setGroupByDeck((g) => !g)}
          title="Group results into per-presentation sections (G)"
        >
          ▦ Group by presentation
        </button>
      </div>

      <main className="results">
        {filters.type === 'decks' && !deckFilter ? (
          loading ? (
            <div className="results-head">loading…</div>
          ) : sortedDecks.length === 0 ? (
            <Empty title="No presentations match these filters." sub="Widen the Date / Owner / Category / Deck filters." />
          ) : (
            <>
              <div className="results-head">
                {sortedDecks.length} presentation{sortedDecks.length === 1 ? '' : 's'} — click one for details
              </div>
              <div className="grid deck-grid">
                {sortedDecks.map((d, i) => (
                  <DeckCardView
                    key={d.id}
                    deck={d}
                    selected={current === d}
                    onSelect={() => {
                      setSel(i)
                      setInspectorOpen(true)
                    }}
                  />
                ))}
              </div>
            </>
          )
        ) : loading ? (
          <div className="results-head">loading…</div>
        ) : clusters.length === 0 ? (
          filters.scope === 'well' ? (
            <Empty title="Your well is empty." sub="Stash a screenshot via the Raycast hotkey, or it fills automatically from images you use in TalkWeaver." />
          ) : (
            <Empty title={debounced ? `No matches for “${debounced}”.` : 'No slides match these filters.'} sub="Try a different term or widen the filters." />
          )
        ) : (
          <>
            {deckFilter ? (
              <div className="context-banner">
                <span>
                  In context: <b>{deckFilter.title}</b> — {clusters.length} slide{clusters.length === 1 ? '' : 's'} in order. Use any of them.
                </span>
                <button className="link" onClick={() => setDeckFilter(null)}>✕ exit context</button>
              </div>
            ) : (
              <div className="results-head">
                {debounced
                  ? `${clusters.length} result${clusters.length === 1 ? '' : 's'} for “${debounced}”`
                  : `${clusters.length} slide${clusters.length === 1 ? '' : 's'}`}
                {groupByDeck ? ` · ${view.groups?.length ?? 0} presentation${(view.groups?.length ?? 0) === 1 ? '' : 's'}` : ''}
                {filters.cluster ? ' · near-identical grouped' : ''}
              </div>
            )}
            {view.groups ? (
              view.groups.map((g) => (
                <div className="deck-group" key={g.deck}>
                  <div className="deck-group-head">
                    <b>{g.title}</b>
                    {g.date ? ` · ${g.date.slice(0, 10)}` : ''} · {g.slides.length} slide{g.slides.length === 1 ? '' : 's'}
                  </div>
                  <div className="grid">
                    {g.slides.map((c, j) => {
                      const idx = orderedReps.indexOf(c.representative)
                      return (
                        <Card
                          key={`${g.deck}-${j}`}
                          cluster={c}
                          selected={c.representative === selectedRep}
                          onSelect={() => setSel(idx)}
                          onThumb={() => {
                            setSel(idx)
                            openLightbox(orderedReps, idx)
                          }}
                          onMenu={(x, y) => setMenu({ cluster: c, x, y })}
                          onExpand={() => setExpanded(c)}
                        />
                      )
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="grid">
                {(view.flat ?? []).map((c, i) => (
                  <Card
                    key={`${c.representative.deck}-${c.representative.slideOrder}-${i}`}
                    cluster={c}
                    selected={c.representative === selectedRep}
                    onSelect={() => setSel(i)}
                    onThumb={() => {
                      setSel(i)
                      openLightbox(orderedReps, i)
                    }}
                    onMenu={(x, y) => setMenu({ cluster: c, x, y })}
                    onExpand={() => setExpanded(c)}
                  />
                ))}
              </div>
            )}
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
            else if (action === 'context') setDeckFilter({ pid: h.deck, title: h.deckTitle || h.deck })
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

      {inspectorOpen &&
        (deckMode
          ? selectedDeck && (
              <DeckSidebar
                detail={selectedDeck}
                onClose={() => setInspectorOpen(false)}
                onSeeAll={() => {
                  const pid = selectedDeck.id
                  const title = selectedDeck.title
                  setInspectorOpen(false)
                  setFilters((f) => ({ ...f, type: 'slides' }))
                  setDeckFilter({ pid, title })
                }}
                onReveal={() => void window.sw.archive.reveal(selectedDeck.coverThumbUrl)}
              />
            )
          : selectedRep && (
              <SlideInspector
                hit={selectedRep}
                pos={`${sel + 1} / ${orderedReps.length}`}
                siblings={siblings}
                onNavigate={(rep) => {
                  const idx = orderedReps.indexOf(rep)
                  if (idx >= 0) setSel(idx)
                }}
                onClose={() => setInspectorOpen(false)}
                onFullsize={() => openLightbox(orderedReps, sel)}
                onCopyText={() => void copyText(selectedRep.text, 'slide text')}
                onCopyRef={() => void copyText(selectedRep.reference, 'reference')}
                onCopyImage={() => void copyImage(selectedRep)}
                onReveal={() => void reveal(selectedRep)}
                onContext={
                  selectedRep.kind !== 'well-image'
                    ? () => {
                        setInspectorOpen(false)
                        setDeckFilter({ pid: selectedRep.deck, title: selectedRep.deckTitle || selectedRep.deck })
                      }
                    : undefined
                }
              />
            ))}

      {paletteOpen && activeItem && (
        <CommandPalette
          item={activeItem}
          deckMode={deckMode && !lightbox}
          onClose={() => setPaletteOpen(false)}
          onRun={(a) => {
            setPaletteOpen(false)
            runAction(a)
          }}
        />
      )}

      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

      {showImport && <ImportPanel onClose={() => setShowImport(false)} onDone={() => setRefreshKey((k) => k + 1)} />}

      {showTriage && <TriagePanel onClose={() => setShowTriage(false)} onChanged={() => setRefreshKey((k) => k + 1)} onToast={setToast} />}

      {showStats && <StatsPanel stats={stats} onClose={() => setShowStats(false)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

// ADR-0029: triage a source folder of screenshots/videos. Reads but never owns the folder; include
// promotes a file into the well, exclude remembers its hash. The App's global keyboard layer yields
// to this panel (it bails while showTriage), so we run our own.
function TriagePanel({ onClose, onChanged, onToast }: { onClose: () => void; onChanged: () => void; onToast: (m: string) => void }): JSX.Element {
  const [root, setRoot] = useState<string | null | undefined>(undefined) // undefined = loading, null = unset
  const [items, setItems] = useState<TriageItem[]>([])
  const [counts, setCounts] = useState<TriageCounts>({ undecided: 0, included: 0, excluded: 0, total: 0 })
  const [q, setQ] = useState('')
  const [debq, setDebq] = useState('')
  const [stateFilter, setStateFilter] = useState<'undecided' | 'included' | 'excluded' | 'all'>('undecided')
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState('')
  const [sel, setSel] = useState(0)
  const [preview, setPreview] = useState<TriageItem | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebq(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const refresh = useCallback(async () => {
    try {
      const r = await window.sw.triage.list(debq, stateFilter)
      setItems(r.items)
      setCounts(r.counts)
      setSel((s) => Math.min(s, Math.max(0, r.items.length - 1)))
    } catch {
      /* a mid-scan read may briefly lose to a write; the next tick retries */
    }
  }, [debq, stateFilter])

  // Lazy load: as the scan streams progress, re-list (throttled) so rows appear as they land —
  // the user sees continuous movement instead of a blank "scanning…".
  const refreshRef = useRef(refresh)
  const lastTickRef = useRef(0)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])
  useEffect(() => {
    void window.sw.settings.getPaths().then((p) => setRoot(p.screenshotRoot))
    return window.sw.triage.onProgress((line) => {
      setProgress(line)
      const now = Date.now()
      if (now - lastTickRef.current > 600) {
        lastTickRef.current = now
        void refreshRef.current()
      }
    })
  }, [])

  useEffect(() => {
    if (root) void refresh()
  }, [root, refresh])

  const scan = useCallback(async () => {
    setScanning(true)
    setProgress('scanning…')
    const r = await window.sw.triage.scan()
    setScanning(false)
    setProgress(r.ok ? `${r.indexed} new · ${r.total} media files` : 'scan failed')
    await refresh()
  }, [refresh])

  const chooseFolder = useCallback(async () => {
    const p = await window.sw.settings.chooseScreenshotFolder()
    if (!p) return
    setRoot(p)
    setScanning(true)
    setProgress('scanning…')
    const r = await window.sw.triage.scan()
    setScanning(false)
    setProgress(`${r.indexed} new · ${r.total} media files`)
    await refresh()
  }, [refresh])

  const decide = useCallback(
    async (item: TriageItem, action: 'include' | 'exclude' | 'reset') => {
      if (action === 'include' && item.offline) {
        onToast('Not downloaded — open it in OneDrive first')
        return
      }
      let force = false
      if (action === 'include' && item.large) {
        if (!window.confirm(`“${item.filename}” is ${item.sizeMB} MB — over the 20 MB video gate. Include it anyway?`)) return
        force = true
      }
      const r = await window.sw.triage.decide(item.hash, action, force)
      if (r.gated) {
        onToast(`Gated at 20 MB (${r.sizeMB} MB)`)
        return
      }
      onToast(action === 'include' ? 'Included → added to the well' : action === 'exclude' ? 'Excluded' : 'Reset')
      onChanged()
      await refresh()
    },
    [onChanged, onToast, refresh]
  )

  const paste = useCallback(async () => {
    const r = await window.sw.triage.paste()
    onToast(r ? 'Pasted → added to the well' : 'No image on the clipboard')
    if (r) onChanged()
  }, [onChanged, onToast])

  useEffect(() => {
    document.querySelector('.triage-card.selected')?.scrollIntoView({ block: 'nearest' })
  }, [sel, items])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      if (e.key === 'Escape') {
        if (preview) setPreview(null)
        else onClose()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void paste()
        return
      }
      if (preview) {
        if (e.key === 'i' || e.key === 'I') {
          e.preventDefault()
          void decide(preview, 'include')
          setPreview(null)
        } else if (e.key === 'x' || e.key === 'X') {
          e.preventDefault()
          void decide(preview, 'exclude')
          setPreview(null)
        }
        return
      }
      if (typing) return
      const cur = items[sel]
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setSel((s) => Math.min(s + 1, items.length - 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setSel((s) => Math.max(s - 1, 0))
      } else if ((e.key === 'Enter' || e.key === ' ') && cur) {
        e.preventDefault()
        setPreview(cur)
      } else if ((e.key === 'i' || e.key === 'I') && cur) {
        e.preventDefault()
        void decide(cur, 'include')
      } else if ((e.key === 'x' || e.key === 'X') && cur) {
        e.preventDefault()
        void decide(cur, 'exclude')
      } else if ((e.key === 'u' || e.key === 'U') && cur) {
        e.preventDefault()
        void decide(cur, 'reset')
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, sel, preview, decide, paste, onClose])

  return (
    <>
      <div className="overlay triage-overlay" onClick={onClose}>
        <div className="triage-panel" onClick={(e) => e.stopPropagation()}>
          <div className="triage-head">
            <b>⛏ Triage</b>
            {typeof root === 'string' && (
              <span className="triage-root" title={root}>
                {root}
              </span>
            )}
            <div className="triage-head-actions">
              <button className="tb-btn" onClick={() => void paste()} title="Paste an image from the clipboard (⌘V)">
                ⎘ Paste
              </button>
              <button className="tb-btn" onClick={() => void scan()} disabled={scanning || !root} title="Re-scan the source for new files">
                {scanning ? '… scanning' : '⟳ Rescan'}
              </button>
              <button className="tb-btn" onClick={() => void chooseFolder()}>
                {root ? '⌖ Change folder' : '⌖ Choose folder'}
              </button>
              <button className="copyref" onClick={onClose}>
                close ✕
              </button>
            </div>
          </div>

          {root === undefined ? (
            <div className="triage-empty">loading…</div>
          ) : root === null ? (
            <div className="triage-empty">
              <p>Pick a screenshots folder to triage. SlideWell reads it but never moves, renames, or changes your files — only the ones you include are copied into the well.</p>
              <button className="primary-btn" onClick={() => void chooseFolder()}>
                ⌖ Choose folder
              </button>
            </div>
          ) : (
            <>
              <div className="triage-controls">
                <input ref={searchRef} className="search-input" placeholder="Search text in screenshots…   /  focus · I include · X exclude · Enter preview" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="scope" role="tablist" aria-label="Triage state">
                  {(['undecided', 'included', 'excluded', 'all'] as const).map((s) => (
                    <button key={s} role="tab" aria-selected={stateFilter === s} className={stateFilter === s ? 'scope-tab active' : 'scope-tab'} onClick={() => setStateFilter(s)}>
                      {s[0].toUpperCase() + s.slice(1)}
                      {s !== 'all' ? ` ${counts[s]}` : ''}
                    </button>
                  ))}
                </div>
                {progress && <span className="triage-progress">{progress}</span>}
              </div>

              {items.length === 0 ? (
                <div className="triage-empty">
                  <p>{scanning ? 'Scanning…' : counts.total === 0 ? 'Nothing scanned yet.' : `No ${stateFilter} items.`}</p>
                  {counts.total === 0 && !scanning && (
                    <button className="primary-btn" onClick={() => void scan()}>
                      ⟳ Scan this folder
                    </button>
                  )}
                </div>
              ) : (
                <div className="triage-grid">
                  {items.map((it, i) => (
                    <TriageCard key={it.hash} item={it} selected={i === sel} onSelect={() => setSel(i)} onOpen={() => setPreview(it)} onDecide={(a) => void decide(it, a)} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {preview && (
        <TriagePreview
          item={preview}
          onClose={() => setPreview(null)}
          onDecide={(a) => {
            void decide(preview, a)
            setPreview(null)
          }}
        />
      )}
    </>
  )
}

function TriageCard({
  item,
  selected,
  onSelect,
  onOpen,
  onDecide
}: {
  item: TriageItem
  selected: boolean
  onSelect: () => void
  onOpen: () => void
  onDecide: (a: 'include' | 'exclude' | 'reset') => void
}): JSX.Element {
  const badge = item.state === 'included' ? '✓' : item.state === 'excluded' ? '✗' : ''
  return (
    <div className={`triage-card state-${item.state}${selected ? ' selected' : ''}${item.offline ? ' offline' : ''}`} onClick={onSelect} onDoubleClick={onOpen}>
      <div className="triage-thumb" onClick={(e) => { e.stopPropagation(); onOpen() }} title={item.offline ? 'Not downloaded from OneDrive yet' : 'Open preview'}>
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : item.offline ? (
          <div className="triage-cloud" aria-hidden>☁︎<span>not downloaded</span></div>
        ) : (
          <div className="thumb placeholder" aria-hidden />
        )}
        {item.kind === 'video' && !item.offline && <span className="triage-play">▶</span>}
        {item.kind === 'video' && <span className={item.large ? 'triage-size large' : 'triage-size'}>{item.sizeMB} MB{item.large ? ' ⚠' : ''}</span>}
        {badge && <span className={`triage-badge ${item.state}`}>{badge}</span>}
      </div>
      <div className="triage-meta">
        <div className="triage-name" title={item.filename}>{item.filename}</div>
        {item.snippet && <div className="triage-snip">{item.snippet}</div>}
      </div>
      <div className="triage-actions">
        {item.state !== 'included' && (
          <button className="ti-inc" disabled={item.offline} title={item.offline ? 'Download it in OneDrive first' : ''} onClick={(e) => { e.stopPropagation(); onDecide('include') }}>Include</button>
        )}
        {item.state !== 'excluded' && (
          <button className="ti-exc" onClick={(e) => { e.stopPropagation(); onDecide('exclude') }}>Exclude</button>
        )}
        {item.state !== 'undecided' && (
          <button className="ti-rst" onClick={(e) => { e.stopPropagation(); onDecide('reset') }}>Reset</button>
        )}
      </div>
    </div>
  )
}

function TriagePreview({ item, onClose, onDecide }: { item: TriageItem; onClose: () => void; onDecide: (a: 'include' | 'exclude' | 'reset') => void }): JSX.Element {
  return (
    <div className="overlay triage-preview-overlay" onClick={onClose}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="lb-stage">
          {item.kind === 'video' && item.mediaUrl ? (
            <video className="lb-img" src={item.mediaUrl} controls autoPlay />
          ) : item.thumbUrl ? (
            <img className="lb-img" src={item.thumbUrl} alt={item.filename} />
          ) : (
            <div className="lb-img placeholder">no preview</div>
          )}
        </div>
        <div className="lb-bar">
          <div className="lb-title">{item.filename}</div>
          <div className="lb-meta">{[item.kind, item.kind === 'video' ? `${item.sizeMB} MB` : '', `state: ${item.state}`].filter(Boolean).join(' · ')}</div>
          <button className="ti-inc" onClick={() => onDecide('include')}>Include (I)</button>
          <button className="ti-exc" onClick={() => onDecide('exclude')}>Exclude (X)</button>
          {item.state !== 'undecided' && <button className="copyref" onClick={() => onDecide('reset')}>Reset</button>}
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
      </div>
    </div>
  )
}

function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => window.sw.ingest.onLine((l) => setLines((prev) => [...prev, l])), [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])
  async function run(fn: () => Promise<{ ok: boolean }>): Promise<void> {
    setRunning(true)
    const r = await fn()
    setRunning(false)
    if (r.ok) onDone()
  }
  return (
    <div className="overlay" onClick={running ? undefined : onClose}>
      <div className="modal import" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Import PowerPoint into the archive</b>
          <button className="copyref" onClick={onClose} disabled={running}>close ✕</button>
        </div>
        <div className="import-actions">
          <button className="primary-btn" disabled={running} onClick={() => run(() => window.sw.ingest.pending())}>
            Ingest pending (whole archive)
          </button>
          <button className="primary-btn" disabled={running} onClick={() => run(() => window.sw.ingest.importPath())}>
            Import a file or folder…
          </button>
          {running && (
            <button className="copyref" onClick={() => void window.sw.ingest.cancel()}>
              Cancel
            </button>
          )}
        </div>
        <pre className="import-log" ref={logRef}>
          {lines.join('\n') || 'Extraction + OCR run via Core A (ppt-archive); progress streams here. Re-running is safe — done decks are skipped.'}
        </pre>
        {running && <div className="results-head">running in the background — you can keep searching</div>}
      </div>
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

function SearchableSelect({
  label,
  value,
  allLabel,
  options,
  onChange
}: {
  label: string
  value: string
  allLabel: string
  options: { value: string; label: string; count?: number }[]
  onChange: (v: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const current = value || allLabel
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options
  function pick(v: string): void {
    onChange(v)
    setOpen(false)
    setQ('')
  }
  return (
    <label className="filter">
      <span className="filter-label">{label}</span>
      <div className="ss">
        <button className="ss-btn" title={current} onClick={() => setOpen((o) => !o)}>
          <span className="ss-cur">{current}</span> ▾
        </button>
        {open && (
          <>
            <div className="menu-scrim" onClick={() => setOpen(false)} />
            <div className="ss-pop" onClick={(e) => e.stopPropagation()}>
              <input className="ss-search" autoFocus placeholder="Filter categories…" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="ss-list">
                <button className={value === '' ? 'ss-item active' : 'ss-item'} onClick={() => pick('')}>
                  {allLabel}
                </button>
                {filtered.map((o) => (
                  <button key={o.value} className={o.value === value ? 'ss-item active' : 'ss-item'} onClick={() => pick(o.value)}>
                    {o.label}
                    {o.count !== undefined ? ` (${o.count})` : ''}
                  </button>
                ))}
                {filtered.length === 0 && <div className="ss-empty">no match</div>}
              </div>
            </div>
          </>
        )}
      </div>
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
  selected,
  onSelect,
  onThumb,
  onMenu,
  onExpand
}: {
  cluster: SlideClusterResult
  selected: boolean
  onSelect: () => void
  onThumb: () => void
  onMenu: (x: number, y: number) => void
  onExpand: () => void
}): JSX.Element {
  const h = cluster.representative
  const isWell = h.kind === 'well-image'
  const isImg = h.kind === 'archive-image'
  const ocr = h.kind === 'ocr-render' || h.kind === 'ocr-image'
  const badge = clusterBadge(cluster)
  const foot = [h.filename || h.deck, h.slideOrder !== null ? `#${h.slideOrder}` : '', h.date ? h.date.slice(0, 10) : '', h.category]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className={selected ? 'card selected' : 'card'}
      onClick={onSelect}
      onDoubleClick={onThumb}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="thumb-wrap" title="Click to select · double-click to open">
        {h.thumbUrl ? (
          <img className="thumb" src={h.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : (
          <div className="thumb placeholder" aria-hidden />
        )}
        {isWell ? (
          <span className="ocr-tag well">WELL</span>
        ) : isImg ? (
          <span className="ocr-tag img">IMG</span>
        ) : ocr ? (
          <span className="ocr-tag">OCR</span>
        ) : null}
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

function fmt(n: number): string {
  return n.toLocaleString('en-GB')
}

function StatBar({ value, max, label, suffix }: { value: number; max: number; label: string; suffix: string }): JSX.Element {
  const pct = max > 0 && value > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <div className="statbar-row">
      <span className="statbar-label">{label}</span>
      <span className="statbar-track">
        <span className="statbar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="statbar-val">{suffix}</span>
    </div>
  )
}

function StatsPanel({ stats: s, onClose }: { stats: Stats | null; onClose: () => void }): JSX.Element {
  const maxYearDecks = s ? Math.max(1, ...s.byYear.map((b) => b.decks)) : 1
  const maxYearSlides = s ? Math.max(1, ...s.byYear.map((b) => b.slides)) : 1
  const maxMonth = s ? Math.max(1, ...s.byMonthOfYear.map((b) => b.decks)) : 1
  const maxSize = s ? Math.max(1, ...s.sizeBuckets.map((b) => b.decks)) : 1
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>📊 PowerPoint Through the Ages</b>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        {!s ? (
          <div className="results-head">crunching the numbers…</div>
        ) : (
          <div className="stats-body">
            <p className="stats-headline">
              <b>{fmt(s.totalDecks)} decks</b> ({fmt(s.distinctTalks)} distinct talks) · <b>{fmt(s.totalSlides)} slides</b> · {fmt(s.totalImages)} images
              {s.firstYear && s.lastYear ? ` · ${s.firstYear}–${s.lastYear} · ${s.yearsActive} years` : ''}
            </p>
            <p className="stats-sub">
              avg <b>{s.avgSlidesPerDeck}</b> slides/deck · median <b>{s.medianSlidesPerDeck}</b>
              {s.undatedDecks ? ` · ${s.undatedDecks} undated` : ''}
              {s.dateConfidence.uncertainDecks.length ? ` · ⚠️ ${s.dateConfidence.uncertainDecks.length} unreliable (re-save) dates` : ''}
            </p>
            {s.lifetimeSlidesShown > 0 && (
              <p className="stats-funfact">
                🎬 ≈ <b>{fmt(s.lifetimeSlidesShown)} slides shown on screen</b> across your career — every version / re-save counts (slide-library masters excluded; a floor).
              </p>
            )}
            {s.masterDeckCount > 0 && (
              <p className="stats-note">
                +{s.masterDeckCount} master/library deck{s.masterDeckCount === 1 ? '' : 's'} ({fmt(s.masterSlides)} slides) excluded from slide stats.
              </p>
            )}

            <h3>🗓️ Decks per year</h3>
            <div className="statbars">
              {s.byYear.map((y) => (
                <StatBar key={y.year} value={y.decks} max={maxYearDecks} label={String(y.year)} suffix={`${y.decks} · ${fmt(y.slides)} sl`} />
              ))}
            </div>

            <h3>📈 Slides per year</h3>
            <div className="statbars">
              {s.byYear.map((y) => (
                <StatBar key={y.year} value={y.slides} max={maxYearSlides} label={String(y.year)} suffix={fmt(y.slides)} />
              ))}
            </div>

            <h3>🌦️ Seasonality</h3>
            <div className="statbars">
              {s.byMonthOfYear.map((m) => (
                <StatBar key={m.month} value={m.decks} max={maxMonth} label={m.label} suffix={String(m.decks)} />
              ))}
            </div>

            <h3>📐 Deck sizes</h3>
            <div className="statbars">
              {s.sizeBuckets.map((b) => (
                <StatBar key={b.label} value={b.decks} max={maxSize} label={b.label} suffix={`${b.decks} decks`} />
              ))}
            </div>

            <div className="stats-cols">
              <div>
                <h3>🏷️ Top categories</h3>
                <table className="stats-table">
                  <thead>
                    <tr><th>Category</th><th>Decks</th><th>Slides</th></tr>
                  </thead>
                  <tbody>
                    {s.topCategoriesByDecks.slice(0, 12).map((c) => (
                      <tr key={c.category}><td>{c.category}</td><td>{c.decks}</td><td>{fmt(c.slides)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3>🔥 Busiest months</h3>
                <table className="stats-table">
                  <thead>
                    <tr><th>Month</th><th>Decks</th><th>Slides</th></tr>
                  </thead>
                  <tbody>
                    {s.busiestMonths.map((m) => (
                      <tr key={m.key}><td>{m.label}</td><td>{m.decks}</td><td>{fmt(m.slides)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <h3>🏆 Superlatives</h3>
            <ul className="stats-sups">
              {s.superlatives.mostProlificYear && <li>Most prolific year: <b>{s.superlatives.mostProlificYear.year}</b> ({s.superlatives.mostProlificYear.decks} decks)</li>}
              {s.superlatives.mostSlidesYear && <li>Most slides in a year: <b>{s.superlatives.mostSlidesYear.year}</b> ({fmt(s.superlatives.mostSlidesYear.slides)} slides)</li>}
              {s.superlatives.busiestMonth && <li>Busiest month: <b>{s.superlatives.busiestMonth.label}</b> ({s.superlatives.busiestMonth.decks} decks)</li>}
              {s.superlatives.biggestDeck && (
                <li>Biggest deck: <b>{s.superlatives.biggestDeck.title}</b> — {fmt(s.superlatives.biggestDeck.slides)} slides{s.superlatives.biggestDeck.year ? ` (${s.superlatives.biggestDeck.year})` : ''}</li>
              )}
              {s.superlatives.firstYearAvg && s.superlatives.lastYearAvg && (
                <li>
                  Deck-size trend: {s.superlatives.firstYearAvg.avg}/deck in {s.superlatives.firstYearAvg.year} → {s.superlatives.lastYearAvg.avg} in {s.superlatives.lastYearAvg.year}
                </li>
              )}
            </ul>

            {s.duplicateClusters.length > 0 && (
              <>
                <h3>🔁 Most-duplicated talks</h3>
                <table className="stats-table">
                  <thead>
                    <tr><th>Talk</th><th>Files</th><th>Slides</th><th>Earliest</th></tr>
                  </thead>
                  <tbody>
                    {s.duplicateClusters.slice(0, 12).map((c) => (
                      <tr key={c.key}><td>{c.title}</td><td>{c.deckCount}</td><td>{fmt(c.maxSlides)}</td><td>{c.earliestDate ? c.earliestDate.slice(0, 10) : '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DeckCardView({ deck, selected, onSelect }: { deck: DeckCard; selected: boolean; onSelect: () => void }): JSX.Element {
  return (
    <div className={selected ? 'card deck-card selected' : 'card deck-card'} onClick={onSelect} title={deck.title}>
      <div className="thumb-wrap">
        {deck.coverThumbUrl ? (
          <img className="thumb" src={deck.coverThumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : (
          <div className="thumb placeholder" />
        )}
        <span className="slide-num">{deck.slideCount} slides</span>
      </div>
      <div className="meta">
        <div className="card-title" title={deck.title}>{deck.title}</div>
        <div className="card-foot">
          <span className="deck">{[deck.date ? deck.date.slice(0, 10) : '', deck.category].filter(Boolean).join(' · ') || deck.filename}</span>
        </div>
      </div>
    </div>
  )
}

function DeckSidebar({
  detail,
  onClose,
  onSeeAll,
  onReveal
}: {
  detail: DeckDetail & { coverThumbUrl: string | null }
  onClose: () => void
  onSeeAll: () => void
  onReveal: () => void
}): JSX.Element {
  const rows: [string, string][] = [
    ['Date', detail.date ? `${detail.date.slice(0, 10)} (${detail.dateSource})` : '—'],
    ['Folder', detail.category || '—'],
    ['File', detail.filename || '—'],
    ['Slides', String(detail.slideCount)],
    ['Sections', String(detail.sectionCount)],
    ['Owner', detail.ownership],
    ['Source', detail.sourcePath || '—']
  ]
  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-head">
        <b>{detail.title}</b>
        <button className="copyref" onClick={onClose}>✕</button>
      </div>
      {detail.coverThumbUrl && <img className="deck-sidebar-cover" src={detail.coverThumbUrl} alt="" />}
      <div className="details-table">
        {rows.map(([k, v]) => (
          <div className="drow" key={k}>
            <span className="dk">{k}</span>
            <span className="dv">{v}</span>
          </div>
        ))}
      </div>
      <div className="details-actions">
        <button className="primary-btn" onClick={onSeeAll}>See all slides</button>
        <button className="copyref" onClick={onReveal}>Reveal in Finder</button>
      </div>
    </aside>
  )
}

type ActionId = 'fullsize' | 'copy-image' | 'copy-image-png' | 'copy-text' | 'copy-structure' | 'copy-ref' | 'reveal' | 'expand' | 'details' | 'context'

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
  const k = cluster.representative.kind
  const isImage = k === 'well-image' || k === 'archive-image'
  const items: { id: ActionId; label: string }[] = [
    { id: 'fullsize', label: 'Open full size' },
    { id: 'copy-image', label: 'Copy image (WebP → TalkWeaver)' },
    { id: 'copy-image-png', label: 'Copy as PNG' },
    { id: 'copy-text', label: 'Copy text' },
    ...(isImage ? [] : [{ id: 'copy-structure' as ActionId, label: 'Copy structure (JSON)' }]),
    { id: 'copy-ref', label: 'Copy reference' },
    { id: 'reveal', label: 'Reveal in Finder' },
    ...(cluster.size > 1 ? [{ id: 'expand' as ActionId, label: `Expand cluster (${cluster.size})` }] : []),
    ...(k === 'well-image' ? [] : [{ id: 'context' as ActionId, label: 'See in context (whole deck)' }]),
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

function actionItems(deckMode: boolean, kind?: string): { id: ActionId; label: string; shortcut?: string }[] {
  if (deckMode)
    return [
      { id: 'fullsize', label: 'See all slides in this deck', shortcut: '↵' },
      { id: 'details', label: 'Show metadata (inspector)', shortcut: 'I' },
      { id: 'reveal', label: 'Reveal in Finder', shortcut: 'F' }
    ]
  const isImage = kind === 'well-image' || kind === 'archive-image'
  return [
    { id: 'fullsize', label: 'Open full size', shortcut: '↵' },
    { id: 'details', label: 'Show metadata (inspector)', shortcut: 'I' },
    { id: 'copy-image', label: 'Copy image (WebP → TalkWeaver)', shortcut: '⌘C' },
    { id: 'copy-image-png', label: 'Copy as PNG', shortcut: '⌘⇧C' },
    { id: 'copy-text', label: 'Copy text', shortcut: 'T' },
    ...(isImage ? [] : [{ id: 'copy-structure' as ActionId, label: 'Copy structure (JSON)', shortcut: 'J' }]),
    { id: 'copy-ref', label: 'Copy reference', shortcut: 'R' },
    { id: 'reveal', label: 'Reveal in Finder', shortcut: 'F' },
    ...(kind === 'well-image' ? [] : [{ id: 'context' as ActionId, label: 'See in context (whole deck)', shortcut: 'X' }])
  ]
}

function SlideInspector({
  hit,
  pos,
  siblings,
  onNavigate,
  onClose,
  onFullsize,
  onCopyText,
  onCopyRef,
  onCopyImage,
  onReveal,
  onContext
}: {
  hit: SlideResult
  pos: string
  siblings: SlideResult[]
  onNavigate: (rep: SlideResult) => void
  onClose: () => void
  onFullsize: () => void
  onCopyText: () => void
  onCopyRef: () => void
  onCopyImage: () => void
  onReveal: () => void
  onContext?: () => void
}): JSX.Element {
  const isSlide = hit.kind === 'slide'
  const kindLabel = hit.kind === 'slide' ? 'slide' : hit.kind === 'well-image' ? 'well image' : hit.kind === 'archive-image' ? 'embedded image' : 'OCR text'
  const [json, setJson] = useState<string | null>(null)
  const [assets, setAssets] = useState<Array<{ thumbUrl: string | null }>>([])
  useEffect(() => {
    setJson(null)
    setAssets([])
    if (isSlide) {
      void window.sw.archive.slideStructure(hit.deck, hit.slideOrder).then(setJson)
      void window.sw.archive.slideImages(hit.deck, hit.slideOrder).then(setAssets)
    }
  }, [hit, isSlide])
  const rows: [string, string][] = [
    ['Deck', hit.deckTitle || hit.deck || '—'],
    ['File', hit.filename || '—'],
    ...(hit.slideOrder !== null ? ([['Slide', String(hit.slideOrder + 1)]] as [string, string][]) : []),
    ['Date', hit.date ? hit.date.slice(0, 10) : '—'],
    ['Category', hit.category || '—'],
    ['Used in', `${hit.usedInDecks} deck${hit.usedInDecks === 1 ? '' : 's'}`],
    ['Kind', kindLabel],
    ['Reference', hit.reference]
  ]
  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-head">
        <b>{hit.title}</b>
        <button className="copyref" onClick={onClose}>✕</button>
      </div>
      <div className="inspector-pos">{pos} · ←/→ to navigate</div>
      {hit.thumbUrl && <img className="deck-sidebar-cover" src={hit.thumbUrl} alt="" />}
      <div className="details-table">
        {rows.map(([k, v]) => (
          <div className="drow" key={k}>
            <span className="dk">{k}</span>
            <span className="dv">{v}</span>
          </div>
        ))}
        {!isSlide && hit.text && <div className="details-text">{hit.text}</div>}
        {siblings.length > 1 && (
          <>
            <div className="inspector-section">Other slides in this presentation ({siblings.length - 1})</div>
            <div className="inspector-assets">
              {siblings.map(
                (sib, i) =>
                  sib.thumbUrl && (
                    <img
                      key={`${sib.deck}-${sib.slideOrder}-${i}`}
                      className={sib === hit ? 'inspector-asset wide current' : 'inspector-asset wide'}
                      src={sib.thumbUrl}
                      alt=""
                      title={sib.title}
                      loading="lazy"
                      onClick={() => onNavigate(sib)}
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                    />
                  )
              )}
            </div>
          </>
        )}
        {isSlide && assets.length > 0 && (
          <>
            <div className="inspector-section">Image assets ({assets.length})</div>
            <div className="inspector-assets">
              {assets.map(
                (a, i) =>
                  a.thumbUrl && (
                    <img key={i} className="inspector-asset" src={a.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  )
              )}
            </div>
          </>
        )}
        {isSlide && (
          <>
            <div className="inspector-section">Full JSON</div>
            <pre className="inspector-json">{json ?? '…'}</pre>
          </>
        )}
      </div>
      <div className="details-actions">
        <button className="primary-btn" onClick={onFullsize}>Full size</button>
        <button className="copyref" onClick={onCopyImage}>copy img</button>
        <button className="copyref" onClick={onCopyText}>copy text</button>
        <button className="copyref" onClick={onCopyRef}>copy ref</button>
        <button className="copyref" onClick={onReveal}>reveal</button>
        {onContext && <button className="copyref" onClick={onContext}>in context</button>}
      </div>
    </aside>
  )
}

function CommandPalette({
  item,
  deckMode,
  onClose,
  onRun
}: {
  item: SlideResult | DeckCard
  deckMode: boolean
  onClose: () => void
  onRun: (a: ActionId) => void
}): JSX.Element {
  const kind = 'kind' in item ? (item as SlideResult).kind : undefined
  const all = actionItems(deckMode, kind)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const filtered = q ? all.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())) : all
  useEffect(() => setHi(0), [q])
  const title = item.title
  return (
    <div className="overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          autoFocus
          placeholder={`Actions for “${title}”…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHi((h) => Math.min(h + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => Math.max(h - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (filtered[hi]) onRun(filtered[hi].id)
            }
          }}
        />
        <div className="cmd-list">
          {filtered.map((a, i) => (
            <button key={a.id} className={i === hi ? 'cmd-item active' : 'cmd-item'} onMouseEnter={() => setHi(i)} onClick={() => onRun(a.id)}>
              <span className="cmd-label">{a.label}</span>
              {a.shortcut && <kbd className="cmd-shortcut">{a.shortcut}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && <div className="ss-empty">no actions</div>}
        </div>
      </div>
    </div>
  )
}

function HelpOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  const rows: [string, string][] = [
    ['/  ·  ⌘F', 'Focus search'],
    ['← →', 'Previous / next'],
    ['↑ ↓', 'Up / down a row'],
    ['Enter · dbl-click', 'Open full size (deck: open it)'],
    ['I  ·  Space', 'Toggle inspector sidebar'],
    ['⌘K', 'Command palette (actions)'],
    ['⌘C  ·  ⌘⇧C', 'Copy image (WebP) · as PNG'],
    ['T · J · R', 'Copy text · structure · reference'],
    ['F · X', 'Reveal in Finder · See in context'],
    ['1 · 2 · 3', 'Slides · Images · Decks'],
    ['G', 'Group by presentation'],
    ['C', 'Cluster near-identical'],
    ['S · O', 'Stats · Import'],
    ['⛏ Triage', 'Triage screenshots/videos (toolbar) — then I/X to keep/skip'],
    ['Esc', 'Close / back'],
    ['?', 'This help']
  ]
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>⌨ Keyboard shortcuts</b>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        <div className="details-table">
          {rows.map(([k, v]) => (
            <div className="drow" key={k}>
              <span className="dk help-key">{k}</span>
              <span className="dv">{v}</span>
            </div>
          ))}
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

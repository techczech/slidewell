import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { SlideResult, SlideClusterResult, SearchFilters, CategoryCount, DeckInfo, DeckCard, DeckDetail, FromFilter, KindFilter, FromCounts, MatchMode } from '../../preload'
import { commandForEvent, MAIN_COMMANDS } from '../../shared/commands'
import { CHECK_UPDATES, WHATS_NEW } from '../../shared/update-identity'
import { usePictureStatus } from './PictureSearch'
import { RELATED_SHOWN, relatedFold } from './match-fold'
import { Card, DeckCardView } from './SearchCards'
import { ClusterModal, CommandPalette, ContextMenu, DeckSidebar, DetailsModal, Lightbox, SlideInspector, type ActionId } from './SearchDetails'
import { DeleteOthersMatchingButton, LibraryFilter } from './OthersLibrary'
import type { TriageTab } from './TriagePanel'

type SortKey = 'best' | 'date-desc' | 'date-asc' | 'title'

const FROM_CHIPS: Array<{ value: FromFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'screenshots', label: 'Screenshots' },
  { value: 'old-images', label: 'Old-PowerPoint images' },
  { value: 'old-slides', label: 'Old slides' },
  { value: 'talks', label: 'Used in talks' }
]
const KIND_TABS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'no-text', label: 'Pictures without text' },
  { value: 'embedded', label: 'Embedded images only' }
]
// A From chip also moves Type to a compatible value, so the chip never lands on an empty combination.
function fromPatch(from: FromFilter): Partial<SearchFilters> {
  if (from === 'old-slides') return { from, type: 'slides', kind: 'all' }
  if (from === 'screenshots' || from === 'old-images' || from === 'talks') return { from, type: 'images' }
  return { from }
}
// A Kind other than All concerns pictures only, so leave Presentations/slides-only views and any From chip it would empty.
function kindPatch(kind: KindFilter, f: SearchFilters): Partial<SearchFilters> {
  if (kind === 'all') return { kind }
  const p: Partial<SearchFilters> = { kind }
  if (f.type !== 'images') p.type = 'images'
  if (f.from === 'old-slides' || (kind === 'embedded' && f.from === 'talks') || (kind === 'embedded' && f.from === 'screenshots')) p.from = 'all'
  return p
}
// The results count names what the Type chip shows: images, presentations, or slides (the default).
function countNoun(type: SearchFilters['type'], n: number): string {
  if (type === 'images') return n === 1 ? 'image' : 'images'
  if (type === 'decks') return n === 1 ? 'presentation' : 'presentations'
  return n === 1 ? 'slide' : 'slides'
}

const NO_COUNTS: FromCounts ={ all: 0, screenshots: 0, 'old-images': 0, 'old-slides': 0, talks: 0 }

const DEFAULT_FILTERS: SearchFilters = { owner: 'mine', era: 'all', category: '', deck: '', role: 'content', cluster: true, from: 'all', kind: 'all', type: 'slides', library: 'mine' }

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

/** The settings frame's commands: they work on every screen and over any overlay. */
export const FRAME_COMMANDS: ReadonlySet<string> = new Set(['settings', 'cheat', 'export-settings', 'import-settings', CHECK_UPDATES, WHATS_NEW])

export type AppView = 'search' | 'review' | 'triage'

interface Shell {
  appView: AppView
  setAppView: (view: AppView) => void
  setTriageTab: (tab: TriageTab) => void
  bindings: Record<string, string>
  refreshKey: number
  setRefreshKey: Dispatch<SetStateAction<number>>
  setToast: (message: string) => void
  showHelp: boolean
  setShowHelp: (show: boolean) => void
  showStats: boolean
  setShowStats: (show: boolean) => void
  showImport: boolean
  setShowImport: (show: boolean) => void
  showConvert: boolean
  setShowConvert: (show: boolean) => void
  openStats: () => void
}

export function useSearchView({
  appView, setAppView, setTriageTab, bindings, refreshKey, setRefreshKey, setToast,
  showHelp, setShowHelp, showStats, setShowStats, showImport, setShowImport,
  showConvert, setShowConvert, openStats
}: Shell) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS)
  const [archiveOk, setArchiveOk] = useState<boolean | null>(null)
  const [archivePath, setArchivePath] = useState('')
  const [categories, setCategories] = useState<CategoryCount[]>([])
  const [decks, setDecks] = useState<DeckInfo[]>([])
  const [fromCounts, setFromCounts] = useState<FromCounts>(NO_COUNTS)
  const [sort, setSort] = useState<SortKey>('best')
  // Match switch (locked frames 3 and 4): Both by default. `matchRan` is what the last search did.
  const [match, setMatch] = useState<MatchMode>('both')
  const [related, setRelated] = useState<SlideClusterResult[]>([])
  const [matchRan, setMatchRan] = useState<MatchMode>('words')
  const [collapsed, setCollapsed] = useState({ words: false, related: false })
  const [relatedAll, setRelatedAll] = useState(false)
  const pic = usePictureStatus()
  const modelReady = pic?.model === 'ready'
  const shownMatch: MatchMode = modelReady ? match : 'words' // without the model, Words is used
  const [groupByDeck, setGroupByDeck] = useState(false)
  const [clusters, setClusters] = useState<SlideClusterResult[]>([])
  const [deckCards, setDeckCards] = useState<DeckCard[]>([])
  const [selectedDeck, setSelectedDeck] = useState<(DeckDetail & { coverThumbUrl: string | null }) | null>(null)
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<{ cluster: SlideClusterResult; x: number; y: number } | null>(null)
  const [lightbox, setLightbox] = useState<{ list: SlideResult[]; index: number } | null>(null)
  const [expanded, setExpanded] = useState<SlideClusterResult | null>(null)
  const [details, setDetails] = useState<SlideResult | null>(null)
  // "See in context": when set, the main grid shows this whole presentation in slide order,
  // every slide fully usable (not a read-only popup). Cleared by typing or changing a filter.
  const [deckFilter, setDeckFilter] = useState<{ pid: string; title: string } | null>(null)
  // keyboard selection + inspector + command palette
  const [sel, setSel] = useState(-1)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // an item opened from "More like this": the inspector shows it instead of the selected card until selection moves
  const [pinned, setPinned] = useState<SlideResult | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const reqId = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
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
      if (deckFilter) {
        const res = (await window.sw.archive.deckSlides(deckFilter.pid)).map((s) => ({ representative: s, members: [s], size: 1, deckCount: 1 }))
        if (id !== reqId.current) return
        setDeckCards([])
        setClusters(res)
        setRelated([])
        setMatchRan('words')
        setLoading(false)
        return
      }
      // Words only takes the fast path in the main process: no picture query is made.
      const res = await window.sw.archive.searchMatched(debounced, filters, shownMatch)
      if (id !== reqId.current) return
      setDeckCards([])
      setClusters(res.words)
      setRelated(res.related)
      setMatchRan(res.mode)
      setRelatedAll(false)
      setLoading(false)
    })()
  }, [debounced, filters, refreshKey, deckFilter, shownMatch])

  // Counts on the From chips follow the query and the other filters (not From itself).
  useEffect(() => {
    let live = true
    void window.sw.archive.fromCounts(debounced, filters).then((c) => { if (live) setFromCounts(c) }).catch(() => undefined)
    return () => { live = false }
  }, [debounced, filters.library, filters.owner, filters.era, filters.category, filters.deck, filters.role, filters.cluster, filters.kind, refreshKey])

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
      if (sort === 'best') return 0 // keep the order the search gave (words by score, then meaning by score)
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
  const fold = relatedFold(related.map((c) => c.representative))
  const relatedShown = useMemo(() => (relatedAll ? related : related.slice(0, RELATED_SHOWN)), [related, relatedAll])
  const wordReps = useMemo(
    () => (collapsed.words ? [] : view.groups ? view.groups.flatMap((g) => g.slides.map((c) => c.representative)) : (view.flat ?? []).map((c) => c.representative)),
    [view, collapsed.words]
  )
  const relatedReps = useMemo(() => (collapsed.related ? [] : relatedShown.map((c) => c.representative)), [relatedShown, collapsed.related])
  const orderedReps = useMemo(() => [...wordReps, ...relatedReps], [wordReps, relatedReps])

  // keyboard selection model: one list of items (slides/images OR decks), a current selection.
  const deckMode = filters.type === 'decks' && !deckFilter
  const navCount = deckMode ? sortedDecks.length : orderedReps.length
  const current: SlideResult | DeckCard | null = sel >= 0 && sel < navCount ? (deckMode ? sortedDecks[sel] : orderedReps[sel]) : null
  const selectedRep = !deckMode && sel >= 0 && sel < orderedReps.length ? orderedReps[sel] : null
  // the lightbox-aware target for ⌘K / shortcuts: the image being viewed in the slideshow, else the grid selection
  const activeItem: SlideResult | DeckCard | null = lightbox ? lightbox.list[lightbox.index] : current
  // other slides of the same group (group-by-presentation) — shown in the inspector
  useEffect(() => setPinned(null), [sel, inspectorOpen, debounced, filters, deckFilter, refreshKey])
  const shownHit = pinned ?? selectedRep
  const siblings = useMemo<SlideResult[]>(() => {
    if (pinned || !selectedRep || !view.groups) return []
    const g = view.groups.find((grp) => grp.slides.some((c) => c.representative === selectedRep))
    return g ? g.slides.map((c) => c.representative) : []
  }, [selectedRep, view, pinned])

  // reset selection when the result set changes
  useEffect(() => setSel(-1), [debounced, filters, deckFilter, refreshKey])

  // Delete-by-filter: remove the Others' Library presentations matching the current query + filters
  // (the main process shows a confirm with the real count). No filter → deletes the whole library.
  const deleteOthersMatching = useCallback(async () => {
    const r = await window.sw.archive.deleteOthersMatching(debounced, filters)
    if (r.ok) {
      setToast(`Deleted ${r.deleted ?? 0} presentation${r.deleted === 1 ? '' : 's'} from Others' Library`)
      setRefreshKey((k) => k + 1)
    } else if (!r.cancelled) {
      setToast('Nothing matched — nothing deleted')
    }
  }, [debounced, filters, setToast])

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

  // move the selection one visual row up (dir=-1) or down (dir=+1). Works from the rendered card
  // geometry, so it respects the live column count and group boundaries; picks the card on the
  // nearest adjacent row whose horizontal centre is closest to the current one.
  const moveByRow = useCallback((dir: 1 | -1): void => {
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
  }, [sel, navCount])

  // What each registry command does (shared/commands.ts). `field` is the text field the key came from.
  const runCommand = useCallback(
    (id: string, field: HTMLElement | null = null): void => {
      if (MAIN_COMMANDS.has(id)) return void window.sw.app.runCommand(id)
      switch (id) {
        case 'cheat': return setShowHelp(true)
        case 'go-search': return setAppView('search')
        case 'go-review': return setAppView('review')
        case 'go-triage': return setAppView('triage')
        case 'convert': return setShowConvert(true)
        case 'open-auto-sorting':
          setTriageTab('auto')
          return setAppView('triage')
      }
      if (appView !== 'search') return
      switch (id) {
        case 'find': return searchRef.current?.focus()
        case 'actions':
          // works over the lightbox too — acts on the image on screen, not the grid selection
          if (!lightbox && navCount > 0 && sel < 0) setSel(0)
          setPaletteOpen(true)
          return
        case 'dismiss':
          if (paletteOpen) setPaletteOpen(false)
          else if (lightbox) setLightbox(null)
          else if (showHelp) setShowHelp(false)
          else if (showStats) setShowStats(false)
          else if (showImport) setShowImport(false)
          else if (showConvert) setShowConvert(false)
          else if (inspectorOpen) setInspectorOpen(false)
          else if (deckFilter) setDeckFilter(null)
          else field?.blur()
          return
        case 'move-right': if (navCount && !lightbox) setSel((s) => Math.min(s < 0 ? 0 : s + 1, navCount - 1)); return
        case 'move-left': if (navCount && !lightbox) setSel((s) => Math.max(s <= 0 ? 0 : s - 1, 0)); return
        case 'move-down': if (navCount && !lightbox) moveByRow(1); return
        case 'move-up': if (navCount && !lightbox) moveByRow(-1); return
        case 'open-item': if (!lightbox) activateCurrent(); return
        case 'inspector':
          if (navCount) {
            if (sel < 0) setSel(0)
            setInspectorOpen((o) => !o)
          }
          return
        case 'show-slides': return patch({ type: 'slides' })
        case 'show-images': return patch({ type: 'images' })
        case 'show-decks': return patch({ type: 'decks' })
        case 'group-by-deck': return setGroupByDeck((x) => !x)
        case 'toggle-clusters': return patch({ cluster: !filters.cluster })
        case 'stats': return openStats()
        case 'import': return setShowImport(true)
        case 'copy-image': case 'copy-image-png': case 'copy-text': case 'copy-structure': case 'copy-ref': case 'reveal': case 'context':
          if (activeItem) runAction(id)
          return
      }
    },
    [appView, lightbox, navCount, sel, paletteOpen, showHelp, showStats, showImport, showConvert, inspectorOpen, deckFilter, moveByRow, activateCurrent, patch, filters, openStats, activeItem, runAction]
  )

  // global keyboard layer
  useEffect(() => {
    // One registry (shared/commands.ts) names every chord; `runCommand` below does what each command does.
    const onKey = (e: KeyboardEvent): void => {
      if (appView !== 'search') return // Review and Triage own the keyboard while open
      const el = document.activeElement as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      const cmd = e.metaKey || e.ctrlKey
      // ⌘C is the system's Copy: with no text selected it copies the active image (WebP, as TalkWeaver does)
      if (cmd && !e.shiftKey && e.key.toLowerCase() === 'c' && activeItem && !(deckMode && !lightbox)) {
        if ((window.getSelection()?.toString().length ?? 0) === 0) {
          e.preventDefault()
          runCommand('copy-image')
        }
        return
      }
      const id = commandForEvent(e, bindings, { inField: typing, onControl: false, overlay: false })
      if (!id || FRAME_COMMANDS.has(id)) return // the frame's commands are handled for every screen below
      // the lightbox owns ← → and Esc (its own listener); the copy actions there act on the image on screen
      if (lightbox && (id.startsWith('move-') || id === 'open-item')) return
      if (id !== 'dismiss') e.preventDefault()
      runCommand(id, typing ? el : null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [appView, activeItem, deckMode, lightbox, bindings, runCommand])

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

  const content = appView === 'search' && (
    <>
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
        <LibraryFilter filters={filters} patch={patch} />
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
                {t === 'slides' ? 'Slides' : t === 'images' ? 'Images' : 'Presentations'}
              </button>
            ))}
          </div>
        </label>
        <label className="filter">
          <span className="filter-label">Match</span>
          <div className="scope" role="tablist" aria-label="Match">
            {(['words', 'meaning', 'both'] as const).map((m) => {
              const off = m !== 'words' && !modelReady
              return (
                <button
                  key={m}
                  role="tab"
                  aria-selected={shownMatch === m}
                  aria-disabled={off}
                  disabled={off}
                  className={shownMatch === m ? 'scope-tab active' : 'scope-tab'}
                  title={
                    off
                      ? 'Meaning search needs the picture-search model — download it in Settings'
                      : m === 'words'
                        ? 'Words in the slide or picture (fast)'
                        : m === 'meaning'
                          ? 'What the picture shows, whatever its words'
                          : 'Word matches first, then pictures that look related'
                  }
                  onClick={() => setMatch(m)}
                >
                  {m === 'words' ? 'Words' : m === 'meaning' ? 'Meaning' : 'Both'}
                </button>
              )
            })}
          </div>
          {!modelReady && pic && (
            <button className="link match-settings" onClick={() => void window.sw.app.openSettings('picture-search')}>Meaning search is off · set up in Settings</button>
          )}
        </label>
        <Select label="Owner" value={filters.owner} onChange={(v) => patch({ owner: v as SearchFilters['owner'] })}
          options={[
            { value: 'mine', label: 'My presentations' },
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
          label="Presentation"
          value={filters.deck}
          allLabel="All presentations"
          options={decks.map((d) => ({ value: d.title, label: d.title }))}
          onChange={(v) => patch({ deck: v })}
        />
        <Select label="Role" value={filters.role} onChange={(v) => patch({ role: v as SearchFilters['role'] })}
          options={[{ value: 'content', label: 'Content only' }, { value: 'all', label: 'Incl. structural' }]} />
        <Select label="Sort" value={sort} onChange={(v) => setSort(v as SortKey)}
          options={[{ value: 'best', label: 'Best match' }, { value: 'date-desc', label: 'Newest' }, { value: 'date-asc', label: 'Oldest' }, { value: 'title', label: 'Title A–Z' }]} />
        <button
          className={filters.cluster ? 'toggle on' : 'toggle'}
          onClick={() => patch({ cluster: !filters.cluster })}
          title="Collapse look-alike pictures and near-identical slides into one result"
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
        {filters.library === 'others' && <DeleteOthersMatchingButton deleteOthersMatching={deleteOthersMatching} />}
      </div>

      <div className="fromrow">
        <div className="filter-inline">
          <span className="filter-label">From</span>
          <div className="chips" role="tablist" aria-label="From">
            {FROM_CHIPS.map((c) => {
              const n = fromCounts[c.value]
              const disabled = c.value === 'talks' && n === 0 && filters.from !== 'talks'
              return (
                <button
                  key={c.value}
                  role="tab"
                  aria-selected={filters.from === c.value}
                  disabled={disabled}
                  title={disabled ? 'No picture in your talks matches this search' : undefined}
                  className={filters.from === c.value ? 'chip active' : 'chip'}
                  onClick={() => patch(fromPatch(c.value))}
                >
                  {c.label} <span className="chip-count">{n}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="filter-inline">
          <span className="filter-label">Kind</span>
          <div className="scope" role="tablist" aria-label="Kind">
            {KIND_TABS.map((k) => (
              <button
                key={k.value}
                role="tab"
                aria-selected={filters.kind === k.value}
                className={filters.kind === k.value ? 'scope-tab active' : 'scope-tab'}
                onClick={() => patch(kindPatch(k.value, filters))}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="results">
        {filters.type === 'decks' && !deckFilter ? (
          loading ? (
            <div className="results-head">loading…</div>
          ) : sortedDecks.length === 0 ? (
            <Empty title="No presentations match these filters." sub="Widen the Date / Owner / Category / Presentation filters." />
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
        ) : clusters.length === 0 && related.length === 0 ? (
          filters.from === 'screenshots' ? (
            filters.library === 'others' ? (
              <Empty title="Screenshots are your own content." sub="Set Library to “Mine” or “All” — “Others” hides them." />
            ) : (
              <Empty title="No screenshots match." sub="Stash a screenshot via the Raycast hotkey, or triage a screenshot folder." />
            )
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
            ) : matchRan !== 'words' ? null : (
              <div className="results-head">
                {debounced
                  ? `${clusters.length} result${clusters.length === 1 ? '' : 's'} for “${debounced}”`
                  : `${clusters.length} ${countNoun(filters.type, clusters.length)}`}
                {groupByDeck ? ` · ${view.groups?.length ?? 0} presentation${(view.groups?.length ?? 0) === 1 ? '' : 's'}` : ''}
                {filters.cluster ? ' · near-identical grouped' : ''}
              </div>
            )}
            {!deckFilter && matchRan === 'words' && match === 'words' && modelReady && debounced && (
              <div className="match-note">Words only — faster; switch to <button className="link" onClick={() => setMatch('both')}>Both</button> to see pictures that look related</div>
            )}
            {!deckFilter && matchRan === 'both' && (
              <div className="band-head">
                <button className="band-toggle" onClick={() => setCollapsed((c) => ({ ...c, words: !c.words }))}>
                  {collapsed.words ? '▸' : '▾'} Words match ({clusters.length})
                </button>
                {clusters.length === 0 && <span className="band-sub">nothing to show</span>}
                {clusters.length > 0 && (
                  <button className="link band-collapse" onClick={() => setCollapsed((c) => ({ ...c, words: !c.words }))}>{collapsed.words ? 'expand' : 'collapse'}</button>
                )}
              </div>
            )}
            {!deckFilter && matchRan === 'both' && clusters.length === 0 && (
              <div className="match-note info">No {countNoun(filters.type, 1)} contains these words — showing {countNoun(filters.type, 2)} that look related</div>
            )}
            {collapsed.words && matchRan === 'both' ? null : view.groups ? (
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
            {!deckFilter && matchRan !== 'words' && (
              <>
                <div className="band-head">
                  <button className="band-toggle" onClick={() => setCollapsed((c) => ({ ...c, related: !c.related }))}>
                    {collapsed.related ? '▸' : '▾'} Looks related ({related.length})
                  </button>
                  <span className="band-sub">— found by what’s on it, not its words</span>
                  <button className="link band-collapse" onClick={() => setCollapsed((c) => ({ ...c, related: !c.related }))}>{collapsed.related ? 'expand' : 'collapse'}</button>
                </div>
                {!collapsed.related && (
                  <div className="grid">
                    {relatedShown.map((c, j) => {
                      const idx = wordReps.length + j
                      return (
                        <Card
                          key={`rel-${c.representative.deck}-${c.representative.slideOrder}-${c.representative.reference}-${j}`}
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
                )}
                {!collapsed.related && fold && !relatedAll && (
                  <button className="link band-more" onClick={() => setRelatedAll(true)}>Show {fold.more} more · meaning {fold.below} and below</button>
                )}
              </>
            )}
          </>
        )}
      </main>
    </>
  )

  const overlays = (
    <>
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

      {inspectorOpen && appView === 'search' &&
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
          : shownHit && (
              <SlideInspector
                hit={shownHit}
                pinned={pinned !== null}
                onBackToList={() => setPinned(null)}
                onOpenSimilar={setPinned}
                pos={`${sel + 1} / ${orderedReps.length}`}
                siblings={siblings}
                onNavigate={(rep) => {
                  const idx = orderedReps.indexOf(rep)
                  if (idx >= 0) setSel(idx)
                }}
                onClose={() => setInspectorOpen(false)}
                onFullsize={() => (pinned ? openLightbox([pinned], 0) : openLightbox(orderedReps, sel))}
                onCopyText={() => void copyText(shownHit.text, 'slide text')}
                onCopyRef={() => void copyText(shownHit.reference, 'reference')}
                onCopyImage={() => void copyImage(shownHit)}
                onReveal={() => void reveal(shownHit)}
                onContext={
                  shownHit.kind !== 'well-image'
                    ? () => {
                        setInspectorOpen(false)
                        setDeckFilter({ pid: shownHit.deck, title: shownHit.deckTitle || shownHit.deck })
                      }
                    : undefined
                }
              />
            ))}

      {paletteOpen && (
        <CommandPalette
          item={activeItem}
          deckMode={deckMode && !lightbox}
          onClose={() => setPaletteOpen(false)}
          onRun={(a) => {
            setPaletteOpen(false)
            if (a === CHECK_UPDATES || a === WHATS_NEW) runCommand(a)
            else runAction(a)
          }}
        />
      )}

    </>
  )

  return {
    archiveOk, archivePath, chooseArchive, inspectorOpen, navCount, activeItem, runCommand,
    closeMenu: () => menu && setMenu(null),
    content, overlays
  }
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

function Empty({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p className="empty-sub">{sub}</p>
    </div>
  )
}

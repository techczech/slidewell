import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nextPreviewIndex } from '../../main/triage-logic'
import { IDLE, adoptStatus, applySnapshot, failureMessage, importButtonLabel, importLine, isWorking, startClick, type ImportState } from '../../main/triage-import-progress'
import { PictureSearchStatusBar, usePictureStatus } from './PictureSearch'
import { aliasesOf, commandForEvent, MAIN_COMMANDS, registry, SCREEN_KEYS, withChord } from '../../shared/commands'
import { AutoSortingTab } from './AutoSortingTab'
import { TriageAppBar, TriageAppMenu, useTickedApps } from './TriageAppMenu'
import { useSorterBusy } from './sorter-hooks'
import { ReviewScreen } from './Review'
import { TeachRoundHost } from './TeachRound'
import { RELATED_SHOWN, relatedFold } from './match-fold'
import type { SlideResult, SlideClusterResult, SearchFilters, CategoryCount, DeckInfo, DeckCard, DeckDetail, Stats, TriageItem, TriageCounts, Dependency, FromFilter, KindFilter, FromCounts, MatchMode, MoreLikeThisResult } from '../../preload'

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

export default function App(): JSX.Element {
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
  const [toast, setToastMsg] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ cluster: SlideClusterResult; x: number; y: number } | null>(null)
  const [lightbox, setLightbox] = useState<{ list: SlideResult[]; index: number } | null>(null)
  const [expanded, setExpanded] = useState<SlideClusterResult | null>(null)
  const [details, setDetails] = useState<SlideResult | null>(null)
  // "See in context": when set, the main grid shows this whole presentation in slide order,
  // every slide fully usable (not a read-only popup). Cleared by typing or changing a filter.
  const [deckFilter, setDeckFilter] = useState<{ pid: string; title: string } | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showConvert, setShowConvert] = useState(false)
  const [showStats, setShowStats] = useState(false)
  // effective chords (defaults + his own shortcuts from Settings › Shortcuts), for keys, tooltips and the cheat sheet
  const [bindings, setBindings] = useState<Record<string, string>>(() => registry.bindingsOf({}))
  useEffect(() => {
    void window.sw.app.bindings().then((b) => { if (Object.keys(b).length) setBindings(b) })
    return window.sw.app.onSettingsChanged((b) => {
      setBindings(b)
      setRefreshKey((k) => k + 1)
    })
  }, [])
  const [showHelp, setShowHelp] = useState(false)
  // Search | Review | Triage (locked 2026-10-12); the Review tab carries how many need a look, the Triage tab a dot while the sorter runs
  const [appView, setAppView] = useState<'search' | 'review' | 'triage'>('search')
  const [triageTab, setTriageTab] = useState<TriageTab>('undecided') // kept while he is on another tab
  const sorterBusy = useSorterBusy()
  const [reviewCount, setReviewCount] = useState(0)
  const [stats, setStats] = useState<Stats | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  // a scan of the talks finished: counts, pills and the inspector follow the new usage
  useEffect(() => window.sw.archive.onTalkUsageChanged((r) => { if (r.ok) setRefreshKey((k) => k + 1) }), [])
  // keyboard selection + inspector + command palette
  const [sel, setSel] = useState(-1)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // an item opened from "More like this": the inspector shows it instead of the selected card until selection moves
  const [pinned, setPinned] = useState<SlideResult | null>(null)
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

  const openStats = useCallback(() => {
    setShowStats(true)
    if (!stats) void window.sw.archive.stats().then(setStats)
  }, [stats])

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
          if (lightbox || navCount > 0) {
            if (!lightbox && sel < 0) setSel(0)
            setPaletteOpen(true)
          }
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

  // Settings (⌘,), the cheat sheet (⌘/) and export/import work on every screen, over any overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      const id = commandForEvent(e, bindings, { inField: typing, onControl: false, overlay: false })
      if (!id || !FRAME_COMMANDS.has(id)) return
      e.preventDefault()
      runCommand(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bindings, runCommand])
  // menu-bar commands (generated from the registry in main) run here; Settings, Export and Import run in main
  useEffect(() => window.sw.app.onCommand((id) => runCommand(id)), [runCommand])
  // the menu greys out what cannot run now
  useEffect(() => {
    void window.sw.app.setContext({ view: appView, hasItems: navCount > 0, hasActive: Boolean(activeItem) })
  }, [appView, navCount, activeItem])

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

  useEffect(() => {
    void window.sw.review.overview({ queue: 0, sample: 0 }).then((o) => setReviewCount(o.needALook)).catch(() => undefined)
  }, [refreshKey])

  return (
    <div className={inspectorOpen && appView === 'search' ? 'app has-sidebar' : 'app'} onClick={() => menu && setMenu(null)}>
      <header className="titlebar">
        <span className="wordmark">
          Slide<span className="well">Well</span>
        </span>
        <div className="scope view-switch" role="tablist" aria-label="View">
          <button role="tab" aria-selected={appView === 'search'} className={appView === 'search' ? 'scope-tab active' : 'scope-tab'} onClick={() => setAppView('search')}>
            Search
          </button>
          <button role="tab" aria-selected={appView === 'review'} className={appView === 'review' ? 'scope-tab active' : 'scope-tab'} onClick={() => setAppView('review')}>
            Review {reviewCount > 0 && <span className="rv-tab-n">{reviewCount}</span>}
          </button>
          <button role="tab" aria-selected={appView === 'triage'} className={appView === 'triage' ? 'scope-tab active' : 'scope-tab'} onClick={() => setAppView('triage')}>
            Triage
            {sorterBusy && <span className="pulse-dot" role="img" aria-label="sorting" />}
          </button>
        </div>
        <div className="titlebar-actions">
          <button
            className="tb-btn"
            onClick={() => {
              setShowStats(true)
              if (!stats) void window.sw.archive.stats().then(setStats)
            }}
            title={withChord(bindings, 'stats', 'Your PowerPoint history in numbers')}
          >
            📊 Stats
          </button>
          <button className="tb-btn" onClick={() => setShowImport(true)} title={withChord(bindings, 'import', 'Import PowerPoint into the archive')}>
            ⤓ Import
          </button>
          <button
            className="tb-btn"
            onClick={() => setShowConvert(true)}
            title="Convert someone else's PowerPoint to an editable Outline — saved where you choose, never added to your archive or vault"
          >
            ⇄ Convert
          </button>
          <button className="tb-btn" onClick={() => runCommand('settings')} title={withChord(bindings, 'settings', 'Settings')}>
            ⚙
          </button>
          <button className="tb-btn" onClick={() => setShowHelp(true)} title={withChord(bindings, 'cheat', 'Keyboard shortcuts')}>
            ⌨
          </button>
        </div>
      </header>

      <TeachRoundHost onShowReview={() => setAppView('review')} onOpenAutoSorting={() => { setTriageTab('auto'); setAppView('triage') }} />
      {appView === 'review' && <ReviewScreen onCount={setReviewCount} onToast={setToast} onOpenAutoSorting={() => { setTriageTab('auto'); setAppView('triage') }} />}
      {appView === 'triage' && (
        <TriagePanel tab={triageTab} onTab={setTriageTab} onReview={() => setAppView('review')} onSettings={() => void window.sw.app.openSettings('capture')} onChanged={() => setRefreshKey((k) => k + 1)} onToast={setToast} />
      )}
      {appView === 'search' && (<>
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
          <span className="filter-label">Library</span>
          <div className="scope" role="tablist" aria-label="Which library">
            {(['mine', 'others', 'all'] as const).map((l) => (
              <button
                key={l}
                role="tab"
                aria-selected={filters.library === l}
                className={filters.library === l ? 'scope-tab active' : 'scope-tab'}
                title={l === 'mine' ? 'Your own archive' : l === 'others' ? "Other people's slides (kept separate)" : 'Both libraries'}
                onClick={() => patch({ library: l })}
              >
                {l === 'mine' ? 'Mine' : l === 'others' ? 'Others' : 'All'}
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
        {filters.library === 'others' && (
          <button
            className="toggle danger"
            onClick={() => void deleteOthersMatching()}
            title="Delete the Others' Library presentations matching the current filter/search (no filter = the whole library). Your own archive is never touched."
          >
            🗑 Delete matching…
          </button>
        )}
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
      </>)}

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
        <PictureSearchStatusBar />
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

      {showHelp && <HelpOverlay bindings={bindings} onClose={() => setShowHelp(false)} />}

      {showImport && <ImportPanel onClose={() => setShowImport(false)} onDone={() => setRefreshKey((k) => k + 1)} />}

      {showConvert && <ConvertPanel onClose={() => setShowConvert(false)} />}

      {showStats && <StatsPanel stats={stats} onClose={() => setShowStats(false)} />}


      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

// Partition triage items into [date, items] groups, preserving the (date-sorted) order.
function groupByDateList(items: TriageItem[]): Array<[string, TriageItem[]]> {
  const groups: Array<[string, TriageItem[]]> = []
  const map = new Map<string, TriageItem[]>()
  for (const it of items) {
    const d = it.date || ''
    let arr = map.get(d)
    if (!arr) {
      arr = []
      map.set(d, arr)
      groups.push([d, arr])
    }
    arr.push(it)
  }
  return groups
}

// ADR-0029: triage a source folder of screenshots/videos. Reads but never owns the folder; include
// promotes a file into the well, exclude remembers its hash. The App's global keyboard layer yields
// to this panel (it bails while the Triage tab is showing), so we run our own. Triage is a main tab;
// its fifth tab, Auto sorting, is not a grid: the grid controls and grid keys are off there.
type TriageTab = 'undecided' | 'selected' | 'excluded' | 'all' | 'auto'
function TriagePanel({ tab, onTab, onReview, onSettings, onChanged, onToast }: { tab: TriageTab; onTab: (t: TriageTab) => void; onReview: () => void; onSettings: () => void; onChanged: () => void; onToast: (m: string) => void }): JSX.Element {
  const sorterBusy = useSorterBusy()
  const [root, setRoot] = useState<string | null | undefined>(undefined) // undefined = loading, null = unset
  const [items, setItems] = useState<TriageItem[]>([])
  const [counts, setCounts] = useState<TriageCounts>({ undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 })
  const [cols, setCols] = useState<number>(() => {
    const n = Number(localStorage.getItem('sw.triage.cols'))
    return n >= 2 && n <= 6 ? n : 6
  })
  useEffect(() => { localStorage.setItem('sw.triage.cols', String(cols)) }, [cols])
  // fewer columns → taller tiles, so the preview genuinely grows
  const THUMB_H: Record<number, number> = { 2: 320, 3: 260, 4: 210, 5: 175, 6: 150 }
  const gridVars = { ['--triage-cols']: cols, ['--triage-thumb-h']: `${THUMB_H[cols] ?? 150}px` } as React.CSSProperties
  const [q, setQ] = useState('')
  const [debq, setDebq] = useState('')
  const stateFilter = tab === 'auto' ? 'undecided' : tab // the grid behind the counts; Auto sorting lists nothing
  const [sort, setSort] = useState<'scanned' | 'date-desc' | 'date-asc'>('scanned')
  const [apps, setApps] = useTickedApps() // the source apps ticked in the App menu (kept for the session)
  const appsKey = apps.join('\u0000')
  const [groupByDate, setGroupByDate] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState('')
  // The import run (started here, or already going when the panel opened); its result line stays until dismissed or the next run.
  const [imp, setImp] = useState<ImportState>(IDLE)
  const impRef = useRef<ImportState>(IDLE)
  const setImpState = (next: ImportState): void => {
    impRef.current = next
    setImp(next)
  }
  const [sel, setSel] = useState(0)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [preview, setPreview] = useState<TriageItem | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const PAGE = 150

  useEffect(() => {
    const t = setTimeout(() => setDebq(q), 250)
    return () => clearTimeout(t)
  }, [q])

  // grouping needs the list date-ordered so each day's items are contiguous
  const listSort = groupByDate && !sort.startsWith('date') ? 'date-desc' : sort
  const refresh = useCallback(async () => {
    try {
      const r = await window.sw.triage.list(debq, stateFilter, listSort, PAGE, page * PAGE, apps.length ? apps : undefined)
      setItems(r.items)
      setCounts(r.counts)
      setHasMore(r.hasMore)
      setSel((s) => Math.min(s, Math.max(0, r.items.length - 1)))
    } catch {
      /* a mid-scan read may briefly lose to a write; the next tick retries */
    }
  }, [debq, stateFilter, listSort, page, appsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // a filter/search/sort change resets to the first page
  useEffect(() => setPage(0), [debq, stateFilter, listSort, appsKey])
  // jump to the top of the grid when the page changes
  useEffect(() => {
    document.querySelector('.triage-scroll')?.scrollTo(0, 0)
  }, [page])

  // Lazy load: as the scan streams progress, re-list (throttled) so rows appear as they land —
  // the user sees continuous movement instead of a blank "scanning…".
  const refreshRef = useRef(refresh)
  const lastTickRef = useRef(0)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])
  useEffect(() => {
    void window.sw.settings.getPaths().then((p) => setRoot(p.screenshotRoot ?? p.captureSources.find((c) => c.exists)?.path ?? null))
    const offChanged = window.sw.triage.onChanged(() => void refreshRef.current())
    const offProgress = window.sw.triage.onProgress((line) => {
      setProgress(line)
      const now = Date.now()
      if (now - lastTickRef.current > 600) {
        lastTickRef.current = now
        void refreshRef.current()
      }
    })
    const offImport = window.sw.triage.onImportProgress((snap) => {
      setImpState(applySnapshot(impRef.current, snap))
      const now = Date.now()
      if (snap.phase !== 'working' || now - lastTickRef.current > 600) {
        lastTickRef.current = now
        void refreshRef.current()
      }
    })
    void window.sw.triage.importStatus().then((st) => {
      if (!isWorking(impRef.current)) setImpState(adoptStatus(st))
    })
    return () => {
      offChanged()
      offProgress()
      offImport()
    }
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
    async (item: TriageItem, action: 'select' | 'exclude' | 'reset') => {
      const r = await window.sw.triage.decide(item.hash, action)
      if (r.refused) {
        onToast(r.refused)
        await refresh()
        return
      }
      const newState = (r.state as TriageItem['state']) || 'undecided'
      setItems((prev) => prev.map((it) => (it.hash === item.hash ? { ...it, state: newState } : it)))
      // Counts come from the main process: it counts DISTINCT hashes per bucket, so two files with
      // identical content are one selection. Adjusting ±1 per path here overcounted that case.
      await refresh()
      onToast(action === 'select' ? 'Selected' : action === 'exclude' ? 'Excluded' : 'Unselected')
      onChanged()
    },
    [onChanged, onToast, refresh]
  )

  // Lightbox decision: record it, then show the next card (unselect stays; last card stays). The
  // preview stays open; the grid selection follows so closing lands on the card last viewed.
  const decideInPreview = useCallback(
    (action: 'select' | 'exclude' | 'reset') => {
      if (!preview) return
      void decide(preview, action)
      const idx = items.findIndex((it) => it.relPath === preview.relPath)
      const n = nextPreviewIndex(idx, items.length, action)
      if (n >= 0) {
        setPreview(items[n])
        setSel(n)
      }
    },
    [preview, items, decide]
  )

  const importSelected = useCallback(async () => {
    const click = startClick(impRef.current)
    if (!click.start) return // a run is already going; its progress is on screen
    setImpState(click.state) // working from the click, before main answers
    // staged large videos need an explicit confirm each (rare); only those currently in view can be
    // confirmed — others are reported as "over gate" and stay staged until imported from the Selected tab
    const forceHashes: string[] = []
    for (const v of items.filter((it) => it.state === 'selected' && it.kind === 'video' && it.large)) {
      if (window.confirm(`"${v.filename}" is ${v.sizeMB} MB — over the 20 MB video gate. Import it anyway?`)) forceHashes.push(v.hash)
    }
    try {
      const r = await window.sw.triage.importSelected(forceHashes)
      setImpState(r.error ? { phase: 'failed', message: r.error } : { phase: 'done', imported: r.imported, skipped: r.skipped, gated: r.gated })
    } catch (err) {
      setImpState({ phase: 'failed', message: failureMessage(err) })
    }
    await refresh()
    onChanged()
  }, [items, refresh, onChanged])

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
      if (tab === 'auto') return // no grid here: the tab has its own controls
      if (el?.closest('.tam-pop, .tri-confirm, .tr-round')) return // the App menu and its confirm box own the keyboard while open
      if (e.key === 'Escape') {
        if (preview) setPreview(null)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void paste()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        // ⌘Y — see the full image/video
        const cur = preview ?? items[sel]
        if (cur) {
          e.preventDefault()
          setPreview(cur)
        }
        return
      }
      if (preview) {
        if (e.key === ' ' || e.key === 's' || e.key === 'S' || e.key === 'i' || e.key === 'I') {
          e.preventDefault(); decideInPreview('select')
        } else if (e.key === 'x' || e.key === 'X' || e.key === 'e' || e.key === 'E') {
          e.preventDefault(); decideInPreview('exclude')
        } else if (e.key === 'u' || e.key === 'U') {
          e.preventDefault(); decideInPreview('reset')
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
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min((s < 0 ? 0 : s) + cols, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max((s < 0 ? 0 : s) - cols, 0))
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault(); setPreview(cur)
      } else if (e.key === ' ' && cur) {
        // Space toggles: select if not selected (then advance), else unselect (stay)
        e.preventDefault()
        if (cur.state === 'selected') {
          void decide(cur, 'reset')
        } else {
          void decide(cur, 'select')
          setSel((s) => Math.min(s + 1, items.length - 1))
        }
      } else if ((e.key === 's' || e.key === 'S' || e.key === 'i' || e.key === 'I') && cur) {
        e.preventDefault(); void decide(cur, 'select'); setSel((s) => Math.min(s + 1, items.length - 1)) // select → advance
      } else if ((e.key === 'x' || e.key === 'X' || e.key === 'e' || e.key === 'E') && cur) {
        e.preventDefault(); void decide(cur, 'exclude'); setSel((s) => Math.min(s + 1, items.length - 1)) // X = exclude → advance
      } else if ((e.key === 'u' || e.key === 'U') && cur) {
        e.preventDefault(); void decide(cur, 'reset') // U = unselect → undecided, stay
      } else if (e.key === '[') {
        e.preventDefault()
        setPage((p) => Math.max(0, p - 1))
        setSel(0)
      } else if (e.key === ']' && hasMore) {
        e.preventDefault()
        setPage((p) => p + 1)
        setSel(0)
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, sel, preview, hasMore, decide, decideInPreview, paste, cols, importSelected, tab])

  return (
    <>
        <div className="triage-panel">
          <div className="triage-head">
            <b>⛏ Triage</b>
            {typeof root === 'string' && (
              <span className="triage-root" title={root}>
                {root}
              </span>
            )}
            <div className="triage-head-actions">
              {imp.phase !== 'idle' && (
                <span className={imp.phase === 'failed' ? 'triage-import-line failed' : 'triage-import-line'} role="status" data-testid="triage-import-line">
                  {importLine(imp)}
                  {!isWorking(imp) && (
                    <button className="copyref" onClick={() => setImpState(IDLE)} aria-label="Dismiss">
                      ✕
                    </button>
                  )}
                </span>
              )}
              <button className="primary-btn" onClick={() => void importSelected()} disabled={counts.selected === 0 || isWorking(imp)} title="Import all selected screenshots into the well">
                {importButtonLabel(imp, counts.selected)}
              </button>
              <button className="tb-btn" onClick={() => void paste()} title="Paste an image from the clipboard (⌘V)">
                ⎘ Paste
              </button>
              <button className="tb-btn" onClick={() => void scan()} disabled={scanning || !root} title="Re-scan the source for new files">
                {scanning ? '… scanning' : '⟳ Rescan'}
              </button>
              <button className="tb-btn" onClick={() => void chooseFolder()}>
                {root ? '⌖ Change folder' : '⌖ Choose folder'}
              </button>
            </div>
          </div>

          <div className="triage-controls">
            <div className="scope" role="tablist" aria-label="Triage state">
              {(['undecided', 'selected', 'excluded', 'all'] as const).map((s) => (
                <button key={s} role="tab" aria-selected={tab === s} className={tab === s ? 'scope-tab active' : 'scope-tab'} onClick={() => onTab(s)}>
                  {s[0].toUpperCase() + s.slice(1)}
                  {s !== 'all' ? ` ${counts[s]}` : ''}
                </button>
              ))}
              <span className="scope-sep" />
              <button role="tab" aria-selected={tab === 'auto'} className={tab === 'auto' ? 'scope-tab new active' : 'scope-tab new'} onClick={() => onTab('auto')}>
                Auto sorting
                {sorterBusy && <span className="pulse-dot" role="img" aria-label="sorting" />}
              </button>
            </div>
            {tab === 'auto' ? (
              <span className="triage-auto-note">Search, grid size and date grouping apply to the first four tabs only.</span>
            ) : typeof root === 'string' ? (
              <>
                <input
                  ref={searchRef}
                  className="search-input"
                  placeholder="Search text…  / focus · S select · X exclude"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <TriageAppMenu state={stateFilter} ticked={apps} onChange={setApps} version={counts.undecided + counts.selected + counts.excluded} />
                <select className="triage-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
                  <option value="scanned">Recently scanned</option>
                  <option value="date-desc">Date — newest</option>
                  <option value="date-asc">Date — oldest</option>
                </select>
                <div className="triage-cols" role="group" aria-label="Grid size">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} className={cols === n ? 'active' : ''} onClick={() => setCols(n)} title={`${n} columns`}>{n}</button>
                  ))}
                </div>
                <label className="toggle" title="Group by capture date">
                  <input type="checkbox" checked={groupByDate} onChange={(e) => setGroupByDate(e.target.checked)} /> Group by date
                </label>
              </>
            ) : null}
            {progress && <span className="triage-progress">{progress}</span>}
          </div>

          {tab === 'auto' ? (
            <AutoSortingTab onReview={onReview} onSettings={onSettings} triageUndecided={counts.undecided} />
          ) : root === undefined ? (
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
              {stateFilter === 'undecided' && <TriageAppBar ticked={apps} version={counts.undecided} onDecided={() => { void refresh(); onChanged() }} />}
              {items.length === 0 ? (
                <div className="triage-empty">
                  <p>{scanning ? 'Scanning…' : counts.total === 0 ? 'Nothing scanned yet.' : `No ${stateFilter} items.`}</p>
                  {counts.total === 0 && !scanning && (
                    <button className="primary-btn" onClick={() => void scan()}>
                      ⟳ Scan this folder
                    </button>
                  )}
                </div>
              ) : groupByDate ? (
                <div className="triage-scroll" style={gridVars}>
                  {groupByDateList(items).map(([date, group]) => (
                    <div className="triage-group" key={date || 'unknown'}>
                      <div className="triage-group-head">
                        {date || 'unknown date'} · {group.length}
                      </div>
                      <div className="triage-grid">
                        {group.map((it) => {
                          const i = items.indexOf(it)
                          return <TriageCard key={it.relPath} item={it} selected={i === sel} onSelect={() => setSel(i)} onOpen={() => setPreview(it)} onDecide={(a) => void decide(it, a)} />
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="triage-grid triage-scroll" style={gridVars}>
                  {items.map((it, i) => (
                    <TriageCard key={it.relPath} item={it} selected={i === sel} onSelect={() => setSel(i)} onOpen={() => setPreview(it)} onDecide={(a) => void decide(it, a)} />
                  ))}
                </div>
              )}

              {(page > 0 || hasMore) && (
                <div className="triage-foot">
                  <button disabled={page === 0} onClick={() => { setPage((p) => Math.max(0, p - 1)); setSel(0) }}>‹ Prev  [</button>
                  <span>
                    {items.length > 0 ? `${page * PAGE + 1}–${page * PAGE + items.length}` : '0'}
                    {!debq ? ` of ${stateFilter === 'all' ? counts.total : counts[stateFilter]}` : ''}
                  </span>
                  <button disabled={!hasMore} onClick={() => { setPage((p) => p + 1); setSel(0) }}>]  Next ›</button>
                </div>
              )}
            </>
          )}
        </div>
      {preview && (
        <TriagePreview
          item={items.find((it) => it.relPath === preview.relPath) ?? preview}
          onClose={() => setPreview(null)}
          onDecide={decideInPreview}
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
  onDecide: (a: 'select' | 'exclude' | 'reset') => void
}): JSX.Element {
  const badge = item.state === 'included' ? '✓' : item.state === 'selected' ? '✓' : item.state === 'excluded' ? '✗' : ''
  // review pile (ticket 08): a throwaway stays findable here, labelled, until it reaches the Bin
  const throwaway = item.pile === 'throwaway' ? `throwaway · bin in ${item.binInDays === 1 ? '1 day' : `${item.binInDays ?? 30} days`}` : ''
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
        {throwaway && <span className="triage-throwaway">{throwaway}</span>}
      </div>
      <div className="triage-meta">
        <div className="triage-name" title={item.filename}>{item.filename}</div>
        {(item.app || item.windowTitle || item.takenAt) && (
          <div className="triage-from" title={[item.takenAt?.replace('T', ' ').slice(0, 16), item.app, item.windowTitle].filter(Boolean).join(' · ')}>
            {item.takenAt && <span className="triage-when">{item.takenAt.slice(0, 10)} {item.takenAt.slice(11, 16)}</span>}
            {item.app && <span className="triage-app">{item.app}</span>}
            {item.windowTitle && <span className="triage-win">{item.windowTitle}</span>}
          </div>
        )}
        {item.snippet && <div className="triage-snip">{item.snippet}</div>}
      </div>
      <div className="triage-actions">
        {item.state !== 'selected' && item.state !== 'included' && (
          <button className="ti-inc" disabled={item.offline} title={item.offline ? 'Download it in OneDrive first' : 'Select (S / Space)'} onClick={(e) => { e.stopPropagation(); onDecide('select') }}>Select</button>
        )}
        {item.state !== 'excluded' && (
          <button className="ti-exc" title="Exclude (X)" onClick={(e) => { e.stopPropagation(); onDecide('exclude') }}>Exclude</button>
        )}
        {item.state !== 'undecided' && item.state !== 'included' && (
          <button className="ti-rst" title="Unselect (U)" onClick={(e) => { e.stopPropagation(); onDecide('reset') }}>Unselect</button>
        )}
      </div>
    </div>
  )
}

function TriagePreview({ item, onClose, onDecide }: { item: TriageItem; onClose: () => void; onDecide: (a: 'select' | 'exclude' | 'reset') => void }): JSX.Element {
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
          <button className="ti-inc" onClick={() => onDecide('select')}>Select (Space)</button>
          <button className="ti-exc" onClick={() => onDecide('exclude')}>Exclude (X)</button>
          {item.state !== 'undecided' && item.state !== 'included' && <button className="copyref" onClick={() => onDecide('reset')}>Unselect (U)</button>}
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
      </div>
    </div>
  )
}

/** The settings frame's commands: they work on every screen and over any overlay. */
const FRAME_COMMANDS: ReadonlySet<string> = new Set(['settings', 'cheat', 'export-settings', 'import-settings'])

const fileName = (p: string): string => p.split('/').pop() || p

// The displayed author/owner of a result. In the Others' Library it's the deck's author (else
// "unknown"); in your own archive it's "me" by default, unless a deck is detected as someone else's.
const authorOf = (h: { library?: 'mine' | 'others'; ownership?: string; author?: string }): string =>
  h.library === 'others' ? h.author?.trim() || 'unknown' : h.ownership === 'others' && h.author?.trim() ? h.author.trim() : 'me'

function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [target, setTarget] = useState<string | null>(null)
  const [archive, setArchive] = useState('')
  const [othersRoot, setOthersRoot] = useState('')
  const [destLib, setDestLib] = useState<'mine' | 'others'>('mine')
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => window.sw.ingest.onLine((l) => setLines((prev) => [...prev, l])), [])
  useEffect(() => {
    void window.sw.settings.getPaths().then((p) => {
      setArchive(p.archiveRoot ?? p.archiveDefault)
      setOthersRoot(p.othersArchiveRoot)
    })
  }, [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])
  async function choose(): Promise<void> {
    const p = await window.sw.ingest.choosePath()
    if (p) setTarget(p)
  }
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
          <b>Import PowerPoint</b>
          <button className="copyref" onClick={onClose} disabled={running}>close ✕</button>
        </div>
        <p className="settings-note">
          Extracts + OCRs slides into a searchable library. Choose <b>your archive</b> (your own presentations) or your separate{' '}
          <b>Others’ Library</b> (other people’s slides, kept out of your archive).
        </p>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">Add to which library</div>
              <div className="settings-row-detail"><i>{destLib === 'mine' ? 'Catalogued as part of your own library.' : 'A separate store — other people’s slides never mix into your archive.'}</i></div>
            </div>
            <div className="scope" role="tablist" aria-label="Destination library">
              <button role="tab" aria-selected={destLib === 'mine'} className={destLib === 'mine' ? 'scope-tab active' : 'scope-tab'} onClick={() => setDestLib('mine')}>My archive</button>
              <button role="tab" aria-selected={destLib === 'others'} className={destLib === 'others' ? 'scope-tab active' : 'scope-tab'} onClick={() => setDestLib('others')}>Others’ library</button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">What to import</div>
              <div className="settings-row-detail" title={target ?? ''}>{target ?? '— no file or folder chosen —'}</div>
            </div>
            <button className="copyref" disabled={running} onClick={() => void choose()}>Choose file / folder…</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">Where it goes</div>
              <div className="settings-row-detail" title={destLib === 'mine' ? archive : othersRoot}>{(destLib === 'mine' ? archive : othersRoot) || '— not set —'}</div>
              <div className="settings-row-detail"><i>{destLib === 'mine' ? 'Your archive (change it in ⚙ Settings).' : 'Your Others’ Library (change it in ⚙ Settings).'}</i></div>
            </div>
          </div>
        </div>
        <div className="import-actions">
          <button className="primary-btn" disabled={running || !target} onClick={() => target && void run(() => window.sw.ingest.runPath(target, destLib))}>
            {destLib === 'mine' ? 'Import to my archive' : 'Import to Others’ library'}
          </button>
          {destLib === 'mine' && (
            <button className="copyref" disabled={running} title="Crawl + extract every not-yet-imported presentation already in the archive" onClick={() => void run(() => window.sw.ingest.pending())}>
              …or ingest everything pending
            </button>
          )}
          {running && (
            <button className="copyref" onClick={() => void window.sw.ingest.cancel()}>Cancel</button>
          )}
        </div>
        <pre className="import-log" ref={logRef}>
          {lines.join('\n') || 'Pick the destination library, choose a file/folder, then Import. Extraction + OCR run via Core A; progress streams here. Re-running is safe — done presentations are skipped.'}
        </pre>
        {running && <div className="results-head">running in the background — you can keep searching</div>}
      </div>
    </div>
  )
}

// Convert (sideband, throwaway): turn SOMEONE ELSE'S .pptx into a mechanical Outline folder the
// user picks. Source + destination + options are all chosen IN the panel before the final Convert.
function ConvertPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [ocr, setOcr] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  const [dest, setDest] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => window.sw.convert.onLine((l) => setLines((prev) => [...prev, l])), [])
  useEffect(() => {
    void window.sw.settings.getPaths().then((p) => setOcr(p.convertOcrDefault))
  }, [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])
  async function chooseSource(): Promise<void> {
    const p = await window.sw.convert.chooseSource()
    if (p) {
      setSource(p)
      setDone(null)
    }
  }
  async function chooseDest(): Promise<void> {
    if (!source) return
    const p = await window.sw.convert.chooseDest(source)
    if (p) setDest(p)
  }
  async function run(): Promise<void> {
    if (!source || !dest) return
    setRunning(true)
    setDone(null)
    setLines([])
    const r = await window.sw.convert.run({ pptxPath: source, outDir: dest, ocr })
    setRunning(false)
    if (r.ok && r.outDir) setDone(r.outDir)
  }
  const toggleOcr = (v: boolean): void => {
    setOcr(v)
    void window.sw.settings.setConvertOcr(v)
  }
  return (
    <div className="overlay" onClick={running ? undefined : onClose}>
      <div className="modal import" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Convert someone else’s PowerPoint to an Outline</b>
          <button className="copyref" onClick={onClose} disabled={running}>close ✕</button>
        </div>
        <p className="settings-note">
          Makes an editable TalkWeaver Outline saved wherever you choose. <b>Never</b> added to your archive or vault, and stamped <code>origin: external</code> so it stays clearly not-yours.
        </p>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">1 · PowerPoint to convert</div>
              <div className="settings-row-detail" title={source ?? ''}>{source ? fileName(source) : '— no file chosen —'}</div>
            </div>
            <button className="copyref" disabled={running} onClick={() => void chooseSource()}>Choose .pptx…</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">2 · Save the Outline to</div>
              <div className="settings-row-detail" title={dest ?? ''}>{dest ?? (source ? '— choose a destination folder —' : '— pick a PowerPoint first —')}</div>
            </div>
            <button className="copyref" disabled={running || !source} onClick={() => void chooseDest()}>Choose folder…</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">3 · OCR image text</div>
              <div className="settings-row-detail">Recognise text inside images (macOS Vision) and inline it into the Outline.</div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={ocr} onChange={(e) => toggleOcr(e.target.checked)} /> {ocr ? 'On' : 'Off'}
            </label>
          </div>
        </div>
        <div className="import-actions">
          <button className="primary-btn" disabled={running || !source || !dest} onClick={() => void run()}>
            Convert →
          </button>
        </div>
        <pre className="import-log" ref={logRef}>
          {lines.join('\n') ||
            'Pick a PowerPoint and a destination folder, then Convert. SlideWell extracts it in a scratch space and writes a mechanical Outline (outline + assets) where you chose. Nothing is added to your library.'}
        </pre>
        {done && <div className="results-head">✓ Saved to {done} — revealed in Finder.</div>}
        {running && <div className="results-head">converting…</div>}
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

function talksLine(n: number): string {
  return `used in ${n} talk${n === 1 ? '' : 's'}`
}

function clusterBadge(c: SlideClusterResult): string {
  if (c.size > 1 && c.lookAlike) return `▸ ${c.size} versions`
  if (c.size > 1) return `▸ ${c.size} near-identical in ${c.deckCount} presentation${c.deckCount === 1 ? '' : 's'}`
  if (c.representative.usedInDecks > 1) return `used in ${c.representative.usedInDecks} presentations`
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
  const who = authorOf(h)
  const foot = [h.filename || h.deck, h.slideOrder !== null ? `#${h.slideOrder}` : '', h.date ? h.date.slice(0, 10) : '', h.category, who !== 'me' ? `by ${who}` : '']
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
        {h.score && <span className={`score-chip ${h.score.kind}`} title={h.score.kind === 'words' ? 'How well the words match, 0 to 1' : 'How closely the picture matches, 0 to 1'}>{h.score.label}</span>}
        {h.library === 'others' && <span className="ocr-tag others" title="From your Others' Library — not your own presentation">OTHERS</span>}
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
          {(h.usedInTalks ?? 0) > 0 && <span className="badge talks">{talksLine(h.usedInTalks ?? 0)}</span>}
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
              <b>{fmt(s.totalDecks)} presentations</b> ({fmt(s.distinctTalks)} distinct talks) · <b>{fmt(s.totalSlides)} slides</b> · {fmt(s.totalImages)} images
              {s.firstYear && s.lastYear ? ` · ${s.firstYear}–${s.lastYear} · ${s.yearsActive} years` : ''}
            </p>
            <p className="stats-sub">
              avg <b>{s.avgSlidesPerDeck}</b> slides/presentation · median <b>{s.medianSlidesPerDeck}</b>
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
                +{s.masterDeckCount} master/library presentation{s.masterDeckCount === 1 ? '' : 's'} ({fmt(s.masterSlides)} slides) excluded from slide stats.
              </p>
            )}

            <h3>🗓️ Presentations per year</h3>
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

            <h3>📐 Presentation sizes</h3>
            <div className="statbars">
              {s.sizeBuckets.map((b) => (
                <StatBar key={b.label} value={b.decks} max={maxSize} label={b.label} suffix={`${b.decks} presentations`} />
              ))}
            </div>

            <div className="stats-cols">
              <div>
                <h3>🏷️ Top categories</h3>
                <table className="stats-table">
                  <thead>
                    <tr><th>Category</th><th>Presentations</th><th>Slides</th></tr>
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
                    <tr><th>Month</th><th>Presentations</th><th>Slides</th></tr>
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
              {s.superlatives.mostProlificYear && <li>Most prolific year: <b>{s.superlatives.mostProlificYear.year}</b> ({s.superlatives.mostProlificYear.decks} presentations)</li>}
              {s.superlatives.mostSlidesYear && <li>Most slides in a year: <b>{s.superlatives.mostSlidesYear.year}</b> ({fmt(s.superlatives.mostSlidesYear.slides)} slides)</li>}
              {s.superlatives.busiestMonth && <li>Busiest month: <b>{s.superlatives.busiestMonth.label}</b> ({s.superlatives.busiestMonth.decks} presentations)</li>}
              {s.superlatives.biggestDeck && (
                <li>Biggest presentation: <b>{s.superlatives.biggestDeck.title}</b> — {fmt(s.superlatives.biggestDeck.slides)} slides{s.superlatives.biggestDeck.year ? ` (${s.superlatives.biggestDeck.year})` : ''}</li>
              )}
              {s.superlatives.firstYearAvg && s.superlatives.lastYearAvg && (
                <li>
                  Presentation-size trend: {s.superlatives.firstYearAvg.avg}/presentation in {s.superlatives.firstYearAvg.year} → {s.superlatives.lastYearAvg.avg} in {s.superlatives.lastYearAvg.year}
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
        {deck.library === 'others' && <span className="ocr-tag others" title="From your Others' Library">OTHERS</span>}
      </div>
      <div className="meta">
        <div className="card-title" title={deck.title}>{deck.title}</div>
        <div className="card-foot">
          <span className="deck">{[deck.date ? deck.date.slice(0, 10) : '', deck.category, authorOf(deck) !== 'me' ? `by ${authorOf(deck)}` : ''].filter(Boolean).join(' · ') || deck.filename}</span>
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
    ['Author', authorOf({ library: detail.library, ownership: detail.ownership, author: detail.author })],
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
    ...(k === 'well-image' ? [] : [{ id: 'context' as ActionId, label: 'See in context (whole presentation)' }]),
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
          <b>{cluster.size} {cluster.lookAlike ? 'versions' : 'near-identical slides'}</b>{cluster.lookAlike ? (cluster.lookAlike === 'same-picture' ? ' of the same picture' : ' of the same thing, changed') : ''}{cluster.members.some((m) => m.kind !== 'well-image') && <> across {cluster.deckCount} presentation{cluster.deckCount === 1 ? '' : 's'}</>}
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
    ['Presentation', hit.deckTitle || hit.deck],
    ['File', hit.filename],
    ['Slide', hit.slideOrder !== null ? String(hit.slideOrder + 1) : '—'],
    ['Date', hit.date ? hit.date.slice(0, 10) : '—'],
    ['Category', hit.category || '—'],
    ['Used in', `${hit.usedInDecks} presentation${hit.usedInDecks === 1 ? '' : 's'}`],
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
      { id: 'fullsize', label: 'See all slides in this presentation', shortcut: '↵' },
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
    ...(kind === 'well-image' ? [] : [{ id: 'context' as ActionId, label: 'See in context (whole presentation)', shortcut: 'X' }])
  ]
}

function MoreLikeThis({ hit, onOpen }: { hit: SlideResult; onOpen: (rep: SlideResult) => void }): JSX.Element {
  const [modelReady, setModelReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<MoreLikeThisResult | null>(null)
  useEffect(() => {
    let live = true
    void window.sw.picture.status().then((s) => live && setModelReady(s.model === 'ready'))
    const off = window.sw.picture.onStatus((s) => setModelReady(s.model === 'ready'))
    return () => {
      live = false
      off()
    }
  }, [])
  // a new item in the inspector starts with no results
  useEffect(() => setRes(null), [hit])
  const run = (): void => {
    setBusy(true)
    const asked = hit
    void window.sw.archive
      .moreLikeThis({ kind: hit.kind, deck: hit.deck, slideOrder: hit.slideOrder, reference: hit.reference })
      .then((r) => setRes((cur) => (asked === hit ? r : cur)))
      .catch((e) => setRes({ state: 'error', items: [], error: String(e) }))
      .finally(() => setBusy(false))
  }
  const hint = !modelReady
    ? 'Download the picture-search model in Settings to use this'
    : res?.state === 'not-indexed'
      ? 'Not indexed yet — picture search has not reached this one. Try again in a while.'
      : res?.state === 'none'
        ? 'Nothing similar found in other presentations or the well'
        : res?.state === 'error'
          ? 'Could not look this up just now'
          : 'by what’s on it · other presentations'
  return (
    <div className="more-like-this">
      <div className="mlt-bar">
        <button className="primary-btn" onClick={run} disabled={!modelReady || busy} title={modelReady ? 'Find pictures that look like this one' : 'Needs the picture-search model (Settings)'}>
          More like this
        </button>
        <span className={res && res.state !== 'ok' && modelReady ? 'mlt-hint quiet' : 'mlt-hint'}>{hint}</span>
      </div>
      {res?.state === 'ok' && (
        <div className="mlt-grid">
          {res.items.map((r, i) => (
            <button key={`${r.deck}-${r.slideOrder}-${r.reference}-${i}`} className="mlt-item" title={r.title} onClick={() => onOpen(r)}>
              {r.thumbUrl ? <img src={r.thumbUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="mlt-blank" />}
              {r.score && <span className="score-chip meaning">{r.score.label.replace('meaning ', '')}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
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
  onContext,
  pinned,
  onBackToList,
  onOpenSimilar
}: {
  hit: SlideResult
  pinned: boolean
  onBackToList: () => void
  onOpenSimilar: (rep: SlideResult) => void
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
    ['Presentation', hit.deckTitle || hit.deck || '—'],
    ['File', hit.filename || '—'],
    ...(hit.slideOrder !== null ? ([['Slide', String(hit.slideOrder + 1)]] as [string, string][]) : []),
    ['Date', hit.date ? hit.date.slice(0, 10) : '—'],
    ['Category', hit.category || '—'],
    ['Author', authorOf(hit)],
    ['Used in', `${hit.usedInDecks} presentation${hit.usedInDecks === 1 ? '' : 's'}`],
    ['Kind', kindLabel],
    ['Reference', hit.reference]
  ]
  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-head">
        <b>{hit.title}</b>
        <button className="copyref" onClick={onClose}>✕</button>
      </div>
      <div className="inspector-pos">
        {pinned ? (
          <>
            opened from More like this · <button className="link" onClick={onBackToList}>back to the list</button>
          </>
        ) : (
          <>{pos} · ←/→ to navigate</>
        )}
        {hit.score && <span className={`score-chip inline ${hit.score.kind}`}>{hit.score.label}</span>}</div>
      {hit.thumbUrl && <img className="deck-sidebar-cover" src={hit.thumbUrl} alt="" />}
      <div className="details-table">
        {rows.map(([k, v]) => (
          <div className="drow" key={k}>
            <span className="dk">{k}</span>
            <span className="dv">{v}</span>
          </div>
        ))}
        {!isSlide && hit.text && <div className="details-text">{hit.text}</div>}
        {(hit.talkUses ?? []).length > 0 && (
          <>
            <div className="inspector-section">Used in</div>
            <div className="used-in-box">
              {(hit.talkUses ?? []).map((u) => (
                <div className="used-in-row" key={u.relPath}>
                  {u.title}{u.slide !== null ? ` (slide ${u.slide})` : ''} — <button className="link" title="TalkWeaver has no link to a single talk yet, so this shows the talk's file in Finder" onClick={() => void window.sw.archive.revealTalk(u.relPath)}>Show talk file ↗</button>
                </div>
              ))}
            </div>
          </>
        )}
        <MoreLikeThis hit={hit} onOpen={onOpenSimilar} />
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

// The cheat sheet (⌘/, also ?): generated from the command registry with his own shortcuts applied. Every
// command is listed; one with no shortcut shows None. The Review and Triage screens' own keys follow.
function HelpOverlay({ bindings, onClose }: { bindings: Record<string, string>; onClose: () => void }): JSX.Element {
  const groups = registry.groups
    .map((group) => ({ group, entries: registry.defs.filter((d) => d.group === group && !d.hidden) }))
    .filter((g) => g.entries.length > 0)
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal help-modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Keyboard shortcuts</b>
          <button className="copyref" onClick={onClose}>close ✕</button>
        </div>
        <p className="settings-note">Change any shortcut in Settings › Shortcuts. Single-letter keys work when the cursor is outside the search field.</p>
        <div className="details-table help-table">
          {groups.map((g) => (
            <div key={g.group} className="help-group">
              <div className="help-group-head">{g.group}</div>
              {g.entries.map((d) => {
                const chord = bindings[d.id]
                const keys = chord ? [chord, ...aliasesOf(d.id)] : []
                return (
                  <div className="drow" key={d.id} data-command={d.id}>
                    <span className="dk help-key">{keys.length > 0 ? keys.join('  ·  ') : <span className="help-none">None</span>}</span>
                    <span className="dv">{d.label}</span>
                  </div>
                )
              })}
            </div>
          ))}
          <div className="help-group">
            <div className="help-group-head">On the Review and Triage screens</div>
            {SCREEN_KEYS.map(([screen, keys]) => (
              <div className="drow" key={screen}>
                <span className="dk help-key">{screen}</span>
                <span className="dv">{keys}</span>
              </div>
            ))}
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

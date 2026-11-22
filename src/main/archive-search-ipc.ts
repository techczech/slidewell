import { clipboard, nativeImage, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { archiveResults, deckSlides, slideStructure, slideImages, searchImages, listDecks, deckDetail, archiveStats, type SearchFilters, type EnrichedHit, type ImageHit } from './archive'
import { loadDeckMeta, categoryList, type DeckMetaIndex } from './deckmeta'
import { cachedDHash } from './look-alike/fingerprint'
import { mergeLookAlikeClusters } from './look-alike/merge-clusters'
import type { MatchMode } from './match-bands'
import { matchedSearch, rowIds, type MatchCluster, type MatchRow } from './matched-search'
import { runMoreLikeThis } from './more-like-this'
import type { PictureSearchService } from './picture-search/service'
import { planSources, matchesFromKind, countFrom, type FilterableResult, type FromCounts, type SourcePlan } from './searchfilters'
import { applyFilters, combinedDateFilter, parseQuery, resolveOwnershipFilter } from './searchlib'
import { talkAbsPath } from './talk-usage'
import type { TalkUsageService } from './talk-usage-service'
import { searchWell, wellByIds, wellAbsPath, type WellRow } from './well'
import type { AppHandle } from './app-handle'

interface Dependencies {
  appHandle: AppHandle
  archiveRoot: () => string
  archiveAvailable: () => boolean
  othersArchiveRootResolved: () => string
  othersArchiveAvailable: () => boolean
  wellRootResolved: () => string
  detectVaultRoot: () => string | null
  cacheDir: () => string
  swThumb: (abs: string | null) => string | null
  resolveSwUrlReal: (url: string) => string | null
  pictureSearch: PictureSearchService | null
  talkUsage: TalkUsageService
}

export function install(deps: Dependencies): void {
  const { appHandle, archiveRoot, archiveAvailable, othersArchiveRootResolved, othersArchiveAvailable, wellRootResolved, detectVaultRoot, cacheDir, swThumb, resolveSwUrlReal, pictureSearch, talkUsage } = deps
  // Read-only search over Core A. Returns [] when the archive isn't present (UI degrades gracefully).
  // renderAbsPath is converted to a renderable swarchive:// URL here; the renderer never sees raw paths.
  // Which archive store holds this deck's extraction — mine first, else the Others' Library. Lets
  // inspect/context actions resolve a result to the right store without threading library everywhere.
  const rootForDeck = (deck: string): string => {
    if (deck && existsSync(join(archiveRoot(), 'extracted', deck))) return archiveRoot()
    if (deck && existsSync(join(othersArchiveRootResolved(), 'extracted', deck))) return othersArchiveRootResolved()
    return archiveRoot()
  }
  const toWire = (h: EnrichedHit, library: 'mine' | 'others' = 'mine'): Record<string, unknown> => {
    const { renderAbsPath, ...rest } = h
    return { ...rest, thumbUrl: swThumb(renderAbsPath), library }
  }

  // A well image → the same wire shape as an archive hit, so the grid renders it uniformly.
  const wellToWire = (r: WellRow): Record<string, unknown> => {
    const abs = wellAbsPath(wellRootResolved(), detectVaultRoot(), r)
    const sourceLabel = r.source === 'talkweaver' ? 'TalkWeaver' : 'Screenshot'
    return {
      kind: 'well-image',
      title: r.slug ? r.slug.replace(/-/g, ' ') : sourceLabel,
      snippet: (r.ocr_text || r.notes || '').slice(0, 160),
      text: r.ocr_text || '',
      rank: 0,
      deck: r.source,
      deckTitle: sourceLabel,
      filename: `${r.slug}--${r.id}.${r.ext}`,
      category: r.tags || '',
      date: r.added_at || null,
      slideOrder: null,
      usedInDecks: 1,
      usedInTalks: (talkUsage.usage().get(r.id) ?? []).length,
      talkUses: talkUsage.usage().get(r.id) ?? [],
      reference: `![](img-${r.id})`,
      thumbUrl: swThumb(abs),
      library: 'mine',
      ownership: 'mine', // the well is the user's own content → author renders as "me"
      author: ''
    }
  }

  // An extracted-from-a-deck image → the wire shape, as a standalone image card.
  const archiveImageToWire = (im: ImageHit, idx: DeckMetaIndex, library: 'mine' | 'others' = 'mine'): Record<string, unknown> => {
    const m = idx[im.deck]
    return {
      library,
      kind: 'archive-image',
      title: m?.title || im.deck || '(image)',
      snippet: (im.snippet || '').slice(0, 160),
      text: im.snippet || '',
      rank: 0,
      deck: im.deck,
      deckTitle: m?.title || im.deck,
      filename: `${im.sha256}.${im.format}`,
      category: m?.category || '',
      date: m?.date ?? null,
      slideOrder: null,
      usedInDecks: im.usedInDecks,
      reference: im.reference,
      thumbUrl: swThumb(im.fileAbsPath),
      ownership: m?.ownership || 'unknown',
      author: m?.author || ''
    }
  }

  // Collect the wire rows for each store the plan asks for (ADR-0031 library choice applies to all).
  const collectResults = async (query: string, filters: SearchFilters, plan: SourcePlan): Promise<Array<Record<string, unknown>>> => {
    // Which store(s) to search: the user's archive, the separate Others' Library, or both.
    const lib = filters?.library ?? 'mine'
    const includeMine = lib !== 'others'
    const includeOthers = lib !== 'mine'
    const out: Array<Record<string, unknown>> = []

    // The others store has no "mine" decks, so the owner filter (default 'mine') would exclude
    // everything — neutralize it to 'all' there. Author is the lens for the Others' Library.
    const forStore = (library: 'mine' | 'others'): SearchFilters => (library === 'others' ? { ...filters, owner: 'all' } : filters)
    const pushSlides = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const clusters = await archiveResults(root, cacheDir(), query, forStore(library))
      for (const c of clusters) out.push({ representative: toWire(c.representative, library), members: c.members.map((m) => toWire(m, library)), size: c.size, deckCount: c.deckCount })
    }
    const pushImages = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const idx = loadDeckMeta(root, cacheDir())
      const deckNeedle = (filters.deck || '').toLowerCase()
      for (const im of await searchImages(root, query, 120)) {
        if (deckNeedle) {
          const m = idx[im.deck]
          if (!`${im.deck} ${m?.title || ''} ${m?.filename || ''}`.toLowerCase().includes(deckNeedle)) continue
        }
        const w = archiveImageToWire(im, idx, library)
        out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
      }
    }

    if (plan.slides) {
      if (includeMine && archiveAvailable()) {
        try { await pushSlides(archiveRoot(), 'mine') } catch { /* mine search failed */ }
      }
      if (includeOthers && othersArchiveAvailable()) {
        try { await pushSlides(othersArchiveRootResolved(), 'others') } catch { /* others search failed */ }
      }
    }
    if (plan.archiveImages) {
      if (includeMine && archiveAvailable()) {
        try { await pushImages(archiveRoot(), 'mine') } catch { /* mine images failed */ }
      }
      if (includeOthers && othersArchiveAvailable()) {
        try { await pushImages(othersArchiveRootResolved(), 'others') } catch { /* others images failed */ }
      }
    }
    // the well is the user's own — shown for Mine/All, not when searching Others only
    if (plan.well && includeMine) {
      try {
        const wellRows = await searchWell(wellRootResolved(), query, 60)
        // pictures talks use always get their chance, even past the first 60 words-matches
        const seen = new Set(wellRows.map((r) => r.id))
        const used = [...talkUsage.usage().keys()].slice(0, 900)
        for (const r of await searchWell(wellRootResolved(), query, 60, used).catch(() => [] as WellRow[])) if (!seen.has(r.id)) wellRows.push(r)
        for (const r of wellRows) {
          const w = wellToWire(r)
          out.push({ representative: w, members: [w], size: 1, deckCount: 1 })
        }
      } catch { /* no well yet */ }
    }
    return out
  }
  const rep = (c: Record<string, unknown>): FilterableResult => c.representative as FilterableResult

  /** Picture-search ids to wire rows (a size-1 cluster each), through the same Library/Owner/Date/Category/From/Kind filters as word hits. */
  async function resolvePictureIds(ids: string[], filters: SearchFilters, query: string): Promise<Map<string, MatchCluster>> {
    const from = filters?.from ?? 'all'
    const kind = filters?.kind ?? 'all'
    const lib = filters?.library ?? 'mine'
    const parsed = parseQuery(query ?? '')
    const out = new Map<string, MatchCluster>()
    const single = (w: Record<string, unknown>): MatchCluster => ({ representative: w as never, members: [w as never], size: 1, deckCount: 1 })
    const slidesByPid = new Map<string, Record<string, unknown>[]>()
    const wellIds: string[] = []
    for (const id of ids) {
      const m = id.match(/^slide:(.+)#(\d+)$/)
      if (m) {
        const pid = m[1]
        const root = rootForDeck(pid)
        const library: 'mine' | 'others' = root === othersArchiveRootResolved() && root !== archiveRoot() ? 'others' : 'mine'
        if ((library === 'mine' && lib === 'others') || (library === 'others' && lib === 'mine')) continue
        if (!slidesByPid.has(pid)) {
          try {
            slidesByPid.set(pid, (await deckSlides(root, cacheDir(), pid)).map((h) => toWire(h, library)))
          } catch {
            slidesByPid.set(pid, [])
          }
        }
        const w = slidesByPid.get(pid)!.find((r) => r.slideOrder === Number(m[2]))
        if (!w) continue
        const forLib = library === 'others' ? { ...filters, owner: 'all' as const } : filters
        const idx = loadDeckMeta(root, cacheDir())
        const subs = (f: string): string[] => (f ? [f.toLowerCase()] : [])
        const kept = applyFilters(
          [w as { deck: string }],
          idx,
          combinedDateFilter(parsed, filters.era),
          [...parsed.deckSubstrings, ...subs(filters.deck)],
          resolveOwnershipFilter(parsed.owner, forLib.owner),
          [...subs(filters.category), ...parsed.categorySubstrings]
        )
        if (kept.length && matchesFromKind(w as unknown as FilterableResult, from, kind)) out.set(id, single(w))
      } else if (id.startsWith('well:') && lib !== 'others') {
        wellIds.push(id.slice(5))
      }
    }
    if (wellIds.length) {
      for (const r of await wellByIds(wellRootResolved(), wellIds).catch(() => [] as WellRow[])) {
        const w = wellToWire(r)
        if (matchesFromKind(w as unknown as FilterableResult, from, kind)) out.set(`well:${r.id}`, single(w))
      }
    }
    return out
  }

  /** Group result clusters by appearance ("N versions") when grouping is on; items with no embedding keep their text clusters. */
  async function groupByLook<C>(clusters: C[], filters: SearchFilters): Promise<C[]> {
    if (!filters?.cluster || clusters.length < 2) return clusters
    try {
      return (await mergeLookAlikeClusters(clusters as never, {
        idOf: (row: MatchRow) => rowIds(row)[0] ?? null,
        vectorsOf: (ids: string[]) => pictureSearch?.lookAlikeInputs(ids).vectors ?? new Map(),
        fingerprints: async (ids: string[]) => {
          const paths = pictureSearch?.lookAlikeInputs(ids).paths() ?? new Map<string, string>()
          const out = new Map<string, bigint>()
          for (const id of ids.slice(0, 80)) {
            const p = paths.get(id)
            const h = p ? await cachedDHash(p) : null
            if (h !== null) out.set(id, h)
          }
          return out
        }
      } as never)) as unknown as C[]
    } catch {
      return clusters // grouping is a nicety: never lose results to it
    }
  }

  appHandle('archive:search', async (_e, query: string, filters: SearchFilters) => {
    const from = filters?.from ?? 'all'
    const kind = filters?.kind ?? 'all'
    const plan = planSources(filters?.type ?? 'slides', from, kind)
    const rows = await collectResults(query ?? '', filters, plan)
    return groupByLook(rows.filter((c) => matchesFromKind(rep(c), from, kind)), filters)
  })

  // Search with the Match switch (Words / Meaning / Both): word hits, picture hits, two bands.
  // Picture hits are resolved to the same wire rows and pass the same Library/Owner/Date/Category/
  // Presentation/From/Kind filters as word hits. Words mode never runs a picture query.
  appHandle('archive:search-matched', async (_e, query: string, filters: SearchFilters, mode: MatchMode) => {
    const from = filters?.from ?? 'all'
    const kind = filters?.kind ?? 'all'
    const resolve = (ids: string[]): Promise<Map<string, MatchCluster>> => resolvePictureIds(ids, filters, query)
    const result = await matchedSearch(
      {
        words: async (q) => {
          const plan = planSources(filters?.type ?? 'slides', from, kind)
          const rows = await collectResults(q ?? '', filters, plan)
          return (await groupByLook(rows.filter((c) => matchesFromKind(rep(c), from, kind)), filters)) as unknown as MatchCluster[]
        },
        modelReady: () => pictureSearch?.status().model === 'ready',
        pictureQuery: (text, opts) => pictureSearch!.pictureQuery({ text }, opts),
        resolve
      },
      query ?? '',
      filters ?? {},
      mode === 'words' || mode === 'meaning' ? mode : 'both'
    )
    return { ...result, related: await groupByLook(result.related, filters) }
  })

  // More like this (inspector): the six most similar items from other presentations and the well, by
  // stored vectors (no model run, but the model must be downloaded). Any Library, Owner and date.
  appHandle('archive:more-like-this', async (_e, row: { kind: string; deck: string; slideOrder: number | null; reference: string }) => {
    const open = { library: 'all', owner: 'all', era: 'all', category: '', deck: '', role: 'all', from: 'all', kind: 'all' } as unknown as SearchFilters
    return runMoreLikeThis<MatchCluster['representative']>(
      {
        modelReady: () => pictureSearch?.status().model === 'ready',
        query: (imageId, opts) => pictureSearch!.pictureQuery({ imageId }, opts),
        resolve: async (ids) => {
          const clusters = await resolvePictureIds(ids, open, '')
          return new Map([...clusters].map(([id, c]) => [id, c.representative]))
        }
      },
      row as never
    )
  })

  // Counts for the From chips: the current query over every store, Kind applied, From ignored.
  appHandle('archive:from-counts', async (_e, query: string, filters: SearchFilters): Promise<FromCounts> => {
    const kind = filters?.kind ?? 'all'
    const rows = await collectResults(query ?? '', filters, { slides: true, archiveImages: true, well: true })
    return countFrom(rows.map(rep), kind)
  })

  // Distinct deck categories (with counts) for the Category filter dropdown.
  appHandle('archive:categories', () => {
    if (!archiveAvailable()) return []
    try {
      return categoryList(loadDeckMeta(archiveRoot(), cacheDir()))
    } catch {
      return []
    }
  })

  // All decks (id, title, date) newest-first, for the Deck filter picker.
  appHandle('archive:decks', () => {
    if (!archiveAvailable()) return []
    try {
      const idx = loadDeckMeta(archiveRoot(), cacheDir())
      return Object.entries(idx)
        .map(([id, m]) => ({ id, title: m.title || id, date: m.date }))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    } catch {
      return []
    }
  })

  // Deck MODE: one card per presentation (title-slide cover), filtered like the slide search.
  appHandle('archive:list-decks', async (_e, filters: SearchFilters) => {
    const lib = filters?.library ?? 'mine'
    const out: Array<Record<string, unknown>> = []
    const add = async (root: string, library: 'mine' | 'others'): Promise<void> => {
      const f = library === 'others' ? { ...filters, owner: 'all' as const } : filters
      const decks = await listDecks(root, cacheDir(), f)
      for (const { coverAbsPath, ...d } of decks) out.push({ ...d, coverThumbUrl: swThumb(coverAbsPath), library })
    }
    if (lib !== 'others' && archiveAvailable()) {
      try { await add(archiveRoot(), 'mine') } catch { /* mine decks failed */ }
    }
    if (lib !== 'mine' && othersArchiveAvailable()) {
      try { await add(othersArchiveRootResolved(), 'others') } catch { /* others decks failed */ }
    }
    return out
  })
  // Full metadata for one deck (for the sidebar). Resolves to whichever store holds the deck.
  appHandle('archive:deck-detail', (_e, pid: string) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return null
    try {
      const root = rootForDeck(pid)
      const d = deckDetail(root, cacheDir(), pid)
      if (!d) return null
      const library = root === othersArchiveRootResolved() && root !== archiveRoot() ? 'others' : 'mine'
      return { ...d, library }
    } catch {
      return null
    }
  })

  // Stats bundle (timeline of "my" PowerPoint history) for the Stats view.
  appHandle('archive:stats', async () => {
    if (!archiveAvailable()) return null
    try {
      return await archiveStats(archiveRoot(), cacheDir())
    } catch {
      return null
    }
  })

  // The structured content (presentation.json node) of one slide — for "Copy structure".
  appHandle('archive:slide-structure', (_e, deck: string, slideOrder: number | null) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return null
    try {
      return slideStructure(rootForDeck(deck), deck, slideOrder)
    } catch {
      return null
    }
  })

  // The embedded image assets on one slide → renderable swarchive:// thumbnails (for the inspector).
  appHandle('archive:slide-images', (_e, deck: string, slideOrder: number | null) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return []
    try {
      return slideImages(rootForDeck(deck), deck, slideOrder).map((im) => ({ thumbUrl: swThumb(im.absPath) }))
    } catch {
      return []
    }
  })

  // All slides of one presentation, in order — for "See in context". Tagged with the store it came from.
  appHandle('archive:deck-slides', async (_e, deck: string) => {
    if (!archiveAvailable() && !othersArchiveAvailable()) return []
    try {
      const root = rootForDeck(deck)
      const library = root === othersArchiveRootResolved() && root !== archiveRoot() ? 'others' : 'mine'
      return (await deckSlides(root, cacheDir(), deck)).map((h) => toWire(h, library))
    } catch {
      return []
    }
  })

  // Copy an image FILE (WebP) to the clipboard — TalkWeaver's paste reads an image/webp file item
  // and keeps it as-is (no PNG round-trip). Resolves the file from its thumbnail URL, so the same
  // path works for archive renders, well images, and vault images. macOS file pasteboard via osascript.
  const copyFileToClipboard = (abs: string): Promise<boolean> =>
    new Promise((resolve) =>
      execFile('osascript', ['-e', `set the clipboard to POSIX file ${JSON.stringify(abs)}`], (err) => resolve(!err))
    )
  appHandle('clipboard:copy-image', async (_e, thumbUrl: string) => {
    const abs = resolveSwUrlReal(thumbUrl)
    return abs ? copyFileToClipboard(abs) : false
  })
  // Copy as a PNG raster bitmap (for Keynote / Slack / web that want a pasted image, not a file).
  appHandle('clipboard:copy-image-png', async (_e, thumbUrl: string) => {
    const abs = resolveSwUrlReal(thumbUrl)
    if (!abs) return false
    try {
      const img = abs.toLowerCase().endsWith('.webp')
        ? nativeImage.createFromBuffer(await sharp(abs).png().toBuffer())
        : nativeImage.createFromPath(abs)
      if (img.isEmpty()) return false
      clipboard.writeImage(img)
      return true
    } catch {
      return false
    }
  })

  // Reveal an image in Finder ("open containing deck/folder").
  appHandle('shell:reveal', (_e, thumbUrl: string) => {
    const abs = resolveSwUrlReal(thumbUrl) // a link inside a root that leads outside every root is not revealed
    if (!abs) return false
    shell.showItemInFolder(abs)
    return true
  })

  // TalkWeaver registers no URL scheme and no document type, so the nearest thing to "open the talk"
  // is showing its outline file in Finder. The path is vault-relative and must stay inside the vault.
  appHandle('talks:reveal', (_e, relPath: string) => {
    const vr = detectVaultRoot()
    if (!vr || typeof relPath !== 'string') return false
    const abs = talkAbsPath(vr, relPath)
    if (!abs) return false
    shell.showItemInFolder(abs)
    return true
  })
}

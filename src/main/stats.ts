/**
 * Pure aggregation for the Stats view — a timeline of Dominik's PowerPoint history.
 * Ported verbatim (computation only) from raycast-slide-search/src/lib/stats.ts;
 * SlideWell renders the result natively rather than as markdown. READ-ONLY, no I/O.
 */
export interface StatsDeck {
  id: string
  title: string
  date: string | null
  category: string
  slideCount: number
  created?: string | null
  modified?: string | null
  filename?: string | null
}

export interface YearBucket {
  year: number
  decks: number
  slides: number
  avgSlides: number
}
export interface MonthOfYearBucket {
  month: number
  label: string
  decks: number
  slides: number
}
export interface BusyMonth {
  key: string
  label: string
  decks: number
  slides: number
}
export interface SizeBucket {
  label: string
  min: number
  max: number | null
  decks: number
}
export interface CategoryStat {
  category: string
  decks: number
  slides: number
}
export interface BiggestDeck {
  title: string
  slides: number
  year: number | null
}
export interface Superlatives {
  mostProlificYear: YearBucket | null
  mostSlidesYear: YearBucket | null
  busiestMonth: BusyMonth | null
  biggestDeck: BiggestDeck | null
  firstYearAvg: { year: number; avg: number } | null
  lastYearAvg: { year: number; avg: number } | null
}
export interface TalkCluster {
  key: string
  title: string
  deckIds: string[]
  deckCount: number
  earliestDate: string | null
  maxSlides: number
  category: string
}
export interface DateConfidence {
  confidentDecks: StatsDeck[]
  uncertainDecks: StatsDeck[]
  byYearConfident: YearBucket[]
  uncertainSlides: number
}
export interface Stats {
  totalDecks: number
  datedDecks: number
  undatedDecks: number
  totalSlides: number
  totalImages: number
  firstYear: number | null
  lastYear: number | null
  yearsActive: number
  avgSlidesPerDeck: number
  medianSlidesPerDeck: number
  byYear: YearBucket[]
  byMonthOfYear: MonthOfYearBucket[]
  busiestMonths: BusyMonth[]
  sizeBuckets: SizeBucket[]
  topCategoriesByDecks: CategoryStat[]
  topCategoriesBySlides: CategoryStat[]
  superlatives: Superlatives
  distinctTalks: number
  duplicateClusters: TalkCluster[]
  byYearTalks: YearBucket[]
  dateConfidence: DateConfidence
  masterDeckCount: number
  masterSlides: number
  masterTitles: string[]
  lifetimeSlidesShown: number
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function yearOf(date: string | null): number | null {
  if (!date) return null
  const m = /^(\d{4})/.exec(date.trim())
  if (!m) return null
  const y = parseInt(m[1], 10)
  return Number.isFinite(y) ? y : null
}
function monthOf(date: string | null): number | null {
  if (!date) return null
  const m = /^\d{4}-(\d{2})/.exec(date.trim())
  if (!m) return null
  const mo = parseInt(m[1], 10)
  return mo >= 1 && mo <= 12 ? mo : null
}
function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
function aggregateByYear(decks: StatsDeck[]): YearBucket[] {
  const map = new Map<number, { decks: number; slides: number }>()
  for (const d of decks) {
    const y = yearOf(d.date)
    if (y === null) continue
    const b = map.get(y) ?? { decks: 0, slides: 0 }
    b.decks += 1
    b.slides += d.slideCount
    map.set(y, b)
  }
  return [...map.entries()]
    .map(([year, b]) => ({ year, decks: b.decks, slides: b.slides, avgSlides: b.decks ? round1(b.slides / b.decks) : 0 }))
    .sort((a, b) => a.year - b.year)
}
function aggregateByMonthOfYear(decks: StatsDeck[]): MonthOfYearBucket[] {
  const buckets: MonthOfYearBucket[] = MONTH_LABELS.map((label, i) => ({ month: i + 1, label, decks: 0, slides: 0 }))
  for (const d of decks) {
    const mo = monthOf(d.date)
    if (mo === null) continue
    buckets[mo - 1].decks += 1
    buckets[mo - 1].slides += d.slideCount
  }
  return buckets
}
function busiestMonths(decks: StatsDeck[], limit = 8): BusyMonth[] {
  const map = new Map<string, { decks: number; slides: number }>()
  for (const d of decks) {
    const y = yearOf(d.date)
    const mo = monthOf(d.date)
    if (y === null || mo === null) continue
    const key = `${y}-${String(mo).padStart(2, '0')}`
    const b = map.get(key) ?? { decks: 0, slides: 0 }
    b.decks += 1
    b.slides += d.slideCount
    map.set(key, b)
  }
  return [...map.entries()]
    .map(([key, b]) => {
      const [yy, mm] = key.split('-')
      return { key, label: `${MONTH_LABELS[parseInt(mm, 10) - 1]} ${yy}`, decks: b.decks, slides: b.slides }
    })
    .sort((a, b) => b.decks - a.decks || b.slides - a.slides || a.key.localeCompare(b.key))
    .slice(0, limit)
}
const SIZE_DEFS: Array<{ label: string; min: number; max: number | null }> = [
  { label: '1–5', min: 1, max: 5 },
  { label: '6–15', min: 6, max: 15 },
  { label: '16–30', min: 16, max: 30 },
  { label: '31–60', min: 31, max: 60 },
  { label: '60+', min: 61, max: null }
]
function sizeDistribution(decks: StatsDeck[]): SizeBucket[] {
  const out: SizeBucket[] = SIZE_DEFS.map((d) => ({ ...d, decks: 0 }))
  for (const deck of decks) {
    const n = deck.slideCount
    if (n < 1) continue
    for (const b of out) {
      if (n >= b.min && (b.max === null || n <= b.max)) {
        b.decks += 1
        break
      }
    }
  }
  return out
}
function aggregateByCategory(decks: StatsDeck[]): CategoryStat[] {
  const map = new Map<string, { decks: number; slides: number }>()
  for (const d of decks) {
    const cat = d.category.trim() || '(uncategorised)'
    const b = map.get(cat) ?? { decks: 0, slides: 0 }
    b.decks += 1
    b.slides += d.slideCount
    map.set(cat, b)
  }
  return [...map.entries()].map(([category, b]) => ({ category, decks: b.decks, slides: b.slides }))
}

export function isMasterText(text: string): boolean {
  const t = ' ' + text.toLowerCase().replace(/[’‘`]/g, "'") + ' '
  if (/\bmaster's\b/.test(t)) return false
  if (/\bmaster of\b|\bmaster in\b|\bmaster degree\b|\bmasters\b/.test(t)) return false
  if (/\bmaster\s+(list|slides|slide|deck|decks|library|template|templates|file|collection)\b/.test(t)) return true
  if (/\b(slide|slides|library|template|templates|deck)\s+master\b/.test(t)) return true
  return false
}
function isMasterDeck(deck: StatsDeck): boolean {
  return isMasterText(deck.title) || isMasterText(deck.filename ?? '')
}
function partitionMasterDecks(decks: StatsDeck[]): { presented: StatsDeck[]; masters: StatsDeck[] } {
  const presented: StatsDeck[] = []
  const masters: StatsDeck[] = []
  for (const d of decks) (isMasterDeck(d) ? masters : presented).push(d)
  return { presented, masters }
}

export const SLIDE_TOLERANCE = 2
const PLACEHOLDER_TITLES = new Set([
  'powerpoint presentation',
  'presentation',
  'title subtitle',
  'title',
  'untitled',
  'untitled presentation',
  'slide 1',
  'slide1'
])
function isPlaceholderTitle(normalised: string): boolean {
  if (!normalised) return true
  if (PLACEHOLDER_TITLES.has(normalised)) return true
  if (/^slide\s*\d+$/.test(normalised)) return true
  return false
}
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a <= b ? a : b
}
function clusterTalks(decks: StatsDeck[], tolerance = SLIDE_TOLERANCE): TalkCluster[] {
  const clusters: TalkCluster[] = []
  const byTitle = new Map<string, StatsDeck[]>()
  for (const d of decks) {
    const key = normaliseTitle(d.title)
    if (isPlaceholderTitle(key)) {
      clusters.push({
        key: `__placeholder__:${d.id}`,
        title: d.title,
        deckIds: [d.id],
        deckCount: 1,
        earliestDate: d.date,
        maxSlides: d.slideCount,
        category: d.category
      })
      continue
    }
    const arr = byTitle.get(key)
    if (arr) arr.push(d)
    else byTitle.set(key, [d])
  }
  for (const [key, members] of byTitle) {
    const sorted = [...members].sort((a, b) => a.slideCount - b.slideCount || a.id.localeCompare(b.id))
    let group: StatsDeck[] = []
    let anchor = -Infinity
    const flush = (): void => {
      if (group.length === 0) return
      const rep = [...group].sort((a, b) => {
        const da = a.date ?? '￿'
        const db = b.date ?? '￿'
        return da.localeCompare(db) || a.id.localeCompare(b.id)
      })[0]
      let earliest: string | null = null
      for (const m of group) earliest = earlier(earliest, m.date)
      clusters.push({
        key,
        title: rep.title,
        deckIds: group.map((m) => m.id),
        deckCount: group.length,
        earliestDate: earliest,
        maxSlides: Math.max(...group.map((m) => m.slideCount)),
        category: rep.category
      })
      group = []
    }
    for (const d of sorted) {
      if (group.length === 0 || d.slideCount - anchor <= tolerance) {
        group.push(d)
        if (group.length === 1) anchor = d.slideCount
      } else {
        flush()
        group.push(d)
        anchor = d.slideCount
      }
    }
    flush()
  }
  return clusters
}
function aggregateByYearTalks(clusters: TalkCluster[]): YearBucket[] {
  return aggregateByYear(
    clusters.map((c) => ({ id: c.key, title: c.title, date: c.earliestDate, category: c.category, slideCount: c.maxSlides }))
  )
}

function isSameMonthResave(d: StatsDeck): boolean {
  const c = (d.created ?? d.date ?? '').slice(0, 7)
  const m = (d.modified ?? '').slice(0, 7)
  return c.length === 7 && c === m
}
const BULK_RESAVE_MONTH_THRESHOLD = 10
function classifyDateConfidence(decks: StatsDeck[], monthThreshold = BULK_RESAVE_MONTH_THRESHOLD): DateConfidence {
  const monthResaveCount = new Map<string, number>()
  for (const d of decks) {
    if (!isSameMonthResave(d)) continue
    const ym = (d.created ?? d.date ?? '').slice(0, 7)
    if (ym.length === 7) monthResaveCount.set(ym, (monthResaveCount.get(ym) ?? 0) + 1)
  }
  const confidentDecks: StatsDeck[] = []
  const uncertainDecks: StatsDeck[] = []
  for (const d of decks) {
    const ym = (d.created ?? d.date ?? '').slice(0, 7)
    const inBatch = isSameMonthResave(d) && (monthResaveCount.get(ym) ?? 0) >= monthThreshold
    if (inBatch) uncertainDecks.push(d)
    else confidentDecks.push(d)
  }
  const uncertainSlides = uncertainDecks.reduce((s, d) => s + d.slideCount, 0)
  return { confidentDecks, uncertainDecks, byYearConfident: aggregateByYear(confidentDecks), uncertainSlides }
}

function masterLabel(d: StatsDeck): string {
  const title = d.title.trim()
  if (!isPlaceholderTitle(normaliseTitle(title))) return title
  const file = (d.filename ?? '').trim()
  return file ? file.replace(/\.pptx$/i, '') : title || d.id
}

export function computeStats(decks: StatsDeck[], totalImages = 0): Stats {
  const { presented, masters } = partitionMasterDecks(decks)
  const masterSlides = masters.reduce((s, d) => s + d.slideCount, 0)
  const byYear = aggregateByYear(presented)
  const dated = presented.filter((d) => yearOf(d.date) !== null)
  const counts = presented.map((d) => d.slideCount).filter((n) => n > 0)
  const totalSlides = presented.reduce((s, d) => s + d.slideCount, 0)
  const byCatDecks = aggregateByCategory(presented).sort(
    (a, b) => b.decks - a.decks || b.slides - a.slides || a.category.localeCompare(b.category)
  )
  const byCatSlides = aggregateByCategory(presented).sort(
    (a, b) => b.slides - a.slides || b.decks - a.decks || a.category.localeCompare(b.category)
  )
  const months = busiestMonths(presented, 8)
  let biggest: BiggestDeck | null = null
  for (const d of presented) {
    if (!biggest || d.slideCount > biggest.slides) biggest = { title: d.title, slides: d.slideCount, year: yearOf(d.date) }
  }
  const mostProlificYear = byYear.reduce<YearBucket | null>((best, y) => (!best || y.decks > best.decks ? y : best), null)
  const mostSlidesYear = byYear.reduce<YearBucket | null>((best, y) => (!best || y.slides > best.slides ? y : best), null)
  const firstYear = byYear.length ? byYear[0].year : null
  const lastYear = byYear.length ? byYear[byYear.length - 1].year : null
  const clusters = clusterTalks(presented)
  const duplicateClusters = clusters
    .filter((c) => c.deckCount >= 2)
    .sort((a, b) => b.deckCount - a.deckCount || b.maxSlides - a.maxSlides || a.title.localeCompare(b.title))
  return {
    totalDecks: decks.length,
    datedDecks: dated.length,
    undatedDecks: presented.length - dated.length,
    totalSlides,
    totalImages,
    firstYear,
    lastYear,
    yearsActive: firstYear !== null && lastYear !== null ? lastYear - firstYear + 1 : 0,
    avgSlidesPerDeck: counts.length ? round1(totalSlides / presented.length) : 0,
    medianSlidesPerDeck: median(counts),
    byYear,
    byMonthOfYear: aggregateByMonthOfYear(presented),
    busiestMonths: months,
    sizeBuckets: sizeDistribution(presented),
    topCategoriesByDecks: byCatDecks,
    topCategoriesBySlides: byCatSlides,
    superlatives: {
      mostProlificYear,
      mostSlidesYear,
      busiestMonth: months[0] ?? null,
      biggestDeck: biggest && biggest.slides > 0 ? biggest : null,
      firstYearAvg: byYear.length ? { year: byYear[0].year, avg: byYear[0].avgSlides } : null,
      lastYearAvg: byYear.length ? { year: byYear[byYear.length - 1].year, avg: byYear[byYear.length - 1].avgSlides } : null
    },
    distinctTalks: clusters.length,
    duplicateClusters,
    byYearTalks: aggregateByYearTalks(clusters),
    dateConfidence: classifyDateConfidence(presented),
    masterDeckCount: masters.length,
    masterSlides,
    masterTitles: masters.map((m) => masterLabel(m)),
    lifetimeSlidesShown: totalSlides
  }
}

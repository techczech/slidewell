/**
 * Pure From / Kind search filters (no I/O). From says where a result came from; Kind narrows
 * images by what they show. Replaces the old Source (All/Archive/Well) switch:
 * Archive = old-PowerPoint images + old slides; Well = screenshots + added images.
 */
export type FromFilter = 'all' | 'screenshots' | 'old-images' | 'old-slides' | 'talks'
export type KindFilter = 'all' | 'no-text' | 'embedded'

/** An image whose OCR text is shorter than this (trimmed) counts as "without text". */
export const NO_TEXT_THRESHOLD = 8

/** The fields of a search-result wire row that the filters read (a subset of SlideResult). */
export interface FilterableResult {
  kind: string
  text: string
  /** How many talks use this picture (TalkWeaver vault images only; absent = none known). */
  usedInTalks?: number
}

export type FromBucket = Exclude<FromFilter, 'all'>
export const FROM_BUCKETS: FromBucket[] = ['screenshots', 'old-images', 'old-slides', 'talks']

/** Which From bucket a result belongs to. Well images (screenshots and added images) are 'screenshots'. */
export function fromOf(r: FilterableResult): FromBucket {
  if (r.kind === 'well-image') return 'screenshots'
  if (r.kind === 'archive-image') return 'old-images'
  return 'old-slides'
}

export function isPicture(r: FilterableResult): boolean {
  return r.kind === 'well-image' || r.kind === 'archive-image' || r.kind === 'ocr-image'
}

export function hasLittleText(r: FilterableResult): boolean {
  return (r.text || '').trim().length < NO_TEXT_THRESHOLD
}

export function matchesKind(r: FilterableResult, kind: KindFilter): boolean {
  if (kind === 'all') return true
  if (kind === 'embedded') return r.kind === 'archive-image'
  return isPicture(r) && hasLittleText(r)
}

/** 'Used in talks' cuts across the other buckets: any result a talk is known to use. */
export function isUsedInTalks(r: FilterableResult): boolean {
  return (r.usedInTalks ?? 0) > 0
}

export function matchesFrom(r: FilterableResult, from: FromFilter): boolean {
  if (from === 'talks') return isUsedInTalks(r)
  return from === 'all' || fromOf(r) === from
}

/** Both filters as one predicate. */
export function matchesFromKind(r: FilterableResult, from: FromFilter, kind: KindFilter): boolean {
  return matchesFrom(r, from) && matchesKind(r, kind)
}

export type FromCounts = Record<FromFilter, number>

/** Counts per From chip for a result set, with the Kind filter applied. A result used in talks is counted under its bucket and under 'talks'. */
export function countFrom(results: FilterableResult[], kind: KindFilter): FromCounts {
  const counts: FromCounts = { all: 0, screenshots: 0, 'old-images': 0, 'old-slides': 0, talks: 0 }
  for (const r of results) {
    if (!matchesKind(r, kind)) continue
    counts[fromOf(r)]++
    if (isUsedInTalks(r)) counts.talks++
    counts.all++
  }
  return counts
}

export interface SourcePlan {
  slides: boolean
  archiveImages: boolean
  well: boolean
}

/**
 * Which stores a search needs to read. A From chip decides on its own; with From = All the Type
 * switch decides (Slides = old slides; Images = old-PowerPoint images + well). A Kind other than
 * All only concerns pictures, so slides drop out.
 */
export function planSources(type: 'slides' | 'images' | 'decks', from: FromFilter, kind: KindFilter): SourcePlan {
  let plan: SourcePlan
  if (from === 'old-slides') plan = { slides: true, archiveImages: false, well: false }
  else if (from === 'old-images') plan = { slides: false, archiveImages: true, well: false }
  else if (from === 'screenshots') plan = { slides: false, archiveImages: false, well: true }
  else if (from === 'talks') plan = { slides: false, archiveImages: false, well: true }
  else if (type === 'slides') plan = { slides: true, archiveImages: false, well: false }
  else plan = { slides: false, archiveImages: true, well: true }
  if (kind !== 'all') {
    if (from === 'all' && type === 'slides') plan = { slides: false, archiveImages: true, well: true }
    plan.slides = false
  }
  if (kind === 'embedded') plan.well = false
  return plan
}

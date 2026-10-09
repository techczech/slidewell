/**
 * What should have a vector right now: the slide renders of the configured archive plus the well's
 * images. Every call returns its own `{ root, items }`, so concurrent callers (the Settings estimate,
 * an indexing pass) never see each other's results. The archive scan is cached per canonical root,
 * written only if that root is still the configured one when the scan finishes, and read only by a
 * caller asking for that same root.
 */
import { canonicalRoot, type IndexItem } from './vector-store'

export type Enumeration = { root: string | null; items: IndexItem[] }

export type EnumeratorDeps = {
  /** The configured archive folder, or null when unavailable. */
  archiveRoot: () => string | null
  /** Bind the store to this canonical root (drops slide rows of another archive). */
  bind: (canonRoot: string) => void
  /** Slide renders under a canonical root, each tagged with that root. */
  archive: (canonRoot: string) => Promise<IndexItem[]>
  /** Well images (empty when well indexing is off). */
  well: () => Promise<IndexItem[]>
}

export class ImageEnumerator {
  private cache: { root: string; items: IndexItem[] } | null = null

  constructor(private deps: EnumeratorDeps) {}

  /** The configured archive's identity now (null = unavailable). */
  currentRoot(): string | null {
    const r = this.deps.archiveRoot()
    return r ? canonicalRoot(r) : null
  }

  async enumerate(): Promise<Enumeration> {
    const root = this.currentRoot()
    if (root) this.deps.bind(root)
    const archive = root ? await this.archiveFor(root) : []
    const well = await this.deps.well()
    return { root, items: [...well, ...archive] }
  }

  private async archiveFor(root: string): Promise<IndexItem[]> {
    if (this.cache && this.cache.root === root) return this.cache.items
    const items = await this.deps.archive(root)
    if (this.currentRoot() === root) this.cache = { root, items } // never cache a root that is no longer configured
    return items
  }

  /** The archive's contents changed (import) or it was repointed. */
  invalidate(): void {
    this.cache = null
  }
}

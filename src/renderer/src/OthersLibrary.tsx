import type { SearchFilters } from '../../preload'

interface LibraryFilterProps {
  filters: SearchFilters
  patch: (change: Partial<SearchFilters>) => void
}

export function LibraryFilter({ filters, patch }: LibraryFilterProps): JSX.Element {
  return (
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
  )
}

export function DeleteOthersMatchingButton({ deleteOthersMatching }: { deleteOthersMatching: () => Promise<void> }): JSX.Element {
  return (
          <button
            className="toggle danger"
            onClick={() => void deleteOthersMatching()}
            title="Delete the Others' Library presentations matching the current filter/search (no filter = the whole library). Your own archive is never touched."
          >
            🗑 Delete matching…
          </button>
  )
}

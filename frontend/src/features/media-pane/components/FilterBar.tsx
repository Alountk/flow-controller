import type { MediaFilter, MediaKind } from '../types.ts'

interface FilterBarProps {
  kind: MediaKind
  filter: MediaFilter
  onFilterChange?: (filter: MediaFilter) => void
  /** In the sections the sub-view tabs already are the filter, so the pane
   *  must NOT draw a second set of filter controls there. */
  showFilterButtons: boolean
  wantedTotal: number
  allTotal: number
  /** Hash-backed search text — the pane owns the hash state, this draws it. */
  query: string
  onQueryChange: (value: string) => void
}

/** The pane's action bar: the Faltantes/Todas buttons (when the caller wants
 *  them) and the debounced search input. Labels speak for the pane's own
 *  kind/filter — nothing else in the bar needs them. */
export function FilterBar({
  kind,
  filter,
  onFilterChange,
  showFilterButtons,
  wantedTotal,
  allTotal,
  query,
  onQueryChange,
}: FilterBarProps) {
  const isMovies = kind === 'movies'
  const searchLabel = isMovies ? 'Filtrar películas' : 'Filtrar series'
  const searchPlaceholder =
    filter === 'missing' ? 'Filtrar faltantes...' : isMovies ? 'Filtrar películas...' : 'Filtrar series...'
  return (
    <div className="wanted-actions">
      <div className="wanted-filter">
        {showFilterButtons && (
          <button
            className={`wanted-filter-btn ${filter === 'missing' ? 'active' : ''}`}
            onClick={() => onFilterChange?.('missing')}
          >
            Faltantes ({wantedTotal})
          </button>
        )}
        {showFilterButtons && (
          <button
            className={`wanted-filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => onFilterChange?.('all')}
          >
            Todas ({allTotal || '...'})
          </button>
        )}
        <input
          type="search"
          className="wanted-search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label={searchLabel}
        />
      </div>
    </div>
  )
}

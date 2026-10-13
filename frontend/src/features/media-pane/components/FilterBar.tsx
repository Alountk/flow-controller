import type { MediaFilter, MediaKind } from '../types.ts'
import { BulkSearchFlow } from './BulkSearchFlow.tsx'

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
 *  them), the debounced search input, and — over the missing list only — the
 *  bulk-search trigger with its C-09 confirmation flow. The totals live in
 *  the design's counter row (stitch-peliculas-03), stated once: the buttons
 *  keep switching views but no longer repeat the numbers. */
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
            Faltantes
          </button>
        )}
        {showFilterButtons && (
          <button
            className={`wanted-filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => onFilterChange?.('all')}
          >
            Todas
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
      {/* Design-03 row: each total stated exactly once — the buttons above
          only switch views. The mass search rides the right side of the
          same row, over the list it acts on (the "Todas" catalogue shows
          no count of its own to trigger against). */}
      <div className="wanted-counter-row">
        <div className="wanted-counter">
          <strong className="wanted-counter-total">{allTotal}</strong>{' '}
          {isMovies ? 'películas' : 'series'} catalogadas •{' '}
          <strong className="wanted-counter-pending">{wantedTotal}</strong> pendientes
        </div>
        {filter === 'missing' && (
          <BulkSearchFlow kind={kind} count={wantedTotal} filtered={Boolean(query.trim())} />
        )}
      </div>
    </div>
  )
}

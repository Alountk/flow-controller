import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ReleaseSearchModal, type ReleaseSearchItem } from '../release-search/ReleaseSearchModal.tsx'
import type { WantedMovie } from '../../shared/types.ts'
import { useMediaSearch } from './hooks/useMediaSearch.ts'
import { useMediaQueries } from './hooks/useMediaQueries.ts'
import { useLoadMoreObserver } from './hooks/useLoadMoreObserver.ts'
import { FilterBar } from './components/FilterBar.tsx'
import { ScanModal, type ScanItem } from './components/ScanModal.tsx'
import { renderMissingMovies, renderMissingEpisodes } from './components/MissingListings.tsx'
import { renderCatalogMovies, renderCatalogSeries } from './components/CatalogListings.tsx'
import type {
  MediaKind,
  MediaFilter,
  MediaTotals,
  MediaDetail,
  MediaSelection,
  MediaRowVariant,
  RowWiring,
  ListingViewProps,
  ScanSeriesInput,
} from './types.ts'
import './MissingContent.css'

/**
 * One media kind's listing, extracted from the Faltantes page (PR 2 of F-08).
 *
 * The pane owns everything that makes the listing work — the filter bar, the
 * debounced search, the infinite queries with their auto-load, the scan and
 * release-search modals and the error banner — for a SINGLE media kind.
 * The caller drives it: MissingContent passes its own hash-backed filter and
 * asks for the Faltantes/Todas buttons, while the Películas/Series sections
 * derive the filter from their sub-view tabs and suppress the buttons, because
 * THERE the sub-view tabs already are the filter.
 *
 * The caller must render it inside an element carrying the `wanted` class:
 * the row action buttons are styled by `.wanted .search-item` in
 * MissingContent.css (which this file imports).
 *
 * Two row shapes (PR 5 of F-08): 'page' is the markup Faltantes has always
 * rendered, 'section' is the chosen prototype's dense row — mini-poster,
 * status pill, quality chip, path — scoped to the master column of the
 * Películas/Series sections by the `variant` prop, never by a global restyle.
 *
 * Implementation lives in sibling modules — hooks/ for the search text, the
 * query wiring and the sentinel observer; components/ for the bar, the row,
 * the two modals and the four listing branches; rowData.ts for the detail/
 * release payloads — this file is the public seam and the composition of
 * them. The public types below are re-exported from ./types.ts so callers
 * keep importing from this entry.
 */

export type {
  MediaKind,
  MediaFilter,
  MediaTotals,
  MediaDetail,
  MediaSelection,
  MediaRowVariant,
} from './types.ts'

interface MediaPaneProps {
  kind: MediaKind
  /** Controlled by the caller: 'wanted' hash keys in Faltantes, the active
   *  sub-view tab in the sections. */
  filter: MediaFilter
  onFilterChange?: (filter: MediaFilter) => void
  /** In the sections the sub-view tabs already are the filter, so the pane
   *  must NOT draw a second set of filter controls there. */
  showFilterButtons?: boolean
  /** Hash namespace for the search text ('wanted' / 'peliculas' / 'series'),
   *  so a search typed on one surface never leaks into another. */
  namespace: string
  /** Controlled selection: `null` when the panel shows nothing. */
  selectedId?: number | null
  onSelect?: (selection: MediaSelection) => void
  /** Reports the query totals so a caller can label its own tabs. */
  onTotalsChange?: (totals: MediaTotals) => void
  /** 'section' renders the prototype's dense rows (mini-poster, status chip,
   *  quality chip, path) inside the master column. Default 'page' keeps the
   *  Faltantes cards/rows byte for byte. */
  variant?: MediaRowVariant
}

export function MediaPane({
  kind,
  filter,
  onFilterChange,
  showFilterButtons = false,
  namespace,
  selectedId = null,
  onSelect,
  onTotalsChange,
  variant = 'page',
}: MediaPaneProps) {
  const isMovies = kind === 'movies'
  const isSection = variant === 'section'
  const [scanItem, setScanItem] = useState<ScanItem | null>(null)
  const [releaseSearchItem, setReleaseSearchItem] = useState<ReleaseSearchItem | null>(null)
  const { query, setQuery, debouncedQuery } = useMediaSearch(namespace)
  const {
    wantedMovies,
    catalogMovies,
    wantedEpisodes,
    catalogSeries,
    wantedTotal,
    allTotal,
    activeError,
    serviceName,
    isPending,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useMediaQueries({ kind, filter, debouncedQuery })
  const loadMoreRef = useLoadMoreObserver({ hasNextPage, isFetchingNextPage, fetchNextPage })

  // The caller's tab labels read their counts from here. The setter is the
  // caller's own, so an unchanged object is recognised as "nothing new".
  useEffect(() => {
    onTotalsChange?.({ wanted: wantedTotal, all: allTotal })
  }, [wantedTotal, allTotal, onTotalsChange])

  function handleScanForMovie(movie: WantedMovie) {
    setScanItem({ type: 'movie', id: movie.id, title: movie.title, source: 'radarr' })
  }

  function handleScanForSeries(series: ScanSeriesInput) {
    if (!series.id) return
    setScanItem({
      type: 'series',
      id: series.id,
      title: series.title,
      source: 'sonarr',
      // Carried through so the modal can identify the episode, not just the series.
      season_number: series.season_number,
      episode_number: series.episode_number,
      episode_title: series.episode_title,
      air_date: series.air_date,
    })
  }

  /** Rows only become interactive when the caller asked for a selection, so
   *  the Faltantes page keeps the exact DOM it has today. */
  const selectableClass = onSelect ? ' is-selectable' : ''

  function rowProps(
    id: number,
    makeDetail: () => MediaDetail,
    makeRelease: () => ReleaseSearchItem,
  ): RowWiring {
    if (!onSelect) return {}
    const select = () => onSelect({ id, detail: makeDetail(), release: makeRelease() })
    return {
      tabIndex: 0,
      'aria-current': selectedId === id ? true : undefined,
      onClick: select,
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      },
    }
  }

  /**
   * What the row's search action (🔍) does.
   *
   * In the sections the search lives in the detail panel: the click bubbles
   * to the row, which selects it, and the panel renders its Releases tab for
   * that selection — no modal ever opens per row, which is the whole point of
   * the chosen prototype. Without a panel to drive (the Faltantes page) the
   * overlay opens exactly as it always has.
   */
  function openReleases(item: ReleaseSearchItem) {
    if (isSection && onSelect) return
    setReleaseSearchItem(item)
  }

  /** Everything a listing branch needs beyond its own items and scan target. */
  const view: ListingViewProps = {
    isPending,
    isFetchingNextPage,
    activeError,
    serviceName,
    loadMoreRef,
    rowProps,
    selectableClass,
    isSection,
    openReleases,
  }

  return (
    <>
      <div className="wanted-content">
        <FilterBar
          kind={kind}
          filter={filter}
          onFilterChange={onFilterChange}
          showFilterButtons={showFilterButtons}
          wantedTotal={wantedTotal}
          allTotal={allTotal}
          query={query}
          onQueryChange={setQuery}
        />

        {filter === 'missing' ? (
          isMovies ? (
            renderMissingMovies({ ...view, items: wantedMovies, onScan: handleScanForMovie })
          ) : (
            renderMissingEpisodes({ ...view, items: wantedEpisodes, onScan: handleScanForSeries })
          )
        ) : isMovies ? (
          renderCatalogMovies({ ...view, items: catalogMovies, onScan: handleScanForMovie })
        ) : (
          renderCatalogSeries({ ...view, items: catalogSeries, onScan: handleScanForSeries })
        )}
      </div>

      {scanItem && <ScanModal item={scanItem} onClose={() => setScanItem(null)} />}
      {releaseSearchItem && <ReleaseSearchModal item={releaseSearchItem} onClose={() => setReleaseSearchItem(null)} />}
    </>
  )
}

import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { ReleaseSearchItem } from '../release-search/ReleaseSearchModal.tsx'

/**
 * The media-pane feature's contracts: the public types MediaPane re-exports
 * for its callers, plus the internal seams its own modules share. Everything
 * here is a type — the entry file re-exports the public half so importers
 * keep importing from `MediaPane.tsx`.
 */

/** Movies (Radarr) or episodes/series (Sonarr). */
export type MediaKind = 'movies' | 'episodes'

/** The two lists: the missing queue or the full catalogue. */
export type MediaFilter = 'missing' | 'all'

/** What the caller's tab labels read: the totals of the queries that ran. */
export interface MediaTotals {
  wanted: number
  all: number
}

/**
 * What the master–detail panel is allowed to show about a selected row: only
 * fields the row itself carries. Quality and path are absent on purpose — the
 * listings have no such data, and the panel must not invent any.
 */
export interface MediaDetail {
  title: string
  /** The row's poster, when the row has one. */
  poster?: string
  /** Ordered label/value pairs taken straight from the row. */
  meta: { label: string; value: string }[]
  /** The "descarga pedida" mark, when the row carries one. */
  grab?: string
}

/** A row the caller selected: its identity plus what the panel will show. */
export interface MediaSelection {
  id: number
  detail: MediaDetail
  /** The exact item the overlay modal would open for this row: the section
   *  panel's Releases tab searches it inline (PR 5 of F-08). */
  release: ReleaseSearchItem
}

/** Where the rows live. The Faltantes page keeps the markup it has always
 *  had; the sections render the chosen prototype's dense rows instead. */
export type MediaRowVariant = 'page' | 'section'

/** What `rowProps` puts on a row when the caller selects: pointer, keyboard
 *  and aria-current. `{}` when the caller selects nothing (Faltantes). */
export interface RowWiring {
  tabIndex?: number
  'aria-current'?: boolean
  onClick?: () => void
  onKeyDown?: (e: ReactKeyboardEvent) => void
}

/** The pane's selection wiring, as a function every row of every listing
 *  calls with its own identity and its two panel payloads. */
export type RowPropsFn = (
  id: number,
  makeDetail: () => MediaDetail,
  makeRelease: () => ReleaseSearchItem,
) => RowWiring

/**
 * What the pane hands each listing branch: the active query's view state,
 * the infinite-scroll sentinel ref and the selection/release wiring the rows
 * call. A listing adds its own items and scan target on top of this.
 */
export interface ListingViewProps {
  isPending: boolean
  isFetchingNextPage: boolean
  /** A failed fetch must never read as "nothing missing": the backend now
   *  says WHY it is empty, and that reason has to reach the screen. */
  activeError: string | null
  /** 'Radarr' or 'Sonarr' — named in the error banner. */
  serviceName: string
  /** Sentinel ref for the IntersectionObserver auto-load. */
  loadMoreRef: RefObject<HTMLDivElement | null>
  rowProps: RowPropsFn
  selectableClass: string
  isSection: boolean
  openReleases: (item: ReleaseSearchItem) => void
}

/** The series/episode identity a row hands the pane to open the scan modal:
 *  enough to ask Sonarr for the series AND identify the episode. */
export interface ScanSeriesInput {
  id: number | null
  title: string
  season_number?: number | null
  episode_number?: number | null
  episode_title?: string | null
  air_date?: string | null
}

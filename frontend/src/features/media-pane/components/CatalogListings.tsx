import type { WantedMovie, AllMovie } from '../../../shared/types.ts'
import { formatGrabMark } from '../../../shared/utils/grabMark.ts'
import { formatBytes } from '../../../shared/utils/text.ts'
import { SectionRow, catalogRowStatus } from './SectionRow.tsx'
import { ListingLoading, ListingError, ListingEmpty } from './ListingStates.tsx'
import { catalogMovieDetail, catalogMovieRelease } from '../rowData.ts'
import type { ListingViewProps } from '../types.ts'

/**
 * The "all" branch of the pane — the movie catalogue, as cards. (Series left
 * this file with the S2 tree: see `SeriesTree.tsx`.) Called as plain render
 * functions, not JSX components, on purpose: the branches sit in ONE slot of
 * the pane's tree, so a component boundary would remount the keyed rows (and
 * drop their state) whenever the filter flips. A function call splices the
 * exact same elements into that slot — zero drift from the monolith.
 */

interface CatalogMoviesProps extends ListingViewProps {
  items: AllMovie[]
  /** Same movie shape the missing branch passes to the scan opener. */
  onScan: (movie: WantedMovie) => void
}

export function renderCatalogMovies({
  items,
  onScan,
  isPending,
  isFetchingNextPage,
  activeError,
  serviceName,
  loadMoreRef,
  rowProps,
  selectableClass,
  isSection,
  openReleases,
}: CatalogMoviesProps) {
  if (isPending) {
    return <ListingLoading message="Cargando catálogo de películas..." />
  }
  if (items.length > 0) {
    return (
      <>
        <div className="wanted-grid">
          {items.map((movie) => {
            const grabbed = formatGrabMark(movie.grabbed_at, movie.grabbed_destination)
            const actions = (
              <>
                <button
                  className="action-btn search-item"
                  onClick={() => openReleases(catalogMovieRelease(movie))}
                >
                  🔍 Buscar
                </button>
                <button
                  className="action-btn scan-folder-btn"
                  onClick={() => onScan({ id: movie.id, title: movie.title, year: movie.year, overview: '', remotePoster: movie.remotePoster, has_file: movie.has_file, altTitles: [] })}
                >
                  📁 En carpeta
                </button>
              </>
            )
            // The card's bar reports the FILE state. A video sitting in
            // the folder that Radarr never imported is a STATE, not a
            // failure — the bytes are there — so it wears neither the
            // green "configured" bar nor the red error bar.
            const cardStatus =
              movie.has_file && movie.path_exists
                ? 'status-ok'
                : !movie.has_file && movie.has_unimported_file
                  ? ''
                  : 'status-error'
            if (isSection) {
              return (
                <SectionRow
                  key={movie.id}
                  className={`wanted-card${selectableClass}`}
                  wiring={rowProps(
                    movie.id,
                    () => catalogMovieDetail(movie),
                    () => catalogMovieRelease(movie),
                  )}
                  title={movie.title}
                  year={movie.year}
                  status={catalogRowStatus(
                    movie.has_file,
                    movie.path_exists,
                    movie.has_unimported_file,
                  )}
                  poster={movie.remotePoster || undefined}
                  // "" is unknown, never a guessed class: no chip at all.
                  chip={movie.quality || undefined}
                  monitored={movie.monitored}
                  director={movie.directors?.[0]}
                  // The size is a fact about the FILE: no file (or a 0 the
                  // mapper passed through) renders no size, never "0 B".
                  size={
                    movie.has_file && movie.size_on_disk
                      ? formatBytes(movie.size_on_disk)
                      : undefined
                  }
                  path={movie.path || undefined}
                  grabbed={grabbed}
                  grabbedDestination={movie.grabbed_destination}
                >
                  {actions}
                </SectionRow>
              )
            }
            return (
              <div
                key={movie.id}
                {...rowProps(
                  movie.id,
                  () => catalogMovieDetail(movie),
                  () => catalogMovieRelease(movie),
                )}
                className={`wanted-card ${cardStatus}${grabbed ? ' status-grabbed' : ''}${selectableClass}`}
              >
                {movie.remotePoster && (
                  <img className="wanted-poster" src={movie.remotePoster} alt={movie.title} />
                )}
                <div className="wanted-info">
                  <div className="wanted-title">
                    {movie.title} {movie.year && <span className="wanted-year">({movie.year})</span>}
                  </div>
                  <div className="wanted-status-badge">
                    {movie.has_file && movie.path_exists ? (
                      <span className="badge-ok">✓ Configurada</span>
                    ) : !movie.has_file ? (
                      movie.has_unimported_file ? (
                        // Both statuses here claim bytes on disk, and
                        // only THIS one is witnessed: the backend listed
                        // the folder and SAW a video. Files being there
                        // is not a failure — it is an unimported state —
                        // so this badge stays neutral: never badge-error.
                        <span>Carpetas con vídeo · sin importar</span>
                      ) : (
                        // The weaker claim: Radarr's hasFile=false (not
                        // imported) plus a folder check that found no
                        // video — an unreadable NFS folder reads the
                        // same as an empty one. See `catalogState`.
                        <span className="badge-error">✗ Sin archivo</span>
                      )
                    ) : (
                      <span className="badge-error">✗ Ruta no encontrada</span>
                    )}
                  </div>
                  {/* Todas shows the whole catalogue, so the mark also
                      appears on a title that already arrived: it still
                      answers "did I ask for this?". */}
                  {grabbed && (
                    <div className="wanted-grabbed" title={movie.grabbed_destination ?? undefined}>
                      {grabbed}
                    </div>
                  )}
                  <div className="wanted-card-actions">
                    {actions}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div ref={loadMoreRef} className="wanted-infinite-sentinel">
          {isFetchingNextPage && <div className="wanted-loading-more">Cargando más películas...</div>}
        </div>
      </>
    )
  }
  if (activeError) {
    return <ListingError serviceName={serviceName} error={activeError} />
  }
  return <ListingEmpty message="No hay películas en el catálogo" />
}

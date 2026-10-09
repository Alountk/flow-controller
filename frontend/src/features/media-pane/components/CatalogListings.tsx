import type { WantedMovie, AllMovie, AllSeries } from '../../../shared/types.ts'
import { formatGrabMark } from '../../../shared/utils/grabMark.ts'
import { SectionRow, catalogRowStatus } from './SectionRow.tsx'
import { ListingLoading, ListingError, ListingEmpty } from './ListingStates.tsx'
import { catalogMovieDetail, catalogMovieRelease, catalogSeriesDetail, catalogSeriesRelease } from '../rowData.ts'
import type { ListingViewProps, ScanSeriesInput } from '../types.ts'

/**
 * The "all" branch of the pane — the whole catalogue, as movie cards or
 * series cards. Called as plain render functions, not JSX components, on
 * purpose: the four branches sit in ONE slot of the pane's tree, so a
 * component boundary would remount the keyed rows (and drop their state)
 * whenever the filter flips. A function call splices the exact same
 * elements into that slot — zero drift from the monolith.
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

interface CatalogSeriesProps extends ListingViewProps {
  items: AllSeries[]
  onScan: (series: ScanSeriesInput) => void
}

export function renderCatalogSeries({
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
}: CatalogSeriesProps) {
  if (isPending) {
    return <ListingLoading message="Cargando catálogo de series..." />
  }
  if (items.length > 0) {
    return (
      <>
        <div className="wanted-grid">
          {items.map((series) => {
            const grabbed = formatGrabMark(series.grabbed_at, series.grabbed_destination)
            const actions = (
              <>
                <button
                  className="action-btn search-item"
                  onClick={() => openReleases(catalogSeriesRelease(series))}
                >
                  🔍 Buscar
                </button>
                <button
                  className="action-btn scan-folder-btn"
                  onClick={() => onScan({ id: series.id, title: series.title })}
                >
                  📁 En carpeta
                </button>
              </>
            )
            if (isSection) {
              return (
                <SectionRow
                  key={series.id}
                  className={`wanted-card${selectableClass}`}
                  wiring={rowProps(
                    series.id,
                    () => catalogSeriesDetail(series),
                    () => catalogSeriesRelease(series),
                  )}
                  title={series.title}
                  year={series.year}
                  status={catalogRowStatus(series.has_file, series.path_exists)}
                  poster={series.remotePoster || undefined}
                  // Sonarr's list carries no quality: no chip, never a
                  // guessed one (the Calidad view says so on screen).
                  path={series.path || undefined}
                  grabbed={grabbed}
                  grabbedDestination={series.grabbed_destination}
                  extra={
                    series.episode_count > 0 ? (
                      <span className="sec-row-ep-count">
                        {series.episode_file_count}/{series.episode_count} episodios
                      </span>
                    ) : undefined
                  }
                >
                  {actions}
                </SectionRow>
              )
            }
            return (
              <div
                key={series.id}
                {...rowProps(
                  series.id,
                  () => catalogSeriesDetail(series),
                  () => catalogSeriesRelease(series),
                )}
                className={`wanted-card ${series.has_file && series.path_exists ? 'status-ok' : 'status-error'}${grabbed ? ' status-grabbed' : ''}${selectableClass}`}
              >
                {series.remotePoster && (
                  <img className="wanted-poster" src={series.remotePoster} alt={series.title} />
                )}
                <div className="wanted-info">
                  <div className="wanted-title">
                    {series.title} {series.year && <span className="wanted-year">({series.year})</span>}
                  </div>
                  <div className="wanted-status-badge">
                    {series.has_file && series.path_exists ? (
                      <span className="badge-ok">✓ Configurada</span>
                    ) : !series.has_file ? (
                      <span className="badge-error">✗ Sin archivos</span>
                    ) : (
                      <span className="badge-error">✗ Ruta no encontrada</span>
                    )}
                  </div>
                  {series.episode_count > 0 && (
                    <div className="wanted-ep-count">
                      {series.episode_file_count}/{series.episode_count} episodios
                    </div>
                  )}
                  {/* A series card is marked by a grab of ANY of its
                      episodes: "we asked for something from this series". */}
                  {grabbed && (
                    <div className="wanted-grabbed" title={series.grabbed_destination ?? undefined}>
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
          {isFetchingNextPage && <div className="wanted-loading-more">Cargando más series...</div>}
        </div>
      </>
    )
  }
  if (activeError) {
    return <ListingError serviceName={serviceName} error={activeError} />
  }
  return <ListingEmpty message="No hay series en el catálogo" />
}

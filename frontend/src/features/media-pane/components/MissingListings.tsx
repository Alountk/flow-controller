import type { WantedMovie, WantedEpisode } from '../../../shared/types.ts'
import { formatGrabMark } from '../../../shared/utils/grabMark.ts'
import { SectionRow, faltaStatus } from './SectionRow.tsx'
import { ListingLoading, ListingError, ListingEmpty } from './ListingStates.tsx'
import { wantedMovieDetail, wantedMovieRelease, wantedEpisodeDetail, wantedEpisodeRelease } from '../rowData.ts'
import type { ListingViewProps, ScanSeriesInput } from '../types.ts'

/**
 * The "missing" branch of the pane — the queue Radarr/Sonarr still owe us,
 * as movies cards or episode rows. Called as plain render functions, not
 * JSX components, on purpose: the four branches sit in ONE slot of the
 * pane's tree, so a component boundary would remount the keyed rows (and
 * drop their state) whenever the filter flips. A function call splices the
 * exact same elements into that slot — zero drift from the monolith.
 */

interface MissingMoviesProps extends ListingViewProps {
  items: WantedMovie[]
  onScan: (movie: WantedMovie) => void
}

export function renderMissingMovies({
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
}: MissingMoviesProps) {
  if (isPending) {
    return <ListingLoading message="Cargando películas faltantes..." />
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
                  onClick={() => openReleases(wantedMovieRelease(movie))}
                >
                  🔍 Buscar
                </button>
                <button
                  className="action-btn scan-folder-btn"
                  onClick={() => onScan(movie)}
                >
                  📁 En carpeta
                </button>
              </>
            )
            if (isSection) {
              return (
                <SectionRow
                  key={movie.id}
                  className={`wanted-card${selectableClass}`}
                  wiring={rowProps(
                    movie.id,
                    () => wantedMovieDetail(movie),
                    () => wantedMovieRelease(movie),
                  )}
                  title={movie.title}
                  year={movie.year}
                  status={faltaStatus()}
                  poster={movie.remotePoster || undefined}
                  grabbed={grabbed}
                  grabbedDestination={movie.grabbed_destination}
                >
                  {actions}
                </SectionRow>
              )
            }
            return (
              // `status-grabbed` is layered ON TOP OF `status-error`: the
              // card is still missing, it was also already requested. Two
              // facts, neither overwriting the other.
              <div
                key={movie.id}
                {...rowProps(
                  movie.id,
                  () => wantedMovieDetail(movie),
                  () => wantedMovieRelease(movie),
                )}
                className={`wanted-card status-error${grabbed ? ' status-grabbed' : ''}${selectableClass}`}
              >
                {movie.remotePoster && (
                  <img className="wanted-poster" src={movie.remotePoster} alt={movie.title} />
                )}
                <div className="wanted-info">
                  <div className="wanted-title">
                    {movie.title} {movie.year && <span className="wanted-year">({movie.year})</span>}
                  </div>
                  {movie.overview && (
                    <div className="wanted-overview">{movie.overview.slice(0, 120)}...</div>
                  )}
                  {/* Null means never requested: show nothing, not a dash
                      and not an empty slot. */}
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
  return <ListingEmpty message="No hay películas faltantes" />
}

interface MissingEpisodesProps extends ListingViewProps {
  items: WantedEpisode[]
  onScan: (series: ScanSeriesInput) => void
}

export function renderMissingEpisodes({
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
}: MissingEpisodesProps) {
  if (isPending) {
    return <ListingLoading message="Cargando episodios faltantes..." />
  }
  if (items.length > 0) {
    return (
      <>
        <div className="wanted-list">
          {items.map((ep) => {
            const grabbed = formatGrabMark(ep.grabbed_at, ep.grabbed_destination)
            const code = `S${String(ep.season_number ?? 0).padStart(2, '0')}E${String(ep.episode_number ?? 0).padStart(2, '0')}`
            const actions = (
              <>
                <button
                  className="action-btn search-item"
                  title="Buscar releases"
                  onClick={() => openReleases(wantedEpisodeRelease(ep))}
                >
                  🔍
                </button>
                <button
                  className="action-btn scan-folder-btn"
                  title="Buscar en carpeta"
                  onClick={() => onScan({
                    id: ep.series_id,
                    title: ep.series_title,
                    season_number: ep.season_number,
                    episode_number: ep.episode_number,
                    episode_title: ep.title,
                    air_date: ep.air_date,
                  })}
                >
                  📁
                </button>
              </>
            )
            if (isSection) {
              return (
                <SectionRow
                  key={ep.id}
                  className={`wanted-row${selectableClass}`}
                  wiring={rowProps(
                    ep.id,
                    () => wantedEpisodeDetail(ep),
                    () => wantedEpisodeRelease(ep),
                  )}
                  title={ep.series_title}
                  status={faltaStatus()}
                  // The episode payload carries no poster (the wanted
                  // endpoint returns none): no prop → initials, never a
                  // guessed series image.
                  grabbed={grabbed}
                  grabbedDestination={ep.grabbed_destination}
                  extra={
                    <>
                      <span className="sec-row-ep">{code}</span>
                      <span className="sec-row-ep-title">{ep.title}</span>
                      {ep.air_date && (
                        <span className="sec-row-date">{ep.air_date.slice(0, 10)}</span>
                      )}
                    </>
                  }
                >
                  {actions}
                </SectionRow>
              )
            }
            return (
              <div
                key={ep.id}
                {...rowProps(
                  ep.id,
                  () => wantedEpisodeDetail(ep),
                  () => wantedEpisodeRelease(ep),
                )}
                className={`wanted-row${grabbed ? ' status-grabbed' : ''}${selectableClass}`}
              >
                <div className="wanted-row-info">
                  <span className="wanted-series">{ep.series_title}</span>
                  <span className="wanted-ep">{code}</span>
                  <span className="wanted-ep-title">{ep.title}</span>
                  {ep.air_date && <span className="wanted-date">{ep.air_date.slice(0, 10)}</span>}
                  {/* Null means never requested: show nothing at all. */}
                  {grabbed && (
                    <span className="wanted-grabbed" title={ep.grabbed_destination ?? undefined}>
                      {grabbed}
                    </span>
                  )}
                </div>
                <div className="wanted-row-actions">
                  {actions}
                </div>
              </div>
            )
          })}
        </div>
        <div ref={loadMoreRef} className="wanted-infinite-sentinel">
          {isFetchingNextPage && <div className="wanted-loading-more">Cargando más episodios...</div>}
        </div>
      </>
    )
  }
  if (activeError) {
    return <ListingError serviceName={serviceName} error={activeError} />
  }
  return <ListingEmpty message="No hay episodios faltantes" />
}

import { useEffect, useState } from 'react'
import { useHashState } from '../hooks/useHashState'
import { useConfiguredServices } from '../hooks/useConfiguredServices'
import { MediaPane, type MediaTotals } from './MediaPane'
import './MissingContent.css'

/**
 * The Faltantes page (retired in PR 4 of F-08).
 *
 * Since PR 2 it is a thin shell: the tabs, their counts and the hash-backed
 * filter stay here — exactly as they always were, under the 'wanted' namespace
 * — while everything that renders one media kind's list lives in MediaPane,
 * the same component the Películas/Series sections use.
 */
export function MissingContent() {
  const [tab, setTab] = useHashState<'movies' | 'episodes'>('wanted', 'tab', 'movies')
  const [movieFilter, setMovieFilter] = useHashState<'missing' | 'all'>('wanted', 'filter', 'missing')
  const [seriesFilter, setSeriesFilter] = useHashState<'missing' | 'all'>('wanted', 'seriesFilter', 'missing')
  const { ready: servicesReady, isConfigured } = useConfiguredServices()
  const showMovies = isConfigured('radarr')
  const showEpisodes = isConfigured('sonarr')

  // Never leave the user on a tab whose service is not configured.
  useEffect(() => {
    if (!servicesReady) return
    if (tab === 'movies' && !showMovies && showEpisodes) setTab('episodes')
    if (tab === 'episodes' && !showEpisodes && showMovies) setTab('movies')
  }, [servicesReady, tab, showMovies, showEpisodes, setTab])

  // The tab labels read their counts from the panes. The state object only
  // changes when a number changes, so the report effect cannot loop.
  const [movieTotals, setMovieTotals] = useState<MediaTotals>({ wanted: 0, all: 0 })
  const [episodeTotals, setEpisodeTotals] = useState<MediaTotals>({ wanted: 0, all: 0 })
  const radarrWantedTotal = movieTotals.wanted
  const sonarrWantedTotal = episodeTotals.wanted

  return (
    <section className="wanted">
      <div className="wanted-header">
        <h2>Contenido Faltante</h2>
        <div className="wanted-tabs">
          {/* A tab whose service is not configured is hidden: it could only
              ever show errors for something the user never set up. */}
          {(!servicesReady || showMovies) && (
            <button
              className={`wanted-tab ${tab === 'movies' ? 'active' : ''}`}
              onClick={() => setTab('movies')}
            >
              Películas ({radarrWantedTotal || '...'})
            </button>
          )}
          {(!servicesReady || showEpisodes) && (
            <button
              className={`wanted-tab ${tab === 'episodes' ? 'active' : ''}`}
              onClick={() => setTab('episodes')}
            >
              Episodios ({sonarrWantedTotal || '...'})
            </button>
          )}
        </div>
      </div>

      {tab === 'movies' ? (
        <MediaPane
          kind="movies"
          namespace="wanted"
          filter={movieFilter}
          onFilterChange={setMovieFilter}
          showFilterButtons
          onTotalsChange={setMovieTotals}
        />
      ) : (
        <MediaPane
          kind="episodes"
          namespace="wanted"
          filter={seriesFilter}
          onFilterChange={setSeriesFilter}
          showFilterButtons
          onTotalsChange={setEpisodeTotals}
        />
      )}
    </section>
  )
}

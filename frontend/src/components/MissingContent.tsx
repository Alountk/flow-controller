import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import type { WantedMovie, WantedEpisode, WantedResponse } from '../types'
import { searchWanted, searchWantedItem } from '../api/wanted'

type Tab = 'movies' | 'episodes'

async function fetchWanted(): Promise<WantedResponse> {
  const res = await fetch('/api/wanted')
  return res.json() as Promise<WantedResponse>
}

export function MissingContent() {
  const [tab, setTab] = useState<Tab>('movies')
  const [searchResult, setSearchResult] = useState<string | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['wanted'],
    queryFn: fetchWanted,
  })

  const searchAll = useMutation({
    mutationFn: (source: 'radarr' | 'sonarr') => searchWanted(source),
    onSuccess: (result, source) => {
      setSearchResult(result.ok ? `Búsqueda lanzada en ${source}` : `Error: ${result.error || 'desconocido'}`)
      setTimeout(() => setSearchResult(null), 4000)
    },
  })

  const searchItem = useMutation({
    mutationFn: ({ source, ids }: { source: 'radarr' | 'sonarr'; ids: Record<string, number | null> }) =>
      searchWantedItem(source, ids),
  })

  const radarrMovies = data?.wanted?.radarr?.items as WantedMovie[] | undefined
  const sonarrEpisodes = data?.wanted?.sonarr?.items as WantedEpisode[] | undefined
  const radarrTotal = data?.wanted?.radarr?.total ?? 0
  const sonarrTotal = data?.wanted?.sonarr?.total ?? 0

  return (
    <section className="wanted">
      <div className="wanted-header">
        <h2>Contenido Faltante</h2>
        <div className="wanted-tabs">
          <button
            className={`wanted-tab ${tab === 'movies' ? 'active' : ''}`}
            onClick={() => setTab('movies')}
          >
            Películas ({radarrTotal})
          </button>
          <button
            className={`wanted-tab ${tab === 'episodes' ? 'active' : ''}`}
            onClick={() => setTab('episodes')}
          >
            Episodios ({sonarrTotal})
          </button>
        </div>
      </div>

      {searchResult && (
        <div className="wanted-search-result">{searchResult}</div>
      )}

      {isPending ? (
        <div className="wanted-loading">Cargando...</div>
      ) : tab === 'movies' ? (
        <div className="wanted-content">
          <div className="wanted-actions">
            <button
              className="action-btn search-all"
              onClick={() => searchAll.mutate('radarr')}
              disabled={searchAll.isPending || radarrTotal === 0}
            >
              {searchAll.isPending ? 'Buscando...' : '🔍 Buscar todas las faltantes'}
            </button>
          </div>
          {radarrMovies && radarrMovies.length > 0 ? (
            <div className="wanted-grid">
              {radarrMovies.map((movie) => (
                <div key={movie.id} className="wanted-card">
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
                    <button
                      className="action-btn search-item"
                      onClick={() => searchItem.mutate({ source: 'radarr', ids: { movie_id: movie.id } })}
                      disabled={searchItem.isPending}
                    >
                      🔍 Buscar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="wanted-empty">No hay películas faltantes</div>
          )}
        </div>
      ) : (
        <div className="wanted-content">
          <div className="wanted-actions">
            <button
              className="action-btn search-all"
              onClick={() => searchAll.mutate('sonarr')}
              disabled={searchAll.isPending || sonarrTotal === 0}
            >
              {searchAll.isPending ? 'Buscando...' : '🔍 Buscar todos los faltantes'}
            </button>
          </div>
          {sonarrEpisodes && sonarrEpisodes.length > 0 ? (
            <div className="wanted-list">
              {sonarrEpisodes.map((ep) => (
                <div key={ep.id} className="wanted-row">
                  <div className="wanted-row-info">
                    <span className="wanted-series">{ep.series_title}</span>
                    <span className="wanted-ep">
                      S{String(ep.season_number ?? 0).padStart(2, '0')}E{String(ep.episode_number ?? 0).padStart(2, '0')}
                    </span>
                    <span className="wanted-ep-title">{ep.title}</span>
                    {ep.air_date && <span className="wanted-date">{ep.air_date.slice(0, 10)}</span>}
                  </div>
                  <button
                    className="action-btn search-item"
                    onClick={() => searchItem.mutate({ source: 'sonarr', ids: { episode_id: ep.id, series_id: ep.series_id } })}
                    disabled={searchItem.isPending}
                  >
                    🔍
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="wanted-empty">No hay episodios faltantes</div>
          )}
        </div>
      )}
    </section>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { WantedMovie, WantedEpisode, WantedResponse } from '../types'
import { searchWanted, searchWantedItem } from '../api/wanted'

type Tab = 'movies' | 'episodes'

export function MissingContent() {
  const [data, setData] = useState<WantedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('movies')
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<string | null>(null)

  const fetchWanted = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/wanted')
      const json = await resp.json()
      setData(json)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchWanted()
  }, [fetchWanted])

  async function handleSearchAll(source: 'radarr' | 'sonarr') {
    setSearching(true)
    setSearchResult(null)
    try {
      const result = await searchWanted(source)
      setSearchResult(result.ok ? `Búsqueda lanzada en ${source}` : `Error: ${result.error || 'desconocido'}`)
    } catch {
      setSearchResult('Error de conexión')
    } finally {
      setSearching(false)
      setTimeout(() => setSearchResult(null), 4000)
    }
  }

  async function handleSearchItem(source: 'radarr' | 'sonarr', ids: Record<string, number | null>) {
    setSearching(true)
    try {
      await searchWantedItem(source, ids)
    } catch {
      // ignore
    } finally {
      setSearching(false)
    }
  }

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

      {loading ? (
        <div className="wanted-loading">Cargando...</div>
      ) : tab === 'movies' ? (
        <div className="wanted-content">
          <div className="wanted-actions">
            <button
              className="action-btn search-all"
              onClick={() => handleSearchAll('radarr')}
              disabled={searching || radarrTotal === 0}
            >
              {searching ? 'Buscando...' : '🔍 Buscar todas las faltantes'}
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
                      onClick={() => handleSearchItem('radarr', { movie_id: movie.id })}
                      disabled={searching}
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
              onClick={() => handleSearchAll('sonarr')}
              disabled={searching || sonarrTotal === 0}
            >
              {searching ? 'Buscando...' : '🔍 Buscar todos los faltantes'}
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
                    onClick={() => handleSearchItem('sonarr', { episode_id: ep.id, series_id: ep.series_id })}
                    disabled={searching}
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

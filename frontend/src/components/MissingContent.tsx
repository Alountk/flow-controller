import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { WantedMovie, WantedEpisode, WantedResponse, ScanMatch, ScanResult } from '../types'
import { searchWanted, searchWantedItem, scanForMovies } from '../api/wanted'
import { fetchRoots, browsePath, queueAdd } from '../api/files'

type Tab = 'movies' | 'episodes' | 'scan'

interface ScanItem {
  type: 'movie' | 'series'
  id: number
  title: string
  source: string
}

async function fetchWanted(): Promise<WantedResponse> {
  const res = await fetch('/api/wanted')
  return res.json() as Promise<WantedResponse>
}

function FileScanTab({ item, onClear }: { item: ScanItem; onClear: () => void }) {
  const queryClient = useQueryClient()
  const [selectedVolume, setSelectedVolume] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedLangs, setSelectedLangs] = useState<Set<string>>(new Set(['en', 'es']))
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [toast, setToast] = useState<string | null>(null)

  const { data: rootsData } = useQuery({
    queryKey: ['roots'],
    queryFn: fetchRoots,
  })

  const roots = rootsData?.roots ?? []

  const { data: browseData } = useQuery({
    queryKey: ['scan-browse', currentPath],
    queryFn: () => browsePath(currentPath),
    enabled: !!currentPath,
  })

  useEffect(() => {
    setScanResult(null)
    setSelectedFiles(new Set())
  }, [item])

  const scan = useMutation({
    mutationFn: () => scanForMovies(
      item.source,
      currentPath,
      Array.from(selectedLangs),
      item.type === 'movie' ? item.id : undefined,
      item.type === 'series' ? item.id : undefined,
    ),
    onSuccess: (result) => {
      setScanResult(result)
      setSelectedFiles(new Set())
    },
  })

  const moveQueue = useMutation({
    mutationFn: async (matches: ScanMatch[]) => {
      for (const m of matches) {
        await queueAdd('move', m.file_path, `${m.movie_title} (${m.movie_year || ''})/${m.file_name}`)
      }
      return { ok: true }
    },
    onSuccess: () => {
      setToast(`${selectedFiles.size} archivos encolados`)
      queryClient.invalidateQueries({ queryKey: ['queue'] })
      if (toastTimer.current) clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToast(null), 3000)
    },
  })

  function handleVolumeChange(volumePath: string) {
    setSelectedVolume(volumePath)
    setCurrentPath(volumePath)
    setScanResult(null)
    setSelectedFiles(new Set())
  }

  function navigateTo(p: string) {
    setCurrentPath(p)
  }

  function toggleLang(lang: string) {
    setSelectedLangs((prev) => {
      const next = new Set(prev)
      if (next.has(lang)) next.delete(lang)
      else next.add(lang)
      return next
    })
  }

  function toggleFile(path: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function toggleAll() {
    if (!scanResult) return
    if (selectedFiles.size === scanResult.matches.length) {
      setSelectedFiles(new Set())
    } else {
      setSelectedFiles(new Set(scanResult.matches.map((m) => m.file_path)))
    }
  }

  const items = browseData?.ok ? browseData.items : []
  const selectedMatches = scanResult?.matches.filter((m) => selectedFiles.has(m.file_path)) ?? []

  return (
    <div className="scan-tab">
      {toast && <div className="fm-toast">{toast}</div>}

      <div className="scan-selected-item">
        <div className="scan-selected-info">
          <span className="scan-selected-type">{item.type === 'movie' ? '🎬 Película' : '📺 Serie'}:</span>
          <strong>{item.title}</strong>
        </div>
        <button className="scan-clear-btn" onClick={onClear}>×</button>
      </div>

      <div className="scan-controls">
        <div className="scan-row">
          <label className="scan-label">Carpeta a escanear:</label>
          <select
            className="fm-volume-select"
            value={selectedVolume}
            onChange={(e) => handleVolumeChange(e.target.value)}
          >
            <option value="">Seleccionar volumen...</option>
            {roots.map((r) => (
              <option key={r.path} value={r.path}>{r.name}</option>
            ))}
          </select>
          {currentPath && (
            <button className="fm-nav-btn" onClick={() => {
              const parts = currentPath.split('/')
              if (parts.length > 2) {
                const parent = parts.slice(0, -1).join('/') || selectedVolume
                if (parent.length >= selectedVolume.length) navigateTo(parent)
              }
            }} title="Subir">⬆</button>
          )}
        </div>

        {currentPath && (
          <div className="scan-path-list">
            <div className="scan-current-path">{currentPath}</div>
            {items.filter((i) => i.is_dir).map((dirItem) => (
              <div
                key={dirItem.path}
                className="scan-folder-item"
                onClick={() => navigateTo(dirItem.path)}
              >
                📁 {dirItem.name}
              </div>
            ))}
          </div>
        )}

        <div className="scan-row">
          <label className="scan-label">Idiomas:</label>
          <div className="scan-lang-list">
            {['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru'].map((lang) => (
              <label key={lang} className="scan-lang-check">
                <input
                  type="checkbox"
                  checked={selectedLangs.has(lang)}
                  onChange={() => toggleLang(lang)}
                />
                {lang}
              </label>
            ))}
          </div>
        </div>

        <button
          className="action-btn search-all"
          onClick={() => scan.mutate()}
          disabled={!currentPath || scan.isPending || selectedLangs.size === 0}
        >
          {scan.isPending ? 'Escaneando...' : `🔍 Buscar "${item.title}" en esta carpeta`}
        </button>
      </div>

      {scanResult && (
        <div className="scan-results">
          <div className="scan-summary">
            {scanResult.detail}
            {scanResult.matches.length > 0 && (
              <button className="fm-action-btn" onClick={toggleAll}>
                {selectedFiles.size === scanResult.matches.length ? 'Deseleccionar todo' : 'Seleccionar todo'}
              </button>
            )}
          </div>

          {scanResult.matches.length > 0 ? (
            <div className="scan-match-list">
              {scanResult.matches.map((m) => (
                <div
                  key={m.file_path}
                  className={`scan-match ${selectedFiles.has(m.file_path) ? 'selected' : ''}`}
                  onClick={() => toggleFile(m.file_path)}
                >
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(m.file_path)}
                    onChange={() => toggleFile(m.file_path)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="scan-match-info">
                    <div className="scan-match-file">📄 {m.file_name}</div>
                    <div className="scan-match-score">
                      Similitud: {Math.round(m.score * 100)}% · Título: "{m.matched_title}"
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="wanted-empty">No se encontraron archivos para "{item.title}"</div>
          )}

          {selectedMatches.length > 0 && (
            <div className="scan-actions">
              <button
                className="action-btn search-all"
                onClick={() => moveQueue.mutate(selectedMatches)}
                disabled={moveQueue.isPending}
              >
                {moveQueue.isPending ? 'Encolando...' : `📦 Mover ${selectedMatches.length} archivos a la cola`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function MissingContent() {
  const [tab, setTab] = useState<Tab>('movies')
  const [searchResult, setSearchResult] = useState<string | null>(null)
  const [scanItem, setScanItem] = useState<ScanItem | null>(null)

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

  function handleScanForMovie(movie: WantedMovie) {
    setScanItem({ type: 'movie', id: movie.id, title: movie.title, source: 'radarr' })
    setTab('scan')
  }

  function handleScanForSeries(seriesTitle: string, seriesId: number | null) {
    if (!seriesId) return
    setScanItem({ type: 'series', id: seriesId, title: seriesTitle, source: 'sonarr' })
    setTab('scan')
  }

  function clearScanItem() {
    setScanItem(null)
    setTab('movies')
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
          <button
            className={`wanted-tab ${tab === 'scan' ? 'active' : ''}`}
            onClick={() => setTab('scan')}
          >
            🔍 Buscar Archivos
          </button>
        </div>
      </div>

      {searchResult && (
        <div className="wanted-search-result">{searchResult}</div>
      )}

      {tab === 'scan' ? (
        scanItem ? (
          <FileScanTab item={scanItem} onClear={clearScanItem} />
        ) : (
          <div className="scan-empty-state">
            <p>Selecciona una película o serie de las pestañas anteriores y haz clic en "🔍 Buscar en carpeta".</p>
            <button className="action-btn" onClick={() => setTab('movies')}>Ver películas</button>
            <button className="action-btn" onClick={() => setTab('episodes')}>Ver episodios</button>
          </div>
        )
      ) : isPending ? (
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
                    <div className="wanted-card-actions">
                      <button
                        className="action-btn search-item"
                        onClick={() => searchItem.mutate({ source: 'radarr', ids: { movie_id: movie.id } })}
                        disabled={searchItem.isPending}
                      >
                        🔍 Buscar
                      </button>
                      <button
                        className="action-btn scan-folder-btn"
                        onClick={() => handleScanForMovie(movie)}
                      >
                        📁 En carpeta
                      </button>
                    </div>
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
                  <div className="wanted-row-actions">
                    <button
                      className="action-btn search-item"
                      onClick={() => searchItem.mutate({ source: 'sonarr', ids: { episode_id: ep.id, series_id: ep.series_id } })}
                      disabled={searchItem.isPending}
                    >
                      🔍
                    </button>
                    <button
                      className="action-btn scan-folder-btn"
                      title="Buscar en carpeta"
                      onClick={() => handleScanForSeries(ep.series_title, ep.series_id)}
                    >
                      📁
                    </button>
                  </div>
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

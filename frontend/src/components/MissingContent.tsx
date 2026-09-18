import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { WantedMovie, WantedEpisode, WantedResponse, ScanMatch, ScanResult, AllMovie } from '../types'
import { searchWantedItem, scanForMovies } from '../api/wanted'
import { fetchRoots, browsePath, queueAdd } from '../api/files'
import { useHashState } from '../hooks/useHashState'

const LANG_LIST = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'manual'] as const
const LANG_LABELS: Record<string, string> = {
  en: 'Inglés', es: 'Español', fr: 'Francés', de: 'Alemán', it: 'Italiano',
  pt: 'Portugués', ja: 'Japonés', ko: 'Coreano', zh: 'Chino', ru: 'Ruso', manual: 'Manual...',
}

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

async function fetchAllMovies(): Promise<{ items: AllMovie[]; total: number }> {
  const res = await fetch('/api/wanted/all')
  return res.json() as Promise<{ items: AllMovie[]; total: number }>
}

function ScanModal({ item, onClose }: { item: ScanItem; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [selectedVolume, setSelectedVolume] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedLangs, setSelectedLangs] = useState<Set<string>>(new Set(['en', 'es']))
  const [customTitle, setCustomTitle] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [toast, setToast] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  const isManual = selectedLangs.has('manual')
  const langsForScan = Array.from(selectedLangs).filter((l) => l !== 'manual')

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
      isManual && customTitle ? [] : langsForScan,
      item.type === 'movie' ? item.id : undefined,
      item.type === 'series' ? item.id : undefined,
      isManual ? customTitle : undefined,
    ),
    onSuccess: (result) => {
      setScanResult(result)
      setSelectedFiles(new Set())
    },
  })

  const moveQueue = useMutation({
    mutationFn: async (matches: ScanMatch[]) => {
      for (const m of matches) {
        const dst = m.target_path
          ? `${m.target_path}/${m.file_name}`
          : `${m.movie_title} (${m.movie_year || ''})/${m.file_name}`
        await queueAdd('move', m.file_path, dst, item.source, m.movie_id)
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

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
    <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
      <div className="scan-modal" ref={modalRef}>
        {toast && <div className="fm-toast">{toast}</div>}

        <div className="scan-modal-header">
          <div className="scan-selected-info">
            <span className="scan-selected-type">{item.type === 'movie' ? '🎬' : '📺'}</span>
            <strong>{item.title}</strong>
          </div>
          <button className="scan-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="scan-modal-body">
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
                {LANG_LIST.map((lang) => (
                  <label key={lang} className={`scan-lang-check ${lang === 'manual' ? 'scan-lang-manual' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selectedLangs.has(lang)}
                      onChange={() => toggleLang(lang)}
                    />
                    {LANG_LABELS[lang]}
                  </label>
                ))}
              </div>
            </div>

            {isManual && (
              <div className="scan-row">
                <label className="scan-label">Título a buscar:</label>
                <input
                  type="text"
                  className="scan-custom-input"
                  placeholder="Escribe el título manualmente..."
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  autoFocus
                />
              </div>
            )}

            <button
              className="action-btn search-all"
              onClick={() => scan.mutate()}
              disabled={
                !currentPath
                || scan.isPending
                || (isManual ? !customTitle.trim() : selectedLangs.size === 0)
              }
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
                        <div className="scan-match-path" title={m.file_path}>{m.file_path}</div>
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
      </div>
    </div>
  )
}

export function MissingContent() {
  const [tab, setTab] = useHashState<'movies' | 'episodes'>('wanted', 'tab', 'movies')
  const [movieFilter, setMovieFilter] = useHashState<'missing' | 'all'>('wanted', 'filter', 'missing')
  const [scanItem, setScanItem] = useState<ScanItem | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['wanted'],
    queryFn: fetchWanted,
  })

  const { data: allMoviesData, isPending: allMoviesLoading } = useQuery({
    queryKey: ['all-movies'],
    queryFn: fetchAllMovies,
    enabled: tab === 'movies' && movieFilter === 'all',
  })

  const searchItem = useMutation({
    mutationFn: ({ source, ids }: { source: 'radarr' | 'sonarr'; ids: Record<string, number | null> }) =>
      searchWantedItem(source, ids),
  })

  function handleScanForMovie(movie: WantedMovie) {
    setScanItem({ type: 'movie', id: movie.id, title: movie.title, source: 'radarr' })
  }

  function handleScanForSeries(seriesTitle: string, seriesId: number | null) {
    if (!seriesId) return
    setScanItem({ type: 'series', id: seriesId, title: seriesTitle, source: 'sonarr' })
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

      {isPending ? (
        <div className="wanted-loading">Cargando...</div>
      ) : tab === 'movies' ? (
        <div className="wanted-content">
          <div className="wanted-actions">
            <div className="wanted-filter">
              <button
                className={`wanted-filter-btn ${movieFilter === 'missing' ? 'active' : ''}`}
                onClick={() => setMovieFilter('missing')}
              >
                Faltantes ({radarrTotal})
              </button>
              <button
                className={`wanted-filter-btn ${movieFilter === 'all' ? 'active' : ''}`}
                onClick={() => setMovieFilter('all')}
              >
                Todas ({allMoviesData?.total ?? '...'})
              </button>
            </div>
          </div>
          {movieFilter === 'missing' ? (
            radarrMovies && radarrMovies.length > 0 ? (
              <div className="wanted-grid">
                {radarrMovies.map((movie) => (
                  <div key={movie.id} className="wanted-card status-error">
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
            )
          ) : allMoviesLoading ? (
            <div className="wanted-loading">Cargando catálogo...</div>
          ) : allMoviesData && allMoviesData.items.length > 0 ? (
            <div className="wanted-grid">
              {allMoviesData.items.map((movie) => (
                <div
                  key={movie.id}
                  className={`wanted-card ${movie.has_file && movie.path_exists ? 'status-ok' : 'status-error'}`}
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
                        <span className="badge-error">✗ Sin archivo</span>
                      ) : (
                        <span className="badge-error">✗ Ruta no encontrada</span>
                      )}
                    </div>
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
                        onClick={() => handleScanForMovie({ id: movie.id, title: movie.title, year: movie.year, overview: '', remotePoster: movie.remotePoster, has_file: movie.has_file, altTitles: [] })}
                      >
                        📁 En carpeta
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="wanted-empty">No hay películas en el catálogo</div>
          )}
        </div>
      ) : (
        <div className="wanted-content">
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

      {scanItem && <ScanModal item={scanItem} onClose={() => setScanItem(null)} />}
    </section>
  )
}

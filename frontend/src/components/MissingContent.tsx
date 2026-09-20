import { useEffect, useRef, useState, useCallback } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WantedMovie, ScanMatch, ScanResult } from '../types'
import {
  fetchWantedMovies,
  fetchWantedEpisodes,
  fetchAllMovies,
  fetchAllSeries,
  scanForMovies,
} from '../api/wanted'
import { fetchRoots, browsePath, queueAdd } from '../api/files'
import { useHashState } from '../hooks/useHashState'
import {
  areAllVisibleSelected,
  filterScanMatches,
  toggleVisibleSelection,
} from '../utils/scanResults'
import { ReleaseSearchModal, type ReleaseSearchItem } from './ReleaseSearchModal'
import './MissingContent.css'

const PAGE_SIZE = 50

interface ScanItem {
  type: 'movie' | 'series'
  id: number
  title: string
  source: string
}

function ScanModal({ item, onClose }: { item: ScanItem; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [selectedVolume, setSelectedVolume] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [resultFilter, setResultFilter] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [toast, setToast] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

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
    setResultFilter('')
  }, [item])

  const scan = useMutation({
    mutationFn: () => scanForMovies(
      item.source,
      currentPath,
      item.type === 'movie' ? item.id : undefined,
      item.type === 'series' ? item.id : undefined,
      customTitle.trim() || undefined,
    ),
    onSuccess: (result) => {
      setScanResult(result)
      setSelectedFiles(new Set())
      setResultFilter('')
    },
  })

  const moveQueue = useMutation({
    mutationFn: async (matches: ScanMatch[]) => {
      for (const m of matches) {
        const dst = m.target_path
          ? `${m.target_path}/${m.file_name}`
          : `${m.movie_title} (${m.movie_year || ''})/${m.file_name}`
        await queueAdd(
          'move',
          m.file_path,
          dst,
          item.source,
          item.type === 'movie' ? m.movie_id : undefined,
          item.type === 'series' ? m.movie_id : undefined,
        )
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

  function toggleFile(path: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const items = browseData?.ok ? browseData.items : []
  const allMatches = scanResult?.matches ?? []
  // Filters only what is already on screen: the scan returns its full result set
  // in one response, so unlike the paginated listing this cannot hide matches.
  const visibleMatches = filterScanMatches(allMatches, resultFilter)
  const visibleCount = visibleMatches.length
  const allVisibleSelected = areAllVisibleSelected(selectedFiles, visibleMatches)

  function toggleAll() {
    // Only ever touches what the filter is showing: acting on hidden rows would
    // move files the user cannot see.
    setSelectedFiles((prev) => toggleVisibleSelection(prev, visibleMatches))
  }

  const selectedMatches = allMatches.filter((m) => selectedFiles.has(m.file_path))

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
                {roots.map((r: { path: string; name: string }) => (
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
                {items.filter((i: { is_dir: boolean }) => i.is_dir).map((dirItem: { path: string; name: string }) => (
                  <div
                    key={dirItem.path}
                    className="scan-folder-item"
                    onClick={() => navigateTo(dirItem.path)}
                  >
                    📁 {dirItem.name}
                  </div>
                ))}
                {items.filter((i: { is_dir: boolean }) => i.is_dir).length === 0 && (
                  <div className="scan-no-subfolders">Sin subcarpetas</div>
                )}
              </div>
            )}

            <div className="scan-row">
              <label className="scan-label">Título adicional:</label>
              <input
                type="text"
                className="scan-custom-input"
                placeholder="Opcional: añade un título para buscar también..."
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
              />
            </div>

            <button
              className="action-btn search-all"
              onClick={() => scan.mutate()}
              disabled={!currentPath || scan.isPending}
            >
              {scan.isPending ? 'Escaneando...' : `🔍 Buscar "${item.title}" en esta carpeta`}
            </button>
          </div>

          {scanResult && (
            <div className="scan-results">
              <div className="scan-summary">
                {scanResult.detail}
                {visibleCount > 0 && (
                  <button className="fm-action-btn" onClick={toggleAll}>
                    {allVisibleSelected ? 'Deseleccionar todo' : 'Seleccionar todo'}
                  </button>
                )}
              </div>

              {allMatches.length > 0 && (
                <div className="scan-result-filter">
                  <input
                    type="text"
                    className="scan-custom-input"
                    placeholder="Filtrar resultados por nombre o título..."
                    value={resultFilter}
                    onChange={(e) => setResultFilter(e.target.value)}
                  />
                  <span className="scan-result-count">
                    {visibleCount} de {allMatches.length}
                  </span>
                </div>
              )}

              {visibleCount > 0 ? (
                <div className="scan-match-list">
                  {visibleMatches.map((m) => (
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
              ) : allMatches.length > 0 ? (
                <div className="wanted-empty">Ningún resultado coincide con el filtro</div>
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
  const [seriesFilter, setSeriesFilter] = useHashState<'missing' | 'all'>('wanted', 'seriesFilter', 'missing')
  const [scanItem, setScanItem] = useState<ScanItem | null>(null)
  const [releaseSearchItem, setReleaseSearchItem] = useState<ReleaseSearchItem | null>(null)

  // Sentinel ref for infinite scroll intersection observer
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  // 1. Wanted Movies Infinite Query
  const wantedMoviesQuery = useInfiniteQuery({
    queryKey: ['wanted-movies-infinite'],
    queryFn: ({ pageParam = 1 }) => fetchWantedMovies(pageParam, PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: tab === 'movies' && movieFilter === 'missing',
  })

  // 2. All Movies Infinite Query
  const allMoviesQuery = useInfiniteQuery({
    queryKey: ['all-movies-infinite'],
    queryFn: ({ pageParam = 1 }) => fetchAllMovies(pageParam, PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: tab === 'movies' && movieFilter === 'all',
  })

  // 3. Wanted Episodes Infinite Query
  const wantedEpisodesQuery = useInfiniteQuery({
    queryKey: ['wanted-episodes-infinite'],
    queryFn: ({ pageParam = 1 }) => fetchWantedEpisodes(pageParam, PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: tab === 'episodes' && seriesFilter === 'missing',
  })

  // 4. All Series Infinite Query
  const allSeriesQuery = useInfiniteQuery({
    queryKey: ['all-series-infinite'],
    queryFn: ({ pageParam = 1 }) => fetchAllSeries(pageParam, PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: tab === 'episodes' && seriesFilter === 'all',
  })

  // Active query based on current view
  const activeQuery =
    tab === 'movies'
      ? (movieFilter === 'missing' ? wantedMoviesQuery : allMoviesQuery)
      : (seriesFilter === 'missing' ? wantedEpisodesQuery : allSeriesQuery)

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isPending } = activeQuery

  // IntersectionObserver for auto-loading next page on scroll
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !hasNextPage || isFetchingNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchNextPage()
        }
      },
      { rootMargin: '300px' },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  function handleScanForMovie(movie: WantedMovie) {
    setScanItem({ type: 'movie', id: movie.id, title: movie.title, source: 'radarr' })
  }

  function handleScanForSeries(seriesTitle: string, seriesId: number | null) {
    if (!seriesId) return
    setScanItem({ type: 'series', id: seriesId, title: seriesTitle, source: 'sonarr' })
  }

  const radarrWantedTotal = wantedMoviesQuery.data?.pages[0]?.total ?? 0
  const radarrAllTotal = allMoviesQuery.data?.pages[0]?.total ?? 0
  const sonarrWantedTotal = wantedEpisodesQuery.data?.pages[0]?.total ?? 0
  const sonarrAllTotal = allSeriesQuery.data?.pages[0]?.total ?? 0

  const allWantedMovies = wantedMoviesQuery.data?.pages.flatMap((p) => p.items) ?? []
  const allCatalogMovies = allMoviesQuery.data?.pages.flatMap((p) => p.items) ?? []
  const allWantedEpisodes = wantedEpisodesQuery.data?.pages.flatMap((p) => p.items) ?? []
  const allCatalogSeries = allSeriesQuery.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <section className="wanted">
      <div className="wanted-header">
        <h2>Contenido Faltante</h2>
        <div className="wanted-tabs">
          <button
            className={`wanted-tab ${tab === 'movies' ? 'active' : ''}`}
            onClick={() => setTab('movies')}
          >
            Películas ({radarrWantedTotal || '...'})
          </button>
          <button
            className={`wanted-tab ${tab === 'episodes' ? 'active' : ''}`}
            onClick={() => setTab('episodes')}
          >
            Episodios ({sonarrWantedTotal || '...'})
          </button>
        </div>
      </div>

      {tab === 'movies' ? (
        <div className="wanted-content">
          <div className="wanted-actions">
            <div className="wanted-filter">
              <button
                className={`wanted-filter-btn ${movieFilter === 'missing' ? 'active' : ''}`}
                onClick={() => setMovieFilter('missing')}
              >
                Faltantes ({radarrWantedTotal})
              </button>
              <button
                className={`wanted-filter-btn ${movieFilter === 'all' ? 'active' : ''}`}
                onClick={() => setMovieFilter('all')}
              >
                Todas ({radarrAllTotal || '...'})
              </button>
            </div>
          </div>

          {movieFilter === 'missing' ? (
            isPending ? (
              <div className="wanted-loading">Cargando películas faltantes...</div>
            ) : allWantedMovies.length > 0 ? (
              <>
                <div className="wanted-grid">
                  {allWantedMovies.map((movie) => (
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
                            onClick={() => setReleaseSearchItem({
                              type: 'movie',
                              id: movie.id,
                              title: movie.title,
                              year: movie.year,
                              source: 'radarr',
                              remotePoster: movie.remotePoster,
                              has_file: movie.has_file,
                            })}
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
                <div ref={loadMoreRef} className="wanted-infinite-sentinel">
                  {isFetchingNextPage && <div className="wanted-loading-more">Cargando más películas...</div>}
                </div>
              </>
            ) : (
              <div className="wanted-empty">No hay películas faltantes</div>
            )
          ) : isPending ? (
            <div className="wanted-loading">Cargando catálogo de películas...</div>
          ) : allCatalogMovies.length > 0 ? (
            <>
              <div className="wanted-grid">
                {allCatalogMovies.map((movie) => (
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
                          onClick={() => setReleaseSearchItem({
                            type: 'movie',
                            id: movie.id,
                            title: movie.title,
                            year: movie.year,
                            source: 'radarr',
                            remotePoster: movie.remotePoster,
                            has_file: movie.has_file,
                          })}
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
              <div ref={loadMoreRef} className="wanted-infinite-sentinel">
                {isFetchingNextPage && <div className="wanted-loading-more">Cargando más películas...</div>}
              </div>
            </>
          ) : (
            <div className="wanted-empty">No hay películas en el catálogo</div>
          )}
        </div>
      ) : (
        <div className="wanted-content">
          <div className="wanted-actions">
            <div className="wanted-filter">
              <button
                className={`wanted-filter-btn ${seriesFilter === 'missing' ? 'active' : ''}`}
                onClick={() => setSeriesFilter('missing')}
              >
                Faltantes ({sonarrWantedTotal})
              </button>
              <button
                className={`wanted-filter-btn ${seriesFilter === 'all' ? 'active' : ''}`}
                onClick={() => setSeriesFilter('all')}
              >
                Todas ({sonarrAllTotal || '...'})
              </button>
            </div>
          </div>

          {seriesFilter === 'missing' ? (
            isPending ? (
              <div className="wanted-loading">Cargando episodios faltantes...</div>
            ) : allWantedEpisodes.length > 0 ? (
              <>
                <div className="wanted-list">
                  {allWantedEpisodes.map((ep) => (
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
                          title="Buscar releases"
                          onClick={() => setReleaseSearchItem({
                            type: 'episode',
                            id: ep.id,
                            title: ep.title,
                            series_title: ep.series_title,
                            season_number: ep.season_number,
                            episode_number: ep.episode_number,
                            date: ep.air_date ? ep.air_date.slice(0, 10) : undefined,
                            source: 'sonarr',
                            has_file: false,
                          })}
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
                <div ref={loadMoreRef} className="wanted-infinite-sentinel">
                  {isFetchingNextPage && <div className="wanted-loading-more">Cargando más episodios...</div>}
                </div>
              </>
            ) : (
              <div className="wanted-empty">No hay episodios faltantes</div>
            )
          ) : isPending ? (
            <div className="wanted-loading">Cargando catálogo de series...</div>
          ) : allCatalogSeries.length > 0 ? (
            <>
              <div className="wanted-grid">
                {allCatalogSeries.map((series) => (
                  <div
                    key={series.id}
                    className={`wanted-card ${series.has_file && series.path_exists ? 'status-ok' : 'status-error'}`}
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
                      <div className="wanted-card-actions">
                        <button
                          className="action-btn search-item"
                          onClick={() => setReleaseSearchItem({
                            type: 'episode',
                            id: series.id,
                            title: series.title,
                            series_title: series.title,
                            year: series.year,
                            source: 'sonarr',
                            remotePoster: series.remotePoster,
                            has_file: series.has_file,
                          })}
                        >
                          🔍 Buscar
                        </button>
                        <button
                          className="action-btn scan-folder-btn"
                          onClick={() => handleScanForSeries(series.title, series.id)}
                        >
                          📁 En carpeta
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div ref={loadMoreRef} className="wanted-infinite-sentinel">
                {isFetchingNextPage && <div className="wanted-loading-more">Cargando más series...</div>}
              </div>
            </>
          ) : (
            <div className="wanted-empty">No hay series en el catálogo</div>
          )}
        </div>
      )}

      {scanItem && <ScanModal item={scanItem} onClose={() => setScanItem(null)} />}
      {releaseSearchItem && <ReleaseSearchModal item={releaseSearchItem} onClose={() => setReleaseSearchItem(null)} />}
    </section>
  )
}

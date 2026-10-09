import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ScanMatch, ScanResult } from '../../../shared/types.ts'
import { fetchSeriesEpisodes, scanForMovies } from '../../../shared/api/wanted.ts'
import { episodeTagKey, formatEpisodeLabel, parseEpisodeTag } from '../../../shared/utils/episodeTag.ts'
import { fetchRoots, browsePath, queueAdd } from '../../../shared/api/files.ts'
import { areAllVisibleSelected, toggleVisibleSelection } from '../../../shared/utils/selection.ts'
import { filterScanMatches, scanMatchKey } from '../../../shared/utils/scanResults.ts'

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** What a row asked the pane to scan for: one movie, or one series (possibly
 *  narrowed to a single episode by the "En carpeta" action). */
export interface ScanItem {
  type: 'movie' | 'series'
  id: number
  title: string
  source: string
  // Present only when "En carpeta" was opened for one specific episode; the
  // "Todas" series card scans a whole series and leaves these empty.
  season_number?: number | null
  episode_number?: number | null
  episode_title?: string | null
  air_date?: string | null
}

export function ScanModal({ item, onClose }: { item: ScanItem; onClose: () => void }) {
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

  const { data: browseData, refetch: refetchBrowse } = useQuery({
    queryKey: ['scan-browse', currentPath],
    queryFn: () => browsePath(currentPath),
    enabled: !!currentPath,
    // The listing mirrors the disk: any cache here hides a folder that a
    // download just created, which is the one thing this modal exists to find.
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const episodesQuery = useQuery({
    queryKey: ['series-episodes', item.id],
    queryFn: () => fetchSeriesEpisodes(item.id),
    enabled: item.type === 'series',
    // Sonarr's episode metadata changes on its own schedule, not per keystroke.
    // Unlike the disk listing above, caching it for a few minutes is correct.
    staleTime: 5 * 60_000,
  })

  // One lookup per series, then every file's `S##E##` is resolved locally.
  const episodeByTag = useMemo(() => {
    const map = new Map<string, { title: string; air_date: string }>()
    for (const ep of episodesQuery.data?.episodes ?? []) {
      if (ep.season_number == null || ep.episode_number == null) continue
      map.set(episodeTagKey(ep.season_number, ep.episode_number), {
        title: ep.title,
        air_date: ep.air_date,
      })
    }
    return map
  }, [episodesQuery.data])

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

  const placeQueue = useMutation({
    mutationFn: async (matches: ScanMatch[]) => {
      for (const m of matches) {
        const dst = m.target_path
          ? `${m.target_path}/${m.file_name}`
          : `${m.movie_title} (${m.movie_year || ''})/${m.file_name}`
        await queueAdd(
          // A copy, never a move: `move` renames the download away and the
          // hardlink aMule/qBittorrent is sharing disappears with it. Placing
          // keeps the source seeding (hardlink when the FS allows it).
          'copy',
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
  const allVisibleSelected = areAllVisibleSelected(selectedFiles, visibleMatches, scanMatchKey)

  function toggleAll() {
    // Only ever touches what the filter is showing: acting on hidden rows would
    // move files the user cannot see.
    setSelectedFiles((prev) => toggleVisibleSelection(prev, visibleMatches, scanMatchKey))
  }

  const selectedMatches = allMatches.filter((m) => selectedFiles.has(m.file_path))

  // The header must identify the episode, not just the series. Movies and
  // whole-series scans fall back to the bare title.
  const episodeLabel =
    item.type === 'series' && item.season_number != null && item.episode_number != null
      ? formatEpisodeLabel({
          season: item.season_number,
          episode: item.episode_number,
          title: item.episode_title,
          air_date: item.air_date,
        })
      : null

  return (
    <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
      <div className="scan-modal" ref={modalRef}>
        {toast && <div className="fm-toast">{toast}</div>}

        <div className="scan-modal-header">
          <div className="scan-selected-info">
            <span className="scan-selected-type">{item.type === 'movie' ? '🎬' : '📺'}</span>
            <strong>{episodeLabel ?? item.title}</strong>
            {episodeLabel && <span className="scan-selected-series">{item.title}</span>}
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
              {currentPath && (
                <button
                  className="fm-nav-btn"
                  onClick={() => refetchBrowse()}
                  title="Refrescar listado"
                >
                  ↻
                </button>
              )}
            </div>

            {currentPath && (
              <div className="scan-path-list">
                <div className="scan-current-path">{currentPath}</div>
                {items.map((entry) => {
                  if (entry.is_dir) {
                    return (
                      <div
                        key={entry.path}
                        className="scan-folder-item"
                        onClick={() => navigateTo(entry.path)}
                      >
                        📁 {entry.name}
                      </div>
                    )
                  }
                  // Resolve the episode from the name, then look it up in the
                  // series map. No tag or no match means no extra line — never
                  // a guessed episode.
                  const tag = parseEpisodeTag(entry.name)
                  const episode = tag ? episodeByTag.get(episodeTagKey(tag.season, tag.episode)) : undefined
                  return (
                    <div key={entry.path} className="scan-file-row">
                      <span className="scan-file-row-icon">📄</span>
                      <div className="scan-file-row-main">
                        <span className="scan-file-row-name" title={entry.name}>{entry.name}</span>
                        {tag && episode && (
                          <span className="scan-file-row-episode">
                            {formatEpisodeLabel({
                              season: tag.season,
                              episode: tag.episode,
                              title: episode.title,
                              air_date: episode.air_date,
                            })}
                          </span>
                        )}
                      </div>
                      <span className="scan-file-row-size">{formatSize(entry.size)}</span>
                    </div>
                  )
                })}
                {items.length === 0 && (
                  <div className="scan-no-subfolders">Carpeta vacía</div>
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
                    onClick={() => placeQueue.mutate(selectedMatches)}
                    disabled={placeQueue.isPending}
                  >
                    {placeQueue.isPending ? 'Encolando...' : `📦 Colocar ${selectedMatches.length} archivos en la cola`}
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

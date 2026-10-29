import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ScanMatch, ScanResult } from '../../../shared/types.ts'
import { fetchSeriesEpisodes, scanForMovies } from '../../../shared/api/wanted.ts'
import { episodeTagKey, formatEpisodeLabel, parseEpisodeTag } from '../../../shared/utils/episodeTag.ts'
import { queueAdd } from '../../../shared/api/files.ts'
import { useRoots } from '../../../shared/hooks/useFilesNavigator.ts'
import { FileNavigator } from '../../../shared/ui/FileNavigator.tsx'
import { areAllVisibleSelected, toggleVisibleSelection } from '../../../shared/utils/selection.ts'
import { filterScanMatches, scanMatchKey } from '../../../shared/utils/scanResults.ts'

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
  const [currentPath, setCurrentPath] = useState('')
  const rootsQuery = useRoots(true)
  const [customTitle, setCustomTitle] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [resultFilter, setResultFilter] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [toast, setToast] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

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

  // Switching volumes invalidates results pointing into the old tree — the
  // pre-migration handleVolumeChange behavior FileNavigator cannot infer.
  function rootOf(p: string) {
    return rootsQuery.data?.roots.find((r) => p === r.path || p.startsWith(`${r.path}/`))?.path ?? ''
  }

  function handleNavigate(p: string) {
    if (rootOf(p) !== rootOf(currentPath)) {
      setScanResult(null)
      setSelectedFiles(new Set())
    }
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

  // Resolve the episode from the name, then look it up in the series map. No
  // tag or no match means no extra line — never a guessed episode.
  function renderEpisode(entry: { name: string }) {
    const tag = parseEpisodeTag(entry.name)
    const episode = tag ? episodeByTag.get(episodeTagKey(tag.season, tag.episode)) : undefined
    if (!tag || !episode) return null
    return (
      <span className="scan-file-row-episode">
        {formatEpisodeLabel({
          season: tag.season,
          episode: tag.episode,
          title: episode.title,
          air_date: episode.air_date,
        })}
      </span>
    )
  }

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
            <FileNavigator
              variant="region"
              rootPicker="select"
              rootLabel="Carpeta a escanear:"
              selectPlaceholder="Seleccionar volumen..."
              showRefresh
              showIcons
              showSizes
              renderFileMeta={renderEpisode}
              emptyLabel="Carpeta vacía"
              mode="both"
              initialPath={currentPath}
              onNavigate={handleNavigate}
            />

            <div className="scan-row">
              <label className="scan-label scan-label--grow">
                Título adicional:
                <input
                  type="text"
                  className="scan-custom-input"
                  placeholder="Opcional: añade un título para buscar también..."
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                />
              </label>
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

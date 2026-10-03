import { useEffect, useRef, useState, useCallback, useMemo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WantedMovie, WantedEpisode, AllMovie, AllSeries, ScanMatch, ScanResult } from '../types'
import {
  fetchWantedMovies,
  fetchWantedEpisodes,
  fetchAllMovies,
  fetchAllSeries,
  fetchSeriesEpisodes,
  scanForMovies,
} from '../api/wanted'
import { episodeTagKey, formatEpisodeLabel, parseEpisodeTag } from '../utils/episodeTag'
import { formatGrabMark } from '../utils/grabMark'
import { fetchRoots, browsePath, queueAdd } from '../api/files'
import { useHashState } from '../hooks/useHashState'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { areAllVisibleSelected, toggleVisibleSelection } from '../utils/selection'
import { filterScanMatches, scanMatchKey } from '../utils/scanResults'
import { ReleaseSearchModal, type ReleaseSearchItem } from './ReleaseSearchModal'
import './MissingContent.css'

/**
 * One media kind's listing, extracted from the Faltantes page (PR 2 of F-08).
 *
 * The pane owns everything that makes the listing work — the filter bar, the
 * debounced search, the infinite queries with their auto-load, the scan and
 * release-search modals and the error banner — for a SINGLE media kind.
 * The caller drives it: MissingContent passes its own hash-backed filter and
 * asks for the Faltantes/Todas buttons, while the Películas/Series sections
 * derive the filter from their sub-view tabs and suppress the buttons, because
 * THERE the sub-view tabs already are the filter.
 *
 * The caller must render it inside an element carrying the `wanted` class:
 * the row action buttons are styled by `.wanted .search-item` in
 * MissingContent.css (which this file imports).
 *
 * Two row shapes (PR 5 of F-08): 'page' is the markup Faltantes has always
 * rendered, 'section' is the chosen prototype's dense row — mini-poster,
 * status pill, quality chip, path — scoped to the master column of the
 * Películas/Series sections by the `variant` prop, never by a global restyle.
 */

/** Movies (Radarr) or episodes/series (Sonarr). */
export type MediaKind = 'movies' | 'episodes'

/** The two lists: the missing queue or the full catalogue. */
export type MediaFilter = 'missing' | 'all'

/** What the caller's tab labels read: the totals of the queries that ran. */
export interface MediaTotals {
  wanted: number
  all: number
}

/**
 * What the master–detail panel is allowed to show about a selected row: only
 * fields the row itself carries. Quality and path are absent on purpose — the
 * listings have no such data, and the panel must not invent any.
 */
export interface MediaDetail {
  title: string
  /** The row's poster, when the row has one. */
  poster?: string
  /** Ordered label/value pairs taken straight from the row. */
  meta: { label: string; value: string }[]
  /** The "descarga pedida" mark, when the row carries one. */
  grab?: string
}

/** A row the caller selected: its identity plus what the panel will show. */
export interface MediaSelection {
  id: number
  detail: MediaDetail
  /** The exact item the overlay modal would open for this row: the section
   *  panel's Releases tab searches it inline (PR 5 of F-08). */
  release: ReleaseSearchItem
}

/** Where the rows live. The Faltantes page keeps the markup it has always
 *  had; the sections render the chosen prototype's dense rows instead. */
export type MediaRowVariant = 'page' | 'section'

interface MediaPaneProps {
  kind: MediaKind
  /** Controlled by the caller: 'wanted' hash keys in Faltantes, the active
   *  sub-view tab in the sections. */
  filter: MediaFilter
  onFilterChange?: (filter: MediaFilter) => void
  /** In the sections the sub-view tabs already are the filter, so the pane
   *  must NOT draw a second set of filter controls there. */
  showFilterButtons?: boolean
  /** Hash namespace for the search text ('wanted' / 'peliculas' / 'series'),
   *  so a search typed on one surface never leaks into another. */
  namespace: string
  /** Controlled selection: `null` when the panel shows nothing. */
  selectedId?: number | null
  onSelect?: (selection: MediaSelection) => void
  /** Reports the query totals so a caller can label its own tabs. */
  onTotalsChange?: (totals: MediaTotals) => void
  /** 'section' renders the prototype's dense rows (mini-poster, status chip,
   *  quality chip, path) inside the master column. Default 'page' keeps the
   *  Faltantes cards/rows byte for byte. */
  variant?: MediaRowVariant
}

const PAGE_SIZE = 50

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

interface ScanItem {
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

/** Estado of a "Todas" card: the exact badge the card itself shows. */
function catalogState(hasFile: boolean, pathExists: boolean): string {
  if (hasFile && pathExists) return '✓ Configurada'
  if (!hasFile) return '✗ Sin archivo'
  return '✗ Ruta no encontrada'
}

function grabOf(item: { grabbed_at?: number | null; grabbed_destination?: string | null }): string | undefined {
  return formatGrabMark(item.grabbed_at, item.grabbed_destination) ?? undefined
}

function pushYear(meta: { label: string; value: string }[], year: number | null): void {
  if (year != null) meta.push({ label: 'Año', value: String(year) })
}

/** Panel data for a movie of the missing queue: the row carries no file, so
 *  its state is the queue it sits in. */
function wantedMovieDetail(movie: WantedMovie): MediaDetail {
  const meta: { label: string; value: string }[] = []
  pushYear(meta, movie.year)
  meta.push({ label: 'Estado', value: 'Falta' })
  return { title: movie.title, poster: movie.remotePoster || undefined, meta, grab: grabOf(movie) }
}

function catalogMovieDetail(movie: AllMovie): MediaDetail {
  const meta: { label: string; value: string }[] = []
  pushYear(meta, movie.year)
  meta.push({ label: 'Estado', value: catalogState(movie.has_file, movie.path_exists) })
  return { title: movie.title, poster: movie.remotePoster || undefined, meta, grab: grabOf(movie) }
}

function wantedEpisodeDetail(ep: WantedEpisode): MediaDetail {
  const s = String(ep.season_number ?? 0).padStart(2, '0')
  const e = String(ep.episode_number ?? 0).padStart(2, '0')
  const meta: { label: string; value: string }[] = [
    { label: 'Episodio', value: `S${s}E${e} · ${ep.title}` },
  ]
  if (ep.air_date) meta.push({ label: 'Emitido', value: ep.air_date.slice(0, 10) })
  meta.push({ label: 'Estado', value: 'Falta' })
  return { title: ep.series_title, meta, grab: grabOf(ep) }
}

function catalogSeriesDetail(series: AllSeries): MediaDetail {
  const meta: { label: string; value: string }[] = []
  pushYear(meta, series.year)
  meta.push({ label: 'Estado', value: catalogState(series.has_file, series.path_exists) })
  if (series.episode_count > 0) {
    meta.push({ label: 'Episodios', value: `${series.episode_file_count}/${series.episode_count} episodios` })
  }
  return { title: series.title, poster: series.remotePoster || undefined, meta, grab: grabOf(series) }
}

/** The release-search item of each row — the SAME object the overlay modal
 *  receives, so the panel's Releases tab searches exactly what the modal
 *  would have opened for that row. */
function wantedMovieRelease(movie: WantedMovie): ReleaseSearchItem {
  return {
    type: 'movie',
    id: movie.id,
    title: movie.title,
    year: movie.year,
    source: 'radarr',
    remotePoster: movie.remotePoster,
    has_file: movie.has_file,
  }
}

function catalogMovieRelease(movie: AllMovie): ReleaseSearchItem {
  return {
    type: 'movie',
    id: movie.id,
    title: movie.title,
    year: movie.year,
    source: 'radarr',
    remotePoster: movie.remotePoster,
    has_file: movie.has_file,
    // The row IS where AllMovie lives, so the panel's has-file block reads the
    // file's own facts from here: its name and languages (both "" / [] when
    // the payload has none — the block degrades instead of inventing), the
    // quality behind the 1080/4K tags, and the path the 3D tag tests against
    // path_3d.
    file_name: movie.file_name,
    languages: movie.languages,
    quality: movie.quality,
    path: movie.path,
  }
}

function wantedEpisodeRelease(ep: WantedEpisode): ReleaseSearchItem {
  return {
    type: 'episode',
    id: ep.id,
    title: ep.title,
    series_title: ep.series_title,
    season_number: ep.season_number,
    episode_number: ep.episode_number,
    date: ep.air_date ? ep.air_date.slice(0, 10) : undefined,
    source: 'sonarr',
    has_file: false,
  }
}

function catalogSeriesRelease(series: AllSeries): ReleaseSearchItem {
  return {
    type: 'episode',
    id: series.id,
    title: series.title,
    series_title: series.title,
    year: series.year,
    source: 'sonarr',
    remotePoster: series.remotePoster,
    has_file: series.has_file,
    // Sonarr's list has NO per-episode file name, languages or quality — so
    // none of them travel and the block says the name is unavailable rather
    // than borrowing an episode's file as if it were the series'. The path
    // does exist, and path_3d membership is the rule PR #113 established for
    // Series, so the 3D tag can still be lit honestly.
    path: series.path,
  }
}

/* ── Section rows (PR 5 of F-08) ───────────────────────────────────────────
 * The chosen prototypes (peliculas-02 / series-04) draw a dense row: a
 * CSS-drawn mini-poster, title + year, a status pill, a quality chip and the
 * path. These build exactly that — and only claims the row's own data can
 * back: a status the listing does not carry is never invented ("Descargando"
 * and "Colocado" appear only when some field says so, and none does; a grab
 * keeps its own honest mark instead).
 */

type PillTone = 'ok' | 'warn' | 'bad'

/** Initials for the mini-poster: first letter of the first two words (one
 *  word → its first two letters). Never an external image. */
function posterInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}

/** A stable hue per title, so two rows never share a gradient by accident. */
function posterHue(title: string): number {
  let hue = 0
  for (let i = 0; i < title.length; i++) hue = (hue * 31 + title.charCodeAt(i)) % 360
  return hue
}

/** A row of the missing queue: it is missing, whatever a grab has done. */
function faltaStatus(): { label: string; tone: PillTone } {
  return { label: 'Falta', tone: 'warn' }
}

/** A row of the catalogue, from the same two facts the panel reports. */
function catalogRowStatus(hasFile: boolean, pathExists: boolean): { label: string; tone: PillTone } {
  if (hasFile && pathExists) return { label: 'En biblioteca', tone: 'ok' }
  if (!hasFile) return { label: 'Sin archivo', tone: 'bad' }
  return { label: 'Ruta no encontrada', tone: 'bad' }
}

/** What `rowProps` puts on a row when the caller selects: pointer, keyboard
 *  and aria-current. `{}` when the caller selects nothing (Faltantes). */
interface RowWiring {
  tabIndex?: number
  'aria-current'?: boolean
  onClick?: () => void
  onKeyDown?: (e: ReactKeyboardEvent) => void
}

interface SectionRowProps {
  /** The row's own classes: wanted-card|wanted-row + is-selectable. The
   *  wanted-* class is what every existing query and style keys on. */
  className: string
  /** Selection wiring from `rowProps` — `{}` when nothing selects. */
  wiring: RowWiring
  title: string
  year?: number | null
  status: { label: string; tone: PillTone }
  /** The quality/class chip, when the row's data carries one (the Calidad
   *  view keeps its own class badge on top of this). */
  chip?: string
  path?: string
  grabbed?: string | null
  grabbedDestination?: string | null
  /** The rest of the second line: episode code + title + date, counts… */
  extra?: ReactNode
  /** Every action the row had — the same buttons, nothing dropped. */
  children: ReactNode
}

/** One prototype-shaped row. Scoped to the sections by construction: this
 *  component only renders when the caller asked for the 'section' variant, so
 *  the Faltantes page's DOM is untouched. */
function SectionRow({
  className,
  wiring,
  title,
  year,
  status,
  chip,
  path,
  grabbed,
  grabbedDestination,
  extra,
  children,
}: SectionRowProps) {
  const hue = posterHue(title)
  return (
    <div className={`sec-row ${className}`} {...wiring}>
      <span
        className="sec-row-poster"
        aria-hidden="true"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 46% 54%), hsl(${hue} 52% 14%))` }}
      >
        {posterInitials(title)}
      </span>
      <span className="sec-row-body">
        <span className="sec-row-top">
          <span className="sec-row-name">{title}</span>
          {year != null && <span className="sec-row-year">{year}</span>}
          <span className="sec-row-state">
            <span className={`sec-pill sec-pill-${status.tone}`}>{status.label}</span>
          </span>
        </span>
        <span className="sec-row-bottom">
          {chip && <span className="sec-q-tag">{chip}</span>}
          {path && <span className="sec-row-path" title={path}>{path}</span>}
          {extra}
          {/* Null means never requested: show nothing, not a dash. */}
          {grabbed && (
            <span className="wanted-grabbed" title={grabbedDestination ?? undefined}>
              {grabbed}
            </span>
          )}
        </span>
      </span>
      <span className="sec-row-actions">{children}</span>
    </div>
  )
}

export function MediaPane({
  kind,
  filter,
  onFilterChange,
  showFilterButtons = false,
  namespace,
  selectedId = null,
  onSelect,
  onTotalsChange,
  variant = 'page',
}: MediaPaneProps) {
  const isMovies = kind === 'movies'
  const isSection = variant === 'section'
  const [scanItem, setScanItem] = useState<ScanItem | null>(null)
  const [releaseSearchItem, setReleaseSearchItem] = useState<ReleaseSearchItem | null>(null)
  const [query, setQuery] = useHashState<string>(namespace, 'q', '')
  const debouncedQuery = useDebouncedValue(query, 350)

  // Sentinel ref for infinite scroll intersection observer
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  // 1. Wanted Movies Infinite Query
  const wantedMoviesQuery = useInfiniteQuery({
    queryKey: ['wanted-movies-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchWantedMovies(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'movies' && filter === 'missing',
  })

  // 2. All Movies Infinite Query
  const allMoviesQuery = useInfiniteQuery({
    queryKey: ['all-movies-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchAllMovies(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'movies' && filter === 'all',
  })

  // 3. Wanted Episodes Infinite Query
  const wantedEpisodesQuery = useInfiniteQuery({
    queryKey: ['wanted-episodes-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchWantedEpisodes(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'episodes' && filter === 'missing',
  })

  // 4. All Series Infinite Query
  const allSeriesQuery = useInfiniteQuery({
    queryKey: ['all-series-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchAllSeries(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'episodes' && filter === 'all',
  })

  // Active query based on current view
  const activeQuery =
    isMovies
      ? (filter === 'missing' ? wantedMoviesQuery : allMoviesQuery)
      : (filter === 'missing' ? wantedEpisodesQuery : allSeriesQuery)

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

  function handleScanForSeries(series: {
    id: number | null
    title: string
    season_number?: number | null
    episode_number?: number | null
    episode_title?: string | null
    air_date?: string | null
  }) {
    if (!series.id) return
    setScanItem({
      type: 'series',
      id: series.id,
      title: series.title,
      source: 'sonarr',
      // Carried through so the modal can identify the episode, not just the series.
      season_number: series.season_number,
      episode_number: series.episode_number,
      episode_title: series.episode_title,
      air_date: series.air_date,
    })
  }

  const wantedTotal =
    (isMovies ? wantedMoviesQuery : wantedEpisodesQuery).data?.pages[0]?.total ?? 0
  const allTotal =
    (isMovies ? allMoviesQuery : allSeriesQuery).data?.pages[0]?.total ?? 0

  // The caller's tab labels read their counts from here. The setter is the
  // caller's own, so an unchanged object is recognised as "nothing new".
  useEffect(() => {
    onTotalsChange?.({ wanted: wantedTotal, all: allTotal })
  }, [wantedTotal, allTotal, onTotalsChange])

  // A failed fetch must never read as "nothing missing": the backend now says
  // WHY it is empty, and that reason has to reach the screen.
  const activeError =
    activeQuery.data?.pages.find((p) => p.error)?.error ?? null

  const allWantedMovies = wantedMoviesQuery.data?.pages.flatMap((p) => p.items) ?? []
  const allCatalogMovies = allMoviesQuery.data?.pages.flatMap((p) => p.items) ?? []
  const allWantedEpisodes = wantedEpisodesQuery.data?.pages.flatMap((p) => p.items) ?? []
  const allCatalogSeries = allSeriesQuery.data?.pages.flatMap((p) => p.items) ?? []

  const serviceName = isMovies ? 'Radarr' : 'Sonarr'
  const searchLabel = isMovies ? 'Filtrar películas' : 'Filtrar series'
  const searchPlaceholder =
    filter === 'missing' ? 'Filtrar faltantes...' : isMovies ? 'Filtrar películas...' : 'Filtrar series...'

  /** Rows only become interactive when the caller asked for a selection, so
   *  the Faltantes page keeps the exact DOM it has today. */
  const selectableClass = onSelect ? ' is-selectable' : ''

  function rowProps(
    id: number,
    makeDetail: () => MediaDetail,
    makeRelease: () => ReleaseSearchItem,
  ): RowWiring {
    if (!onSelect) return {}
    const select = () => onSelect({ id, detail: makeDetail(), release: makeRelease() })
    return {
      tabIndex: 0,
      'aria-current': selectedId === id ? true : undefined,
      onClick: select,
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      },
    }
  }

  /**
   * What the row's search action (🔍) does.
   *
   * In the sections the search lives in the detail panel: the click bubbles
   * to the row, which selects it, and the panel renders its Releases tab for
   * that selection — no modal ever opens per row, which is the whole point of
   * the chosen prototype. Without a panel to drive (the Faltantes page) the
   * overlay opens exactly as it always has.
   */
  function openReleases(item: ReleaseSearchItem) {
    if (isSection && onSelect) return
    setReleaseSearchItem(item)
  }

  return (
    <>
      <div className="wanted-content">
        <div className="wanted-actions">
          <div className="wanted-filter">
            {showFilterButtons && (
              <button
                className={`wanted-filter-btn ${filter === 'missing' ? 'active' : ''}`}
                onClick={() => onFilterChange?.('missing')}
              >
                Faltantes ({wantedTotal})
              </button>
            )}
            {showFilterButtons && (
              <button
                className={`wanted-filter-btn ${filter === 'all' ? 'active' : ''}`}
                onClick={() => onFilterChange?.('all')}
              >
                Todas ({allTotal || '...'})
              </button>
            )}
            <input
              type="search"
              className="wanted-search"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={searchLabel}
            />
          </div>
        </div>

        {filter === 'missing' ? (
          isMovies ? (
            isPending ? (
              <div className="wanted-loading">Cargando películas faltantes...</div>
            ) : allWantedMovies.length > 0 ? (
              <>
                <div className="wanted-grid">
                  {allWantedMovies.map((movie) => {
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
                          onClick={() => handleScanForMovie(movie)}
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
            ) : activeError ? (
              <div className="wanted-error" role="alert">
                <strong>No se pudo consultar {serviceName}</strong>
                <span>{activeError}</span>
              </div>
            ) : (
              <div className="wanted-empty">No hay películas faltantes</div>
            )
          ) : isPending ? (
            <div className="wanted-loading">Cargando episodios faltantes...</div>
          ) : allWantedEpisodes.length > 0 ? (
            <>
              <div className="wanted-list">
                {allWantedEpisodes.map((ep) => {
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
                        onClick={() => handleScanForSeries({
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
          ) : (
            activeError ? (
              <div className="wanted-error" role="alert">
                <strong>No se pudo consultar {serviceName}</strong>
                <span>{activeError}</span>
              </div>
            ) : (
              <div className="wanted-empty">No hay episodios faltantes</div>
            )
          )
        ) : isMovies ? (
          isPending ? (
            <div className="wanted-loading">Cargando catálogo de películas...</div>
          ) : allCatalogMovies.length > 0 ? (
            <>
              <div className="wanted-grid">
                {allCatalogMovies.map((movie) => {
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
                        onClick={() => handleScanForMovie({ id: movie.id, title: movie.title, year: movie.year, overview: '', remotePoster: movie.remotePoster, has_file: movie.has_file, altTitles: [] })}
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
                          () => catalogMovieDetail(movie),
                          () => catalogMovieRelease(movie),
                        )}
                        title={movie.title}
                        year={movie.year}
                        status={catalogRowStatus(movie.has_file, movie.path_exists)}
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
                      className={`wanted-card ${movie.has_file && movie.path_exists ? 'status-ok' : 'status-error'}${grabbed ? ' status-grabbed' : ''}${selectableClass}`}
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
          ) : (
            activeError ? (
              <div className="wanted-error" role="alert">
                <strong>No se pudo consultar {serviceName}</strong>
                <span>{activeError}</span>
              </div>
            ) : (
              <div className="wanted-empty">No hay películas en el catálogo</div>
            )
          )
        ) : isPending ? (
          <div className="wanted-loading">Cargando catálogo de series...</div>
        ) : allCatalogSeries.length > 0 ? (
          <>
            <div className="wanted-grid">
              {allCatalogSeries.map((series) => {
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
                      onClick={() => handleScanForSeries({ id: series.id, title: series.title })}
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
        ) : (
          activeError ? (
            <div className="wanted-error" role="alert">
              <strong>No se pudo consultar {serviceName}</strong>
              <span>{activeError}</span>
            </div>
          ) : (
            <div className="wanted-empty">No hay series en el catálogo</div>
          )
        )}
      </div>

      {scanItem && <ScanModal item={scanItem} onClose={() => setScanItem(null)} />}
      {releaseSearchItem && <ReleaseSearchModal item={releaseSearchItem} onClose={() => setReleaseSearchItem(null)} />}
    </>
  )
}

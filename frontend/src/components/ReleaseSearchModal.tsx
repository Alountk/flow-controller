import { useState, useRef, useCallback, useEffect } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  addCalendarItem,
  fetchCalendarReleases,
  fetchCalendarDestinations,
  grabCalendarRelease,
  grabCalendarReleaseBatch,
  type Release,
} from '../api/calendar'
import { apiFetch } from '../api/auth'
import { areAllVisibleSelected, toggleVisibleSelection } from '../utils/selection'
import { looksThreeD } from '../utils/threeD'
import {
  NO_RELEASE_FILTERS,
  collectLanguages,
  collectQualities,
  filterReleases,
  hasActiveFilters,
  releaseKey,
  toggleInSet,
  type ReleaseFilters,
} from '../utils/releaseFilters'
import './CalendarModal.css'

interface Indexer {
  id: number
  name: string
  implementation: string
  enableSearch: boolean
}

export interface ReleaseSearchItem {
  type: 'movie' | 'episode'
  id: number
  title: string
  source: string // 'radarr' | 'sonarr'
  date?: string
  year?: number | null
  has_file?: boolean
  remotePoster?: string
  series_title?: string | null
  season_number?: number | null
  episode_number?: number | null
}

type ModalStep = 'initial' | 'searching' | 'adding' | 'results' | 'grabbing' | 'done' | 'error'

const SEARCH_TIMEOUT = 240 // seconds — must match backend REQUEST_TIMEOUT * 48

function formatSize(bytes: number): string {
  if (bytes === 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function groupByIndexer(releases: Release[]): Map<string, Release[]> {
  const map = new Map<string, Release[]>()
  for (const r of releases) {
    const key = r.indexer || 'Desconocido'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  return map
}

/**
 * One component, two presentations.
 *
 * Overlay mode is the modal this app has always opened: `onClose` is required
 * and Escape/backdrop/close-button all end the dialog. Panel mode has no
 * dialog to end, so it takes no `onClose` at all — the type makes that
 * impossible to get wrong.
 */
export type ReleaseSearchModalProps = { item: ReleaseSearchItem } & (
  | { presentation?: 'overlay'; onClose: () => void }
  | { presentation: 'panel'; onClose?: undefined }
)

/** Rows that would all land in the same folder, and must travel as one call. */
interface RoutingGroup {
  quality: string
  is3d: boolean
  guids: string[]
}

export function ReleaseSearchModal({
  item,
  onClose,
  presentation = 'overlay',
}: ReleaseSearchModalProps) {
  const inPanel = presentation === 'panel'
  const [step, setStep] = useState<ModalStep>('initial')
  const [message, setMessage] = useState('')
  const [selectedIndexer, setSelectedIndexer] = useState<string>('all')
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set())
  const [destinations, setDestinations] = useState<string[]>([])
  const [destination, setDestination] = useState('')
  const [filters, setFilters] = useState<ReleaseFilters>(NO_RELEASE_FILTERS)
  const [grabErrors, setGrabErrors] = useState<{ guid: string; detail: string }[]>([])
  // Per-row corrections to the 3D suggestion. An absent guid means "no human
  // has spoken, trust the title"; present means "this is what I said".
  const [threeDOverrides, setThreeDOverrides] = useState<Record<string, boolean>>({})
  const [elapsed, setElapsed] = useState(0)
  const modalRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Overlay only: the panel is not a dialog, so it never owns a backdrop or
  // an Escape key — there is nothing for either of them to close.
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose?.()
  }, [onClose])

  useEffect(() => {
    if (inPanel) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, inPanel])

  // Cached per SOURCE. Asking Radarr once must not ask it again a few minutes
  // later, and Sonarr's list is a different list — that separation is the cache
  // key. The previous behaviour (a bare `useEffect` with `.catch(() => {})`)
  // threw the failure away, so a Radarr timeout looked exactly like "there are
  // no indexers": `[]` in, `[]` out, nothing on screen.
  const indexersQuery = useQuery({
    queryKey: ['indexers', item.source],
    queryFn: async () => {
      const res = await apiFetch(`/api/calendar/indexers?source=${item.source}`, {})
      const data = (await res.json()) as { indexers?: Indexer[]; error?: string }
      // The backend reports its own failures in the body, so HTTP 200 can still
      // mean "I could not ask Radarr". Either way this must NOT become an empty
      // list: an empty list means "none configured" and is shown as such.
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return data.indexers ?? []
    },
    staleTime: 5 * 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })
  const indexers = indexersQuery.data ?? []

  // Fetch destination folders on mount. A failed load is not fatal: the combo
  // keeps its built-in library default, so searching and grabbing still work.
  useEffect(() => {
    fetchCalendarDestinations(item.source)
      .then((data) => setDestinations(data.folders))
      .catch(() => {})
  }, [item.source])

  // Timer for loading state
  useEffect(() => {
    if (step === 'searching' || step === 'adding') {
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [step])

  async function handleSearch() {
    setStep('searching')
    setGrabErrors([])
    const idxName = selectedIndexer !== 'all' ? (indexers.find(i => String(i.id) === selectedIndexer)?.name || '') : ''
    setMessage(`Buscando releases${idxName ? ` en ${idxName}` : ' en todos los indexadores'}...`)
    try {
      const result = await fetchCalendarReleases(item.source, item.type, item.id)
      const selectedName = selectedIndexer === 'all'
        ? null
        : indexers.find(i => String(i.id) === selectedIndexer)?.name
      const filtered = selectedIndexer === 'all'
        ? result.releases
        : result.releases.filter(r => r.indexer === selectedName)
      if (filtered.length > 0) {
        setReleases(filtered)
        // A new search is a new list: whatever was corrected against the old
        // rows would otherwise be applied, silently, to different releases.
        setThreeDOverrides({})
        setStep('results')
      } else {
        setStep('error')
        if (selectedIndexer !== 'all' && result.releases.length > 0) {
          const nameFound = indexers.find(i => String(i.id) === selectedIndexer)?.name || selectedIndexer
          setMessage(`${nameFound}: 0 releases encontrados. Hay ${result.releases.length} releases en total en otros indexadores.`)
        } else {
          setMessage(result.detail || 'No se encontraron releases. Verifica que los indexadores estén configurados.')
        }
      }
    } catch (err) {
      setStep('error')
      setMessage(`Error inesperado: ${err}`)
    }
  }

  async function handleAddAndSearch() {
    setStep('adding')
    setMessage('Agregando a biblioteca...')
    try {
      const result = await addCalendarItem(
        item.source,
        item.type,
        item.series_title || item.title,
        item.year ?? undefined,
      )
      if (result.ok && result.id) {
        item.id = result.id
        handleSearch()
      } else {
        setStep('error')
        setMessage(result.detail)
      }
    } catch (err) {
      setStep('error')
      setMessage(`Error inesperado: ${err}`)
    }
  }

  /** What a row actually is: a human correction if there is one, else the suggestion. */
  function isThreeD(r: Release): boolean {
    const override = threeDOverrides[r.guid]
    return override === undefined ? looksThreeD(r.title) : override
  }

  function toggleThreeD(guid: string) {
    const release = releases.find((r) => r.guid === guid)
    if (!release) return
    setThreeDOverrides((prev) => ({ ...prev, [guid]: !isThreeD(release) }))
  }

  async function handleGrab(guid: string) {
    setStep('grabbing')
    setGrabErrors([])
    setMessage('Descargando...')
    const release = releases.find(r => r.guid === guid)
    // An empty `destination` means the arr's library and must stay absent from
    // the request, exactly as it was before the combo existed.
    const result = await grabCalendarRelease(
      item.source,
      guid,
      release?.indexerId || 0,
      item.type === 'movie' ? item.id : 0,
      item.type === 'episode' ? item.id : 0,
      destination || undefined,
      release?.quality || undefined,
      release ? isThreeD(release) : undefined,
    )
    if (result.ok) {
      setStep('done')
      setMessage('Descarga iniciada. Revisa la cola de descargas.')
    } else {
      setStep('error')
      setMessage(result.detail)
    }
  }

  function toggleGuid(guid: string) {
    setSelectedGuids(prev => {
      const next = new Set(prev)
      if (next.has(guid)) {
        next.delete(guid)
      } else {
        next.add(guid)
      }
      return next
    })
  }

  function toggleAll() {
    // Only touches what the filter is showing: acting on hidden rows would
    // download releases the user never looked at.
    setSelectedGuids((prev) => toggleVisibleSelection(prev, visibleReleases, releaseKey))
  }

  /**
   * One call per *routing class*, not one call per batch.
   *
   * `grab-batch` carries a single `quality` and a single `is3d`, so a selection
   * holding two classes has no truthful value for one call — and naming either
   * would send the other to the wrong folder. Sending neither would send a 3D
   * release down the same route as any other: the arr may import it and replace
   * what should have been kept, which is precisely the coexistence failure this
   * feature exists to avoid.
   *
   * When a destination was chosen by hand it already wins server-side, so the
   * split buys nothing and one call is enough.
   */
  function splitByRouting(guids: string[]): RoutingGroup[] {
    if (destination) return [{ quality: '', is3d: false, guids }]
    const groups = new Map<string, RoutingGroup>()
    for (const guid of guids) {
      const release = releases.find((r) => r.guid === guid)
      const is3d = release ? isThreeD(release) : false
      const quality = release?.quality ?? ''
      const key = `${is3d ? '3d' : ''}|${quality}`
      const bucket = groups.get(key)
      if (bucket) bucket.guids.push(guid)
      else groups.set(key, { quality, is3d, guids: [guid] })
    }
    return [...groups.values()]
  }

  async function handleGrabBatch() {
    if (selectedGuids.size === 0) return
    setStep('grabbing')
    setGrabErrors([])
    setMessage(`Descargando ${selectedGuids.size} releases...`)

    let ok = true
    let firstDetail = ''
    let downloaded = 0
    const errors: { guid: string; detail: string }[] = []
    const details: string[] = []

    for (const group of splitByRouting(Array.from(selectedGuids))) {
      const indexerIds = group.guids.map(g => releases.find(r => r.guid === g)?.indexerId || 0)
      const result = await grabCalendarReleaseBatch(
        item.source,
        group.guids,
        indexerIds,
        item.type === 'movie' ? item.id : 0,
        item.type === 'episode' ? item.id : 0,
        destination || undefined,
        group.quality || undefined,
        group.is3d || undefined,
      )
      errors.push(...(result.errors ?? []))
      downloaded += result.downloaded?.length ?? 0
      details.push(result.detail)
      if (!result.ok) {
        ok = false
        if (!firstDetail) firstDetail = result.detail
      }
    }

    setGrabErrors(errors)
    if (ok) {
      setStep('done')
      // One group means one call, so its own wording still reaches the user
      // unchanged; only a split batch needs a summary of its own.
      setMessage(details.length === 1 ? details[0] : `${downloaded} descargados`)
      setSelectedGuids(new Set())
    } else {
      setStep('error')
      setMessage(firstDetail)
    }
  }

  const isProcessing = step === 'searching' || step === 'adding' || step === 'grabbing'

  // Options come from the FULL result set, so they do not vanish as you filter.
  const qualityOptions = collectQualities(releases)
  const languageOptions = collectLanguages(releases)
  const visibleReleases = filterReleases(releases, filters)
  const filtersActive = hasActiveFilters(filters)
  const allVisibleSelected = areAllVisibleSelected(selectedGuids, visibleReleases, releaseKey)
  const isSearching = step === 'searching'

  function formatElapsed(s: number): string {
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  }

  /**
   * Leaving the search. The overlay IS a dialog: it ends through the caller's
   * `onClose`. The panel is not — there is nothing to close — so the search
   * starts over for the same selection instead of vanishing under the user.
   */
  function dismiss() {
    if (inPanel) {
      setStep('initial')
      setMessage('')
      setSelectedGuids(new Set())
      setGrabErrors([])
      return
    }
    onClose?.()
  }

  /** What the exit button reads in each presentation. */
  const dismissLabel = inPanel ? 'Nueva búsqueda' : 'Cerrar'

  // One body, two presentations: the overlay wraps it in modal chrome, the
  // panel renders it as-is inside its container.
  const body = (
        <div className="scan-modal-body">
          {/* Item details — the overlay's own header repeats them; the panel's
              detail header already shows poster, title and metadata. */}
          {!inPanel && (
          <div className="calendar-modal-details">
            {item.remotePoster && (
              <img className="calendar-modal-poster" src={item.remotePoster} alt={item.title} />
            )}
            <div className="calendar-modal-info">
              {item.type === 'episode' ? (
                <>
                  <div className="calendar-modal-title">{item.series_title}</div>
                  <div className="calendar-modal-sub">
                    S{String(item.season_number ?? 0).padStart(2, '0')}E{String(item.episode_number ?? 0).padStart(2, '0')} — {item.title}
                  </div>
                </>
              ) : (
                <div className="calendar-modal-title">
                  {item.title} {item.year && <span className="wanted-year">({item.year})</span>}
                </div>
              )}
              {item.date && (
                <div className="calendar-modal-date">
                  {item.type === 'movie' ? '🗓️ Estreno' : '🗓️ Emisión'}: {item.date}
                </div>
              )}
            </div>
          </div>
          )}

          {/* Indexer selector — only on initial step */}
          {step === 'initial' && (
            <div className="calendar-indexer-select">
              <label className="calendar-indexer-label">Indexador:</label>
              <select
                className="calendar-indexer-dropdown"
                value={selectedIndexer}
                onChange={(e) => setSelectedIndexer(e.target.value)}
              >
                <option value="all">Todos los indexadores</option>
                {indexers.map((idx) => (
                  <option key={idx.id} value={String(idx.id)}>{idx.name}</option>
                ))}
              </select>
              {indexersQuery.isError ? (
                <span className="calendar-indexer-error" role="alert">
                  ⚠️ No se pudo consultar {item.source}:{' '}
                  {indexersQuery.error instanceof Error
                    ? indexersQuery.error.message
                    : 'error desconocido'}
                  <button
                    type="button"
                    className="calendar-indexer-retry"
                    onClick={() => indexersQuery.refetch()}
                  >
                    Reintentar
                  </button>
                </span>
              ) : (
                indexers.length > 0 && (
                  <span className="calendar-indexer-count">{indexers.length} configurados</span>
                )
              )}
            </div>
          )}

          {/* Status message */}
          {(step === 'error' || step === 'done' || step === 'adding') && (
            <div className={`calendar-modal-status ${
              step === 'error' ? 'status-error' : step === 'done' ? 'status-ok' : ''
            }`}>
              <div>{message}</div>
              {grabErrors.length > 0 && (
                <ul className="calendar-error-list">
                  {grabErrors.slice(0, 5).map((err) => (
                    <li key={err.guid}>
                      <span className="calendar-error-detail">{err.detail}</span>
                    </li>
                  ))}
                  {grabErrors.length > 5 && (
                    <li className="calendar-error-more">
                      …y {grabErrors.length - 5} más
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {/* Step: Initial — show buttons */}
          {step === 'initial' && (
            <div className="calendar-modal-actions">
              {item.has_file ? (
                <div className="calendar-modal-info-text">✓ Ya tiene archivo descargado</div>
              ) : (
                <>
                  <button
                    className="action-btn search-all"
                    onClick={handleSearch}
                    disabled={isProcessing}
                  >
                    🔍 Buscar Releases
                  </button>
                  {item.id === 0 && (
                    <button
                      className="action-btn scan-folder-btn"
                      onClick={handleAddAndSearch}
                      disabled={isProcessing}
                    >
                      ➕ Agregar a Biblioteca y Buscar
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step: Searching — show progress */}
          {isSearching && (
            <div className="calendar-modal-progress">
              <div className="progress-spinner"></div>
              <div className="progress-text">
                <span>{message}</span>
                <span className="progress-elapsed">{formatElapsed(elapsed)}</span>
              </div>
              <div className="progress-bar-container">
                <div
                  className="progress-bar"
                  style={{ width: `${Math.max(0, ((SEARCH_TIMEOUT - elapsed) / SEARCH_TIMEOUT) * 100)}%` }}
                />
              </div>
              <div className="progress-hint">
                {elapsed < 30
                  ? 'Los indexadores pueden tardar. Paciencia...'
                  : elapsed < 120
                    ? 'Buscando en indexadores lentos (aMuleTorrent puede tardar)...'
                    : elapsed < 200
                      ? 'Algunos indexadores son muy lentos. Esperando...'
                      : 'Casi se acaba el tiempo...'}
              </div>
            </div>
          )}

          {/* Step: Results — show grouped by indexer */}
          {step === 'results' && (
            <div className="calendar-releases">
              <div className="calendar-releases-header">
                <label className="release-checkbox-all">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    disabled={visibleReleases.length === 0}
                  />
                  <span>
                    {filtersActive
                      ? `${visibleReleases.length} de ${releases.length} releases`
                      : `${releases.length} releases encontrados`}
                  </span>
                </label>
                <div className="calendar-releases-actions">
                  {selectedGuids.size > 0 && (
                    <button className="action-btn grab-selected" onClick={handleGrabBatch} disabled={isProcessing}>
                      ⬇️ Descargar ({selectedGuids.size})
                    </button>
                  )}
                  <button className="action-btn" onClick={handleSearch} disabled={isProcessing}>
                    🔄 Refrescar
                  </button>
                </div>
              </div>

              {/* The chosen folder applies to the marked rows (per-row and batch
                  grabs). The library default sends no destination at all. */}
              <div className="calendar-indexer-select">
                <label className="calendar-indexer-label" htmlFor="release-destination">Destino:</label>
                <select
                  id="release-destination"
                  className="calendar-indexer-dropdown"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">Biblioteca (la del arr)</option>
                  {destinations.map((folder) => (
                    <option key={folder} value={folder}>{folder}</option>
                  ))}
                </select>
              </div>

              <div className="release-filters">
                <input
                  type="text"
                  className="release-filter-text"
                  placeholder="Filtrar por título..."
                  value={filters.text}
                  onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
                />

                <label className="release-filter-seeders">
                  Seeders mín.
                  <input
                    type="number"
                    min={0}
                    value={filters.minSeeders || ''}
                    placeholder="0"
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        minSeeders: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                  />
                </label>

                {qualityOptions.length > 0 && (
                  <div className="release-filter-group">
                    <span className="release-filter-label">Calidad</span>
                    <div className="release-filter-chips">
                      {qualityOptions.map((quality) => (
                        <button
                          key={quality}
                          type="button"
                          className={`release-chip ${filters.qualities.has(quality) ? 'active' : ''}`}
                          onClick={() =>
                            setFilters((f) => ({ ...f, qualities: toggleInSet(f.qualities, quality) }))
                          }
                        >
                          {quality}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {languageOptions.length > 0 && (
                  <div className="release-filter-group">
                    <span className="release-filter-label">Idioma</span>
                    <div className="release-filter-chips">
                      {languageOptions.map((language) => (
                        <button
                          key={language}
                          type="button"
                          className={`release-chip ${filters.languages.has(language) ? 'active' : ''}`}
                          onClick={() =>
                            setFilters((f) => ({ ...f, languages: toggleInSet(f.languages, language) }))
                          }
                        >
                          {language}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {filtersActive && (
                  <button
                    type="button"
                    className="release-filter-clear"
                    onClick={() => setFilters(NO_RELEASE_FILTERS)}
                  >
                    ✕ Limpiar filtros
                  </button>
                )}
              </div>

              {visibleReleases.length === 0 ? (
                <div className="wanted-empty">Ningún release coincide con los filtros</div>
              ) : (
                Array.from(groupByIndexer(visibleReleases).entries()).map(([indexer, items]) => (
                <div key={indexer} className="calendar-indexer-group">
                  <div className="calendar-indexer-name">🌐 {indexer}</div>
                  <div className="calendar-releases-list">
                    {items.map((r) => (
                      <div
                        key={r.guid}
                        className={`calendar-release ${selectedGuids.has(r.guid) ? 'selected' : ''}`}
                      >
                        <label className="release-checkbox">
                          <input
                            type="checkbox"
                            checked={selectedGuids.has(r.guid)}
                            onChange={() => toggleGuid(r.guid)}
                          />
                        </label>
                        <div className="release-content" onClick={() => handleGrab(r.guid)}>
                          <div className="release-title">{r.title}</div>
                          <div className="release-meta">
                            <span className="release-quality">{r.quality}</span>
                            <button
                              type="button"
                              className={`release-3d ${isThreeD(r) ? 'active' : ''}`}
                              aria-pressed={isThreeD(r)}
                              aria-label={
                                isThreeD(r)
                                  ? `Quitar la marca 3D de ${r.title}`
                                  : `Marcar ${r.title} como 3D`
                              }
                              onClick={(e) => {
                                // The row's own click grabs the release; this
                                // button only changes where it would go.
                                e.stopPropagation()
                                toggleThreeD(r.guid)
                              }}
                            >
                              3D
                            </button>
                            <span className="release-size">{formatSize(r.size)}</span>
                            {r.seeders > 0 && (
                              <span className="release-seeders">⬆ {r.seeders} / ⬇ {r.leechers}</span>
                            )}
                            {r.languages && r.languages.length > 0 && (
                              <span className="release-lang">{r.languages.join(', ')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                ))
              )}
            </div>
          )}

          {/* Step: Done */}
          {step === 'done' && (
            <div className="calendar-modal-actions">
              <button className="action-btn search-all" onClick={dismiss}>
                {dismissLabel}
              </button>
            </div>
          )}

          {/* Step: Error — without this the user is stuck after a failed grab */}
          {step === 'error' && (
            <div className="calendar-modal-actions">
              {releases.length > 0 && (
                <button
                  className="action-btn"
                  onClick={() => {
                    setMessage('')
                    setStep('results')
                  }}
                >
                  ← Volver a los resultados
                </button>
              )}
              <button className="action-btn" onClick={dismiss}>
                {dismissLabel}
              </button>
            </div>
          )}
        </div>
  )

  if (inPanel) {
    // Fills its container: no backdrop, no modal chrome, no positioning.
    return <div className="release-inline">{body}</div>
  }

  return (
    <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
      <div className="scan-modal scan-modal-wide" ref={modalRef}>
        <div className="scan-modal-header">
          <div className="scan-selected-info">
            <span className="scan-selected-type">{item.type === 'movie' ? '🎬' : '📺'}</span>
            <strong>{item.series_title || item.title}</strong>
          </div>
          <button className="scan-modal-close" onClick={() => onClose?.()}>×</button>
        </div>
        {body}
      </div>
    </div>
  )
}

// Backward-compatible alias
export const CalendarModal = ReleaseSearchModal

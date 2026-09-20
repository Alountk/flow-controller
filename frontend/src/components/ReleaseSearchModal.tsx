import { useState, useRef, useCallback, useEffect } from 'react'
import {
  addCalendarItem,
  fetchCalendarReleases,
  grabCalendarRelease,
  grabCalendarReleaseBatch,
  type Release,
} from '../api/calendar'
import { areAllVisibleSelected, toggleVisibleSelection } from '../utils/selection'
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

export interface ReleaseSearchModalProps {
  item: ReleaseSearchItem
  onClose: () => void
}

export function ReleaseSearchModal({ item, onClose }: ReleaseSearchModalProps) {
  const [step, setStep] = useState<ModalStep>('initial')
  const [message, setMessage] = useState('')
  const [indexers, setIndexers] = useState<Indexer[]>([])
  const [selectedIndexer, setSelectedIndexer] = useState<string>('all')
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set())
  const [filters, setFilters] = useState<ReleaseFilters>(NO_RELEASE_FILTERS)
  const [grabErrors, setGrabErrors] = useState<{ guid: string; detail: string }[]>([])
  const [elapsed, setElapsed] = useState(0)
  const modalRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Fetch indexers on mount
  useEffect(() => {
    fetch(`/api/calendar/indexers?source=${item.source}`)
      .then((r) => r.json())
      .then((data: { indexers: Indexer[] }) => setIndexers(data.indexers || []))
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

  async function handleGrab(guid: string) {
    setStep('grabbing')
    setGrabErrors([])
    setMessage('Descargando...')
    const release = releases.find(r => r.guid === guid)
    const result = await grabCalendarRelease(
      item.source,
      guid,
      release?.indexerId || 0,
      item.type === 'movie' ? item.id : 0,
      item.type === 'episode' ? item.id : 0,
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

  async function handleGrabBatch() {
    if (selectedGuids.size === 0) return
    setStep('grabbing')
    setGrabErrors([])
    setMessage(`Descargando ${selectedGuids.size} releases...`)
    const guids = Array.from(selectedGuids)
    const indexerIds = guids.map(g => releases.find(r => r.guid === g)?.indexerId || 0)
    const result = await grabCalendarReleaseBatch(
      item.source,
      guids,
      indexerIds,
      item.type === 'movie' ? item.id : 0,
      item.type === 'episode' ? item.id : 0,
    )
    setGrabErrors(result.errors ?? [])
    if (result.ok) {
      setStep('done')
      setMessage(result.detail)
      setSelectedGuids(new Set())
    } else {
      setStep('error')
      setMessage(result.detail)
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

  return (
    <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
      <div className="scan-modal scan-modal-wide" ref={modalRef}>
        <div className="scan-modal-header">
          <div className="scan-selected-info">
            <span className="scan-selected-type">{item.type === 'movie' ? '🎬' : '📺'}</span>
            <strong>{item.series_title || item.title}</strong>
          </div>
          <button className="scan-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="scan-modal-body">
          {/* Item details */}
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
              {indexers.length > 0 && (
                <span className="calendar-indexer-count">{indexers.length} configurados</span>
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
              <button className="action-btn search-all" onClick={onClose}>
                Cerrar
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
              <button className="action-btn" onClick={onClose}>
                Cerrar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Backward-compatible alias
export const CalendarModal = ReleaseSearchModal

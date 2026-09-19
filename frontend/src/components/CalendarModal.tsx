import { useState, useRef, useCallback, useEffect } from 'react'
import type { CalendarItem } from '../types'
import {
  addCalendarItem,
  fetchCalendarReleases,
  grabCalendarRelease,
  type Release,
} from '../api/calendar'

interface Indexer {
  id: number
  name: string
  implementation: string
  enableSearch: boolean
}

type ModalStep = 'initial' | 'searching' | 'adding' | 'results' | 'grabbing' | 'done' | 'error'

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

interface CalendarModalProps {
  item: CalendarItem
  onClose: () => void
}

export function CalendarModal({ item, onClose }: CalendarModalProps) {
  const [step, setStep] = useState<ModalStep>('initial')
  const [message, setMessage] = useState('')
  const [indexers, setIndexers] = useState<Indexer[]>([])
  const [selectedIndexer, setSelectedIndexer] = useState<string>('all')
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null)
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
      .then((data: { indexers: Indexer[] }) => setIndexers(data.indexers))
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
    setMessage(`Buscando releases${selectedIndexer !== 'all' ? ` en ${indexers.find(i => String(i.id) === selectedIndexer)?.name || ''}` : ' en todos los indexadores'}...`)
    try {
      const result = await fetchCalendarReleases(item.source, item.type, item.id)
      const filtered = selectedIndexer === 'all'
        ? result.releases
        : result.releases.filter(r => r.indexer === selectedIndexer)
      if (filtered.length > 0) {
        setReleases(filtered)
        setStep('results')
      } else {
        setStep('error')
        setMessage(result.detail || 'No se encontraron releases. Verifica que los indexadores estén configurados.')
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
    setSelectedGuid(guid)
    setStep('grabbing')
    setMessage('Descargando...')
    const result = await grabCalendarRelease(item.source, guid)
    if (result.ok) {
      setStep('done')
      setMessage('Descarga iniciada. Revisa la cola de descargas.')
    } else {
      setStep('error')
      setMessage(result.detail)
      setSelectedGuid(null)
    }
  }

  const isProcessing = step === 'searching' || step === 'adding' || step === 'grabbing'
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
              <div className="calendar-modal-date">
                {item.type === 'movie' ? '🗓️ Estreno' : '🗓️ Emisión'}: {item.date || 'Desconocida'}
              </div>
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
              {message}
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
                  <button
                    className="action-btn scan-folder-btn"
                    onClick={handleAddAndSearch}
                    disabled={isProcessing}
                  >
                    ➕ Agregar a Biblioteca y Buscar
                  </button>
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
              <div className="progress-hint">
                Los indexadores pueden tardar 1-2 minutos. Puedes cerrar este modal y volver a intentar.
              </div>
            </div>
          )}

          {/* Step: Results — show grouped by indexer */}
          {step === 'results' && (
            <div className="calendar-releases">
              <div className="calendar-releases-header">
                <span>{releases.length} releases encontrados</span>
                <button className="action-btn" onClick={handleSearch} disabled={isProcessing}>
                  🔄 Refrescar
                </button>
              </div>
              {Array.from(groupByIndexer(releases).entries()).map(([indexer, items]) => (
                <div key={indexer} className="calendar-indexer-group">
                  <div className="calendar-indexer-name">🌐 {indexer}</div>
                  <div className="calendar-releases-list">
                    {items.map((r) => (
                      <div
                        key={r.guid}
                        className={`calendar-release ${selectedGuid === r.guid ? 'selected' : ''}`}
                        onClick={() => handleGrab(r.guid)}
                      >
                        <div className="release-title">{r.title}</div>
                        <div className="release-meta">
                          <span className="release-quality">{r.quality}</span>
                          <span className="release-size">{formatSize(r.size)}</span>
                          {r.seeders > 0 && (
                            <span className="release-seeders">⬆ {r.seeders} / ⬇ {r.leechers}</span>
                          )}
                          {r.languages.length > 0 && (
                            <span className="release-lang">{r.languages.join(', ')}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
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
        </div>
      </div>
    </div>
  )
}

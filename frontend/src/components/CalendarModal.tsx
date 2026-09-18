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

type ModalStep = 'initial' | 'loading' | 'results' | 'grabbing' | 'done' | 'error'

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
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

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

  async function handleSearch() {
    setStep('loading')
    setMessage('Buscando releases en indexadores...')
    const result = await fetchCalendarReleases(item.source, item.type, item.id)
    if (result.releases.length > 0) {
      setReleases(result.releases)
      setStep('results')
    } else {
      setStep('error')
      setMessage(result.detail || 'No se encontraron releases. Verifica que los indexadores estén configurados.')
    }
  }

  async function handleAddAndSearch() {
    setStep('loading')
    setMessage('Agregando a biblioteca...')
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

  const isProcessing = step === 'loading' || step === 'grabbing'

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

          {/* Indexers list */}
          {indexers.length > 0 && (
            <div className="calendar-indexers">
              <span className="calendar-indexers-label">Indexadores configurados:</span>
              {indexers.map((idx) => (
                <span key={idx.id} className="calendar-indexer-badge">{idx.name}</span>
              ))}
            </div>
          )}

          {/* Status message */}
          {step !== 'initial' && step !== 'results' && (
            <div className={`calendar-modal-status ${
              step === 'error' ? 'status-error' : step === 'done' ? 'status-ok' : ''
            }`}>
              {message}
            </div>
          )}

          {/* Step 1: Initial — show search button */}
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

          {/* Step: Loading */}
          {step === 'loading' && (
            <div className="calendar-modal-loading">Buscando...</div>
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

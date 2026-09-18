import { useState, useRef, useCallback, useEffect } from 'react'
import type { CalendarItem } from '../types'
import {
  addCalendarItem,
  fetchCalendarReleases,
  grabCalendarRelease,
  type Release,
} from '../api/calendar'

type ModalStatus = 'idle' | 'loading' | 'error' | 'results' | 'grabbing' | 'done'

function formatSize(bytes: number): string {
  if (bytes === 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

interface CalendarModalProps {
  item: CalendarItem
  onClose: () => void
}

export function CalendarModal({ item, onClose }: CalendarModalProps) {
  const [status, setStatus] = useState<ModalStatus>('idle')
  const [message, setMessage] = useState('')
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null)
  const [libraryId, setLibraryId] = useState<number | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // If item is already in library (has an ID from Radarr/Sonarr), fetch releases immediately
  useEffect(() => {
    if (item.id && !item.has_file) {
      handleFetchReleases(item.id)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleFetchReleases(id: number) {
    setStatus('loading')
    setMessage('Buscando releases disponibles...')
    const result = await fetchCalendarReleases(item.source, item.type, id)
    if (result.releases.length > 0) {
      setReleases(result.releases)
      setStatus('results')
      setMessage(`${result.releases.length} releases encontrados`)
    } else {
      setStatus('error')
      setMessage(result.detail || 'No se encontraron releases')
    }
  }

  async function handleAddAndSearch() {
    setStatus('loading')
    setMessage('Agregando a biblioteca...')
    const result = await addCalendarItem(
      item.source,
      item.type,
      item.series_title || item.title,
      item.year ?? undefined,
    )
    if (result.ok && result.id) {
      setLibraryId(result.id)
      handleFetchReleases(result.id)
    } else {
      setStatus('error')
      setMessage(result.detail)
    }
  }

  async function handleGrab(guid: string) {
    setSelectedGuid(guid)
    setStatus('grabbing')
    setMessage('Descargando...')
    const result = await grabCalendarRelease(item.source, guid)
    if (result.ok) {
      setStatus('done')
      setMessage('Descarga iniciada. Aparecerá en la cola de descargas.')
    } else {
      setStatus('error')
      setMessage(result.detail)
      setSelectedGuid(null)
    }
  }

  const isProcessing = status === 'loading' || status === 'grabbing'

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

          {/* Status message */}
          {status !== 'idle' && status !== 'results' && (
            <div className={`calendar-modal-status ${status === 'error' ? 'status-error' : status === 'done' ? 'status-ok' : ''}`}>
              {message}
            </div>
          )}

          {/* Initial actions — show when no releases loaded yet */}
          {status === 'idle' && (
            <div className="calendar-modal-actions">
              <button
                className="action-btn scan-folder-btn"
                onClick={handleAddAndSearch}
                disabled={isProcessing}
              >
                ➕ Agregar y Buscar Releases
              </button>
            </div>
          )}

          {/* Loading */}
          {status === 'loading' && (
            <div className="calendar-modal-loading">Buscando...</div>
          )}

          {/* Releases list */}
          {status === 'results' && (
            <div className="calendar-releases">
              <div className="calendar-releases-header">
                <span className="calendar-releases-count">{releases.length} releases encontrados</span>
              </div>
              <div className="calendar-releases-list">
                {releases.map((r) => (
                  <div
                    key={r.guid}
                    className={`calendar-release ${selectedGuid === r.guid ? 'selected' : ''}`}
                    onClick={() => handleGrab(r.guid)}
                  >
                    <div className="release-title">{r.title}</div>
                    <div className="release-meta">
                      <span className="release-quality">{r.quality}</span>
                      <span className="release-size">{formatSize(r.size)}</span>
                      <span className="release-indexer">{r.indexer}</span>
                      {r.seeders > 0 && (
                        <span className="release-seeders">
                          ⬆ {r.seeders} / ⬇ {r.leechers}
                        </span>
                      )}
                      <span className="release-protocol">{r.protocol}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Done */}
          {status === 'done' && (
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

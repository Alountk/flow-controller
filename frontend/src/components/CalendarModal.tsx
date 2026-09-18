import { useState, useRef, useCallback, useEffect } from 'react'
import type { CalendarItem } from '../types'
import { searchCalendarItem, addCalendarItem } from '../api/calendar'

type ModalStatus = 'idle' | 'searching' | 'adding' | 'done' | 'error'

interface CalendarModalProps {
  item: CalendarItem
  onClose: () => void
}

export function CalendarModal({ item, onClose }: CalendarModalProps) {
  const [status, setStatus] = useState<ModalStatus>('idle')
  const [message, setMessage] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSearch() {
    setStatus('searching')
    setMessage('Buscando en indexadores...')
    const result = await searchCalendarItem(item.source, item.type, item.id)
    if (result.ok) {
      setStatus('done')
      setMessage('Búsqueda completada. El download empezará automáticamente si se encuentra contenido.')
    } else {
      setStatus('error')
      setMessage(result.detail)
    }
  }

  async function handleAddAndSearch() {
    setStatus('adding')
    setMessage('Agregando a biblioteca...')
    const result = await addCalendarItem(
      item.source,
      item.type,
      item.series_title || item.title,
      item.year ?? undefined,
    )
    if (result.ok) {
      setStatus('searching')
      setMessage('Agregado. Buscando en indexadores...')
      const searchResult = await searchCalendarItem(item.source, item.type, result.id || item.id)
      if (searchResult.ok) {
        setStatus('done')
        setMessage('Agregado y búsqueda lanzada. El download empezará automáticamente.')
      } else {
        setStatus('error')
        setMessage(`Agregado pero búsqueda falló: ${searchResult.detail}`)
      }
    } else {
      setStatus('error')
      setMessage(result.detail)
    }
  }

  const isSearching = status === 'searching' || status === 'adding'

  return (
    <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
      <div className="scan-modal" ref={modalRef}>
        <div className="scan-modal-header">
          <div className="scan-selected-info">
            <span className="scan-selected-type">{item.type === 'movie' ? '🎬' : '📺'}</span>
            <strong>{item.series_title || item.title}</strong>
          </div>
          <button className="scan-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="scan-modal-body">
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
                <>
                  <div className="calendar-modal-title">
                    {item.title} {item.year && <span className="wanted-year">({item.year})</span>}
                  </div>
                </>
              )}
              <div className="calendar-modal-date">
                {item.type === 'movie' ? '🗓️ Estreno' : '🗓️ Emisión'}: {item.date || 'Desconocida'}
              </div>
              <div className="calendar-modal-badge">
                {item.type === 'movie' ? '🎬 Película' : '📺 Episodio'}
              </div>
            </div>
          </div>

          {status !== 'idle' && (
            <div className={`calendar-modal-status ${status === 'error' ? 'status-error' : status === 'done' ? 'status-ok' : ''}`}>
              {message}
            </div>
          )}

          <div className="calendar-modal-actions">
            <button
              className="action-btn search-all"
              onClick={handleSearch}
              disabled={isSearching}
            >
              {isSearching ? 'Procesando...' : '🔍 Buscar'}
            </button>
            <button
              className="action-btn scan-folder-btn"
              onClick={handleAddAndSearch}
              disabled={isSearching}
            >
              {isSearching ? 'Procesando...' : '➕ Agregar y Buscar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

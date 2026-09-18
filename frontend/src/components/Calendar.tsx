import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CalendarItem, CalendarResponse } from '../types'
import { CalendarModal } from './CalendarModal'

async function fetchCalendar(start: string, end: string): Promise<CalendarResponse> {
  const res = await fetch(`/api/calendar?start=${start}&end=${end}`)
  return res.json() as Promise<CalendarResponse>
}

function formatDate(d: string): string {
  if (!d) return '?'
  const date = new Date(d + 'T00:00:00')
  return date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
}

function groupByDate(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>()
  for (const item of items) {
    const key = item.date || 'Sin fecha'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(item)
  }
  return map
}

export function Calendar() {
  const [range, setRange] = useState(() => {
    const today = new Date()
    const end = new Date()
    end.setDate(end.getDate() + 30)
    return {
      start: today.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    }
  })
  const [scanItem, setScanItem] = useState<CalendarItem | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['calendar', range.start, range.end],
    queryFn: () => fetchCalendar(range.start, range.end),
  })

  function shiftDays(delta: number) {
    const s = new Date(range.start + 'T00:00:00')
    const e = new Date(range.end + 'T00:00:00')
    s.setDate(s.getDate() + delta)
    e.setDate(e.getDate() + delta)
    setRange({ start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) })
  }

  const grouped = data ? groupByDate(data.items) : new Map()
  const movieCount = data?.items.filter((i) => i.type === 'movie').length ?? 0
  const episodeCount = data?.items.filter((i) => i.type === 'episode').length ?? 0

  return (
    <section className="calendar">
      <div className="calendar-header">
        <h2>Calendario</h2>
        <div className="calendar-nav">
          <button className="action-btn" onClick={() => shiftDays(-7)}>← Semana</button>
          <span className="calendar-range">
            {range.start} — {range.end}
            {data && (
              <span className="calendar-count">
                {' '}· {movieCount} películas · {episodeCount} episodios
              </span>
            )}
          </span>
          <button className="action-btn" onClick={() => shiftDays(7)}>Semana →</button>
        </div>
      </div>

      {isPending ? (
        <div className="wanted-loading">Cargando calendario...</div>
      ) : data && data.items.length > 0 ? (
        <div className="calendar-grid">
          {Array.from(grouped.entries()).map(([date, items]: [string, CalendarItem[]]) => (
            <div key={date} className="calendar-day">
              <div className="calendar-day-header">
                <span className="calendar-day-date">{formatDate(date)}</span>
                <span className="calendar-day-count">{items.length}</span>
              </div>
              <div className="calendar-day-items">
                {items.map((item) => (
                  <div
                    key={`${item.source}-${item.id}`}
                    className={`calendar-card ${item.has_file ? 'status-ok' : 'status-pending'}`}
                    onClick={() => !item.has_file && setScanItem(item)}
                    style={!item.has_file ? { cursor: 'pointer' } : undefined}
                  >
                    {item.remotePoster && (
                      <img className="calendar-poster" src={item.remotePoster} alt={item.title} />
                    )}
                    <div className="calendar-info">
                      {item.type === 'episode' ? (
                        <div className="calendar-title">
                          <span className="calendar-series">{item.series_title}</span>
                          <span className="calendar-ep">
                            S{String(item.season_number ?? 0).padStart(2, '0')}E{String(item.episode_number ?? 0).padStart(2, '0')}
                          </span>
                          <span className="calendar-ep-title">{item.title}</span>
                        </div>
                      ) : (
                        <div className="calendar-title">
                          {item.title}
                          {item.year && <span className="wanted-year"> ({item.year})</span>}
                        </div>
                      )}
                      <div className="calendar-type-badge">
                        {item.type === 'movie' ? '🎬 Película' : '📺 Episodio'}
                        {item.has_file && <span className="badge-ok"> ✓</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="wanted-empty">No hay contenido programado en este rango</div>
      )}

      {scanItem && <CalendarModal item={scanItem} onClose={() => setScanItem(null)} />}
    </section>
  )
}

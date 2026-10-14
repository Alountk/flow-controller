import { useState } from 'react'
import type { ActivityItem } from '../shared/types.ts'
import { formatBytes } from '../shared/utils/text.ts'

interface ActivityTableProps {
  items: ActivityItem[]
  /** Seconds since epoch — the backend's response stamp. */
  updatedAt: number
  onRefresh: () => void
  onOpenSeguimiento: () => void
}

type State = { label: string; tone: 'ok' | 'warn' | 'bad' | 'raw' }

const OK = (label: string): State => ({ label, tone: 'ok' })
const WARN = (label: string): State => ({ label, tone: 'warn' })
const BAD = (label: string): State => ({ label, tone: 'bad' })
/** Unknown state: the raw backend value, never an invented label (S2). */
const RAW = (label: string): State => ({ label, tone: 'raw' })

const DOWNLOAD_STATES: Record<string, State> = {
  downloading: WARN('Descargando'),
  queued: WARN('En cola'),
  paused: WARN('En pausa'),
  importBlocked: BAD('Import bloqueado'),
  failed: BAD('Fallida'),
  downloadFailed: BAD('Fallida'),
}

/** The vocabulary of the operations queue, in Seguimiento's own precedence:
 *  an explicit failure outranks an in-flight import, a pending row is "en
 *  cola" (see Seguimiento's opStatus). */
function stateOf(item: ActivityItem): State {
  if (item.kind === 'operation') {
    if (item.status === 'pending') return WARN('En cola')
    if (item.status === 'failed') return BAD('Fallida')
    if (item.import_status === 'importing') return WARN('Importando')
    if (item.import_status === 'import_failed') return BAD('Import fallido')
    if (item.status === 'done') return OK('Hecha')
    if (item.status === 'running') return WARN('Copiando')
    if (item.status === 'cancelled') return BAD('Cancelada')
    return RAW(item.status || '—')
  }
  const known = DOWNLOAD_STATES[item.status]
  if (known) return known
  return RAW(item.status || '—')
}

const SERVICE_CLASS: Record<string, string> = {
  radarr: 'act-dot-warn',
  sonarr: 'act-dot-accent',
  amutorrent: 'act-dot-neutral',
}

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

/**
 * The dashboard's recent-activity table (Stitch 01, §3). Every cell is a
 * fact the payload carries: an unknown state renders its raw value, a
 * missing destination or size renders an em dash, and the footer counts
 * exactly the rows on screen next to the timestamp of the data itself.
 */
export function ActivityTable({
  items,
  updatedAt,
  onRefresh,
  onOpenSeguimiento,
}: ActivityTableProps) {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items

  return (
    <section className="act-card" aria-label="Actividad reciente">
      <div className="act-toolbar">
        <h3 className="act-title">Actividad reciente de transferencias e indexación</h3>
        <div className="act-tools">
          <input
            className="act-filter"
            type="search"
            aria-label="Filtrar actividad"
            placeholder="Filtrar por nombre…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button type="button" className="act-refresh" onClick={onRefresh}>
            Actualizar
          </button>
        </div>
      </div>

      <div className="act-scroll">
        <table className="act-table">
          <thead>
            <tr>
              <th>Servicio</th>
              <th>Nombre del medio / Release</th>
              <th>Destino / Ruta</th>
              <th className="act-num">Tamaño</th>
              <th>Estado</th>
              <th className="act-end">Acción</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="act-empty">
                  {needle ? 'Sin coincidencias' : 'Sin actividad reciente'}
                </td>
              </tr>
            )}
            {shown.map((item, index) => {
              const state = stateOf(item)
              return (
                <tr key={`${item.kind}-${item.at}-${index}`}>
                  <td>
                    {item.service ? (
                      <span className="act-svc">
                        <span
                          className={`act-dot ${SERVICE_CLASS[item.service] ?? 'act-dot-neutral'}`}
                          aria-hidden="true"
                        />
                        {capitalize(item.service)}
                      </span>
                    ) : (
                      <span>—</span>
                    )}
                  </td>
                  <td className="act-mono">{item.name}</td>
                  <td className="act-mono act-dest">{item.destination ?? '—'}</td>
                  <td className="act-mono act-num">
                    {item.size_bytes > 0 ? formatBytes(item.size_bytes) : '—'}
                  </td>
                  <td>
                    <span className={`act-pill act-${state.tone}`}>{state.label}</span>
                  </td>
                  <td className="act-end">
                    <button type="button" className="act-link" onClick={onOpenSeguimiento}>
                      Ver en Seguimiento
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="act-footer">
        <span>{`Mostrando ${shown.length} transferencias recientes`}</span>
        <span className="act-stamp">{`Actualizado ${new Date(updatedAt * 1000).toLocaleTimeString()}`}</span>
      </div>
    </section>
  )
}

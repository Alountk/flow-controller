import { useMemo, useState } from 'react'
import type {
  ActionKey,
  ActionMeta,
  ActionsResponse,
  Trace,
  TraceResponse,
  TraceStage,
} from '../types'
import { STAGE_LABELS } from '../types'
import { TraceActions } from './TraceActions'

interface Props {
  data: TraceResponse | null
  loading: boolean
  actions: ActionsResponse | null
  onActionDone: () => void
}

const STAGE_ORDER: TraceStage[] = [
  'import_blocked',
  'failed',
  'downloading',
  'importing',
  'downloaded',
  'sent',
]

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diff = Date.now() - then
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'ahora'
  if (mins < 60) return `hace ${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `hace ${hours} h`
  return `hace ${Math.round(hours / 24)} d`
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '—'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

function TraceRow({
  trace,
  meta,
  safeMode,
  onActionDone,
}: {
  trace: Trace
  meta: Record<ActionKey, ActionMeta>
  safeMode: boolean
  onActionDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const { stage, torrent, queue } = trace

  return (
    <>
      <tr
        className={`trace-row stage-${stage}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <td>
          <span className={`trace-stage ${stage}`}>{STAGE_LABELS[stage]}</span>
        </td>
        <td className="trace-source">{trace.source}</td>
        <td className="trace-title" title={trace.title}>
          {trace.title}
        </td>
        <td className="trace-indexer" title={trace.indexer ?? ''}>
          {trace.indexer ?? '—'}
        </td>
        <td className="trace-cat">
          {torrent ? (
            <span className={trace.category_ok ? 'cat-ok' : 'cat-bad'}>
              {torrent.category ?? '—'}
              {trace.category_ok === false && ` (esperada: ${trace.expected_category})`}
            </span>
          ) : (
            <span className="cat-none">—</span>
          )}
        </td>
        <td className="trace-progress">
          {torrent ? `${torrent.progress}%` : '—'}
        </td>
        <td className="trace-time">{relativeTime(trace.date)}</td>
        <td className="trace-actions-cell">
          <TraceActions
            trace={trace}
            meta={meta}
            safeMode={safeMode}
            onDone={onActionDone}
          />
        </td>
        <td className="trace-toggle">{open ? '▾' : '▸'}</td>
      </tr>
      {open && (
        <tr className="trace-detail">
          <td colSpan={9}>
            <div className="trace-detail-grid">
              <div>
                <span className="detail-key">downloadId</span>
                <code>{trace.download_id || '—'}</code>
              </div>
              <div>
                <span className="detail-key">hash aMuTorrent</span>
                <code>{trace.matched_hash ?? 'sin coincidencia'}</code>
              </div>
              <div>
                <span className="detail-key">cliente</span>
                <code>{trace.download_client ?? '—'}</code>
              </div>
              {torrent && (
                <>
                  <div>
                    <span className="detail-key">estado qBit</span>
                    <code>{torrent.state ?? '—'}</code>
                  </div>
                  <div>
                    <span className="detail-key">tamaño</span>
                    <code>{formatSize(torrent.size)}</code>
                  </div>
                  <div className="span-2">
                    <span className="detail-key">ubicación actual</span>
                    <code>{torrent.current_path ?? torrent.save_path ?? '—'}</code>
                  </div>
                  {torrent.current_path && torrent.save_path && torrent.current_path !== torrent.save_path && (
                    <div className="span-2">
                      <span className="detail-key">save_path (contenedor)</span>
                      <code>{torrent.save_path}</code>
                    </div>
                  )}
                </>
              )}
              {trace.destination && (
                <div className="span-2">
                  <span className="detail-key">folder destino</span>
                  <code>{trace.destination}</code>
                </div>
              )}
              {queue && (
                <>
                  <div>
                    <span className="detail-key">import state</span>
                    <code>{queue.state ?? '—'}</code>
                  </div>
                  <div className="span-2">
                    <span className="detail-key">outputPath</span>
                    <code>{queue.output_path ?? '—'}</code>
                  </div>
                  {queue.messages.length > 0 && (
                    <div className="span-3 trace-messages">
                      <span className="detail-key">mensajes</span>
                      {queue.messages.map((m, i) => (
                        <div key={i} className="trace-message">{m}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export function TraceView({ data, loading, actions, onActionDone }: Props) {
  const [filter, setFilter] = useState<'all' | TraceStage>('all')

  const traces = data?.traces ?? []
  const summary = data?.summary

  const actionMeta = useMemo(() => {
    const map = {} as Record<ActionKey, ActionMeta>
    for (const a of actions?.actions ?? []) map[a.key] = a
    return map
  }, [actions])

  const filtered = useMemo(() => {
    const list = filter === 'all' ? traces : traces.filter((t) => t.stage === filter)
    return [...list].sort(
      (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    )
  }, [traces, filter])

  if (!data && loading) {
    return <div className="trace-empty">Cargando trazabilidad…</div>
  }

  return (
    <section className="trace">
      <div className="trace-head">
        <h2>Trazabilidad del flujo</h2>
        <p className="trace-sub">
          Grasps de Radarr/Sonarr correlacionados por <code>downloadId</code> con las
          descargas de aMuTorrent y su estado de import.
        </p>
        {actions?.safe_mode && (
          <p className="trace-safe-note">
            Modo seguro activo: las acciones destructivas (eliminar/blocklist) están
            bloqueadas en el servidor.
          </p>
        )}
      </div>

      {summary && (
        <div className="trace-summary">
          <div className="sum-card">
            <span className="sum-value">{summary.downloading}</span>
            <span className="sum-label">Descargando</span>
          </div>
          <div className="sum-card">
            <span className="sum-value">{summary.downloaded}</span>
            <span className="sum-label">Completadas</span>
          </div>
          <div className={`sum-card ${summary.import_blocked > 0 ? 'warn' : ''}`}>
            <span className="sum-value">{summary.import_blocked}</span>
            <span className="sum-label">Import bloqueado</span>
          </div>
          <div className={`sum-card ${summary.failed > 0 ? 'bad' : ''}`}>
            <span className="sum-value">{summary.failed}</span>
            <span className="sum-label">Fallidas</span>
          </div>
          <div className={`sum-card ${summary.category_mismatches > 0 ? 'warn' : ''}`}>
            <span className="sum-value">{summary.category_mismatches}</span>
            <span className="sum-label">Cat. incorrecta</span>
          </div>
        </div>
      )}

      <div className="trace-filters">
        {(['all', ...STAGE_ORDER] as const).map((s) => {
          const count = s === 'all' ? traces.length : traces.filter((t) => t.stage === s).length
          return (
            <button
              key={s}
              className={`trace-filter ${filter === s ? 'active' : ''}`}
              onClick={() => setFilter(s)}
              disabled={count === 0 && s !== 'all'}
            >
              {s === 'all' ? 'Todas' : STAGE_LABELS[s]}
              <span className="trace-filter-count">{count}</span>
            </button>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="trace-empty">Sin descargas registradas.</div>
      ) : (
        <div className="trace-table-wrap">
          <table className="trace-table">
            <thead>
              <tr>
                <th>Fase</th>
                <th>Origen</th>
                <th>Título</th>
                <th>Indexador</th>
                <th>Categoría</th>
                <th>Progreso</th>
                <th>Fecha</th>
                <th>Acciones</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, i) => (
                <TraceRow
                  key={`${t.source}-${t.download_id}-${i}`}
                  trace={t}
                  meta={actionMeta}
                  safeMode={Boolean(actions?.safe_mode)}
                  onActionDone={onActionDone}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

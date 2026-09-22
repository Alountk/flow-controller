import { useMemo, useState } from 'react'
import type {
  ActionKey,
  ActionMeta,
  ActionsResponse,
  AutoCopyAction,
  AutoCopySweepEntry,
  AutoCopySweepResult,
  Trace,
  TraceResponse,
  TraceStage,
} from '../types'
import { STAGE_LABELS } from '../types'
import { runAutoCopySweep } from '../api/autoCopy'
import { TraceActions } from './TraceActions'
import './TraceView.css'

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

const AUTO_COPY_ACTION_LABELS: Record<AutoCopyAction, string> = {
  copied: 'Copiada',
  proposed: 'Propuesta',
  failed: 'Falló',
}

function AutoCopyErrors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null
  return (
    <div className="auto-copy-errors">
      <span className="auto-copy-errors-label">Errores</span>
      {errors.map((e, i) => (
        <div key={i} className="auto-copy-error">{e}</div>
      ))}
    </div>
  )
}

/**
 * Result of the last sweep, as returned by POST /api/auto-copy/sweep.
 *
 * `safeMode` is the page's `actions.safe_mode` — the same signal the rest of
 * the UI trusts — not a second source read from this response.
 */
function AutoCopyResult({
  result,
  safeMode,
}: {
  result: AutoCopySweepResult
  safeMode: boolean
}) {
  // `counts` can be `{}` in the route's last-resort error body, so read every
  // field defensively instead of trusting the type at runtime.
  const counts = result.counts ?? {}
  const actionable = result.entries.filter(
    (e): e is AutoCopySweepEntry & { action: AutoCopyAction } => e.action !== null,
  )

  if (result.running) {
    // A sweep was already in flight. Showing the zero counts of that refusal
    // would look like "nothing needed doing", which is not what happened.
    return (
      <div className="auto-copy-result">
        <p className="auto-copy-running">
          Ya hay un barrido en curso. Espera a que termine y vuelve a intentarlo.
        </p>
        <AutoCopyErrors errors={result.errors} />
      </div>
    )
  }

  return (
    <div className="auto-copy-result">
      {safeMode && (
        <p className="auto-copy-safe-banner">
          Modo seguro activo: no se ha copiado nada. Lo que sigue es lo que el
          barrido haría.
        </p>
      )}
      <AutoCopyErrors errors={result.errors} />

      {!result.ok ? (
        !result.errors.length && result.detail && (
          <p className="auto-copy-running">{result.detail}</p>
        )
      ) : (
        <>
          <div className="auto-copy-counts">
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.traces ?? 0}</span>
              <span className="auto-copy-count-label">Trazas revisadas</span>
            </div>
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.copied ?? 0}</span>
              <span className="auto-copy-count-label">Copiadas</span>
            </div>
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.proposed ?? 0}</span>
              <span className="auto-copy-count-label">Propuestas</span>
            </div>
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.wait ?? 0}</span>
              <span className="auto-copy-count-label">En espera</span>
            </div>
          </div>

          {actionable.length === 0 ? (
            <p className="auto-copy-empty">
              No hay nada que copiar: ninguna descarga necesita intervención.
            </p>
          ) : (
            <ul className="auto-copy-entries">
              {actionable.map((e, i) => (
                <li key={`${e.source}-${e.key}-${i}`} className="auto-copy-entry">
                  <div className="auto-copy-entry-head">
                    <span className={`auto-copy-badge ${e.action}`}>
                      {AUTO_COPY_ACTION_LABELS[e.action]}
                    </span>
                    <span className="auto-copy-entry-title" title={e.title}>
                      {e.title}
                    </span>
                  </div>
                  <p className="auto-copy-entry-reason">{e.reason}</p>
                  {e.detail && <p className="auto-copy-entry-detail">{e.detail}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

export function TraceView({ data, loading, actions, onActionDone }: Props) {
  const [filter, setFilter] = useState<'all' | TraceStage>('all')
  const [search, setSearch] = useState('')
  const [sweepResult, setSweepResult] = useState<AutoCopySweepResult | null>(null)
  const [sweeping, setSweeping] = useState(false)

  async function runSweep() {
    setSweeping(true)
    try {
      // The api module turns a rejected fetch into a failed summary, so this
      // never throws and the button can never get stuck on "Revisando…".
      setSweepResult(await runAutoCopySweep())
    } finally {
      setSweeping(false)
    }
  }

  const traces = data?.traces ?? []
  const summary = data?.summary

  const actionMeta = useMemo(() => {
    const map = {} as Record<ActionKey, ActionMeta>
    for (const a of actions?.actions ?? []) map[a.key] = a
    return map
  }, [actions])

  const filtered = useMemo(() => {
    let list = filter === 'all' ? traces : traces.filter((t) => t.stage === filter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.download_id.toLowerCase().includes(q) ||
        (t.indexer || '').toLowerCase().includes(q) ||
        (t.source || '').toLowerCase().includes(q)
      )
    }
    return [...list].sort(
      (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    )
  }, [traces, filter, search])

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

      <div className="auto-copy">
        <div className="auto-copy-bar">
          <button
            className="auto-copy-btn"
            onClick={() => void runSweep()}
            disabled={sweeping}
          >
            {sweeping ? 'Revisando…' : 'Revisar descargas'}
          </button>
          <span className="auto-copy-hint">
            Revisa las descargas completadas que Sonarr/Radarr no hayan importado.
          </span>
        </div>
        {sweepResult && (
          <AutoCopyResult result={sweepResult} safeMode={Boolean(actions?.safe_mode)} />
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
        <input
          type="text"
          className="trace-search"
          placeholder="Buscar por título, ID o indexador..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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

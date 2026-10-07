import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { STAGE_LABELS, type Trace, type TraceResponse, type TraceStage } from '../types'
import { queueStatus, type QueueOp } from '../api/files'
import { relativeTime } from '../utils/time'
import './Seguimiento.css'

/**
 * The view chosen in F-09 phase 0 (`seguimiento-02-kanban`): the state IS the
 * column. Four columns answer "¿dónde se corta?" without reading a single
 * card, and the operations queue rides below as a band — those are OUR copy /
 * move jobs, not the arr's downloads, so they never mix into the columns.
 *
 * Phase 1 reads and shows; every action belongs to phase 2. The cards draw
 * only fields `/api/trace` actually carries: no speed, no ETA — the torrent
 * payload does not carry them and a guessed number would be the first lie the
 * screen tells.
 */

interface Props {
  data: TraceResponse | null
  loading: boolean
}

type ColumnKey = 'downloading' | 'importing' | 'blocked' | 'done'

interface Column {
  key: ColumnKey
  label: string
  stages: TraceStage[]
  tone: string
}

const COLUMNS: Column[] = [
  { key: 'downloading', label: 'Descargando', stages: ['downloading'], tone: 'accent' },
  // `downloaded` means "the bytes arrived, the import has not": the operator
  // experiences it as importing, so it shares the column with `importing`.
  { key: 'importing', label: 'Importando', stages: ['downloaded', 'importing'], tone: 'accent' },
  // A failure and a block are both "the flow stopped here": same column, the
  // card's own pill keeps telling them apart (Fallida vs Import bloqueado).
  { key: 'blocked', label: 'Bloqueado', stages: ['import_blocked', 'failed'], tone: 'warn' },
  { key: 'done', label: 'Resuelto', stages: ['sent'], tone: 'ok' },
]

const COLUMN_BY_STAGE: Record<TraceStage, ColumnKey> = {
  downloading: 'downloading',
  downloaded: 'importing',
  importing: 'importing',
  import_blocked: 'blocked',
  failed: 'blocked',
  sent: 'done',
}

function columnOf(stage: TraceStage): ColumnKey {
  return COLUMN_BY_STAGE[stage]
}

/** The path the card shows for where the file is (or ended up). */
function cardPath(trace: Trace): string {
  if (trace.stage === 'sent') {
    return trace.destination ?? trace.queue?.output_path ?? trace.torrent?.current_path ?? ''
  }
  if (trace.stage === 'import_blocked' || trace.stage === 'failed') {
    return trace.queue?.output_path ?? trace.torrent?.content_path ?? trace.torrent?.current_path ?? ''
  }
  return ''
}

function KanbanCard({ trace }: { trace: Trace }) {
  const showBar =
    trace.torrent !== null &&
    (trace.stage === 'downloading' || trace.stage === 'downloaded' || trace.stage === 'importing')
  const reason =
    trace.queue?.messages[0] ??
    (trace.category_ok === false && trace.torrent?.category
      ? `Categoría «${trace.torrent.category}»; se esperaba «${trace.expected_category ?? '—'}»`
      : null)
  const path = cardPath(trace)

  return (
    <article className={`sg-card sg-${columnOf(trace.stage)}`} aria-label={trace.title}>
      <div className="sg-card-top">
        <span className={`sg-svc sg-${trace.source}`}>{trace.source}</span>
        <span className="sg-title" title={trace.title}>
          {trace.title}
        </span>
        <span className="sg-age">{relativeTime(trace.date)}</span>
      </div>
      <div className="sg-card-state">
        <span className={`sg-pill sg-pill-${trace.stage}`}>{STAGE_LABELS[trace.stage]}</span>
        {trace.category_ok === false && (
          <span className="sg-chip sg-chip-warn" title={trace.expected_category ?? undefined}>
            Cat. incorrecta
          </span>
        )}
        {trace.paused && <span className="sg-chip">En pausa</span>}
      </div>
      {showBar && (
        <div
          className="sg-bar"
          role="progressbar"
          aria-valuenow={trace.torrent?.progress ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progreso de ${trace.title}`}
        >
          <i style={{ width: `${trace.torrent?.progress ?? 0}%` }} />
        </div>
      )}
      {showBar && <div className="sg-pct">{trace.torrent?.progress ?? 0}%</div>}
      {reason && <div className="sg-why">{reason}</div>}
      {path && (
        <div className="sg-path" title={path}>
          → {path}
        </div>
      )}
    </article>
  )
}

function opStatusLabel(op: QueueOp): string {
  if (op.status === 'running') return 'en curso'
  if (op.status === 'pending') return 'en cola'
  if (op.status === 'failed') return 'fallida'
  if (op.import_status === 'importing') return 'importando'
  if (op.import_status === 'import_failed') return 'import fallido'
  if (op.status === 'done') return 'hecha'
  return op.status
}

function OpsBand() {
  const { data } = useQuery({
    queryKey: ['queue'],
    queryFn: queueStatus,
    // Same cadence as the queue sidebar: the band and the sidebar observe the
    // same query key, so they can never disagree about the queue's contents.
    refetchInterval: (query) => ((query.state.data?.queue?.length ?? 0) > 0 ? 2000 : 10000),
  })
  const active = data?.queue ?? []
  const recent = (data?.completed ?? []).slice(-5).reverse()

  return (
    <section className="sg-ops" aria-label="Operaciones de la app">
      <h2 className="sg-ops-title">
        Operaciones · cola
        {active.length > 0 && <span className="sg-ops-count">{active.length}</span>}
      </h2>
      {active.length === 0 && recent.length === 0 ? (
        <div className="sg-empty">Sin operaciones</div>
      ) : (
        <>
          {active.map((op) => (
            <div key={op.id} className="sg-op">
              <span className={`sg-op-kind sg-op-${op.type}`}>{op.type === 'copy' ? 'Copiar' : 'Mover'}</span>
              <span className="sg-op-name" title={op.name}>
                {op.name}
              </span>
              <span className="sg-op-progress">
                {op.total_bytes > 0
                  ? `${op.progress}% · ${Math.round(op.copied_bytes / 1024 ** 2)} / ${Math.round(op.total_bytes / 1024 ** 2)} MB`
                  : `${op.progress}%`}
              </span>
              <span className={`sg-op-status ${op.status}`}>{opStatusLabel(op)}</span>
            </div>
          ))}
          {recent.map((op) => (
            <div key={op.id} className="sg-op sg-op-done">
              <span className={`sg-op-kind sg-op-${op.type}`}>{op.type === 'copy' ? 'Copiar' : 'Mover'}</span>
              <span className="sg-op-name" title={op.name}>
                {op.name}
              </span>
              <span className="sg-op-progress" />
              <span className={`sg-op-status ${op.status}`}>{opStatusLabel(op)}</span>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

export function Seguimiento({ data, loading }: Props) {
  const traces = data?.traces ?? []
  const summary = data?.summary

  const grouped = useMemo(() => {
    const map = new Map<ColumnKey, Trace[]>()
    for (const col of COLUMNS) map.set(col.key, [])
    for (const t of traces) map.get(columnOf(t.stage))?.push(t)
    return map
  }, [traces])

  if (!data && loading) {
    return <div className="sg-empty">Cargando seguimiento…</div>
  }

  return (
    <section className="sg">
      <div className="sg-head">
        <h2>Seguimiento de descargas</h2>
        <p className="sg-sub">
          Grabs de Radarr/Sonarr en columnas por estado — el estado <b>es</b> la columna — más la
          cola de operaciones de la app debajo. Las acciones llegan en la fase 2.
        </p>
      </div>

      {summary && (
        <div className="sg-sum">
          <div className="sg-sum-card">
            <span className="sg-sum-value">{summary.downloading}</span>
            <span className="sg-sum-label">Descargando</span>
          </div>
          <div className={`sg-sum-card ${summary.import_blocked > 0 ? 'warn' : ''}`}>
            <span className="sg-sum-value">{summary.import_blocked}</span>
            <span className="sg-sum-label">Import bloqueado</span>
          </div>
          <div className={`sg-sum-card ${summary.failed > 0 ? 'bad' : ''}`}>
            <span className="sg-sum-value">{summary.failed}</span>
            <span className="sg-sum-label">Fallidas</span>
          </div>
          <div className="sg-sum-card">
            <span className="sg-sum-value">{summary.downloaded}</span>
            <span className="sg-sum-label">Completadas</span>
          </div>
          <div className={`sg-sum-card ${summary.category_mismatches > 0 ? 'warn' : ''}`}>
            <span className="sg-sum-value">{summary.category_mismatches}</span>
            <span className="sg-sum-label">Cat. incorrecta</span>
          </div>
        </div>
      )}

      {traces.length === 0 ? (
        <div className="sg-empty">Sin descargas registradas.</div>
      ) : (
        <div className="sg-board">
          {COLUMNS.map((col) => {
            const items = grouped.get(col.key) ?? []
            return (
              <section key={col.key} className="sg-col" data-col={col.key} aria-label={col.label}>
                <header className="sg-col-head">
                  <span className={`sg-dot sg-dot-${col.tone}`} />
                  <span className="sg-col-name">{col.label}</span>
                  <span className="sg-col-count">{items.length}</span>
                </header>
                <div className="sg-col-body">
                  {items.length === 0 ? (
                    <div className="sg-col-empty">—</div>
                  ) : (
                    items.map((t, i) => <KanbanCard key={`${t.download_id}-${i}`} trace={t} />)
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <OpsBand />
    </section>
  )
}

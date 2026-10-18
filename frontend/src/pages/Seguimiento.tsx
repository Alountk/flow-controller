import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  STAGE_LABELS,
  type ActionKey,
  type ActionMeta,
  type ActionsResponse,
  type Trace,
  type TraceResponse,
  type TraceStage,
} from '../shared/types.ts'
import { completeQueueOp, queueCancel, queueStatus, type QueueOp } from '../shared/api/files.ts'
import {
  listTasks,
  cancelTask,
  pauseTask,
  resumeTask,
  type MuxTask,
} from '../shared/api/mixer.ts'
import { formatBytes } from '../shared/utils/text.ts'
import { relativeTime } from '../shared/utils/time.ts'
import { AutoCopyPanel } from '../features/auto-copy/AutoCopyPanel.tsx'
import { TraceActions } from '../features/trace-actions/TraceActions.tsx'
import './Seguimiento.css'

/**
 * S2's unified task list (decision L3: «Vista única con filtros»): ONE list of
 * rows — the arr's downloads (traces), OUR copy / move operations and the
 * mixer's tasks — under filter tabs «Activas (n)» / «Completadas» /
 * «Errores», with one global counter. The board+tail stacking this view
 * carried is gone on purpose: "el nuevo diseño del seguimiento es muy malo,
 * crea mucho ruido y no puedo ver nada" — less panels, one reading.
 *
 * The rows carry the same per-trace actions Trazabilidad offered (that page
 * was their only door until now), the copy queue's cancel and T1/S3's
 * «Marcar como completada», and the mix tasks' pause / resume / cancel —
 * consolidating the bands must lose none of the controls. The auto-copy sweep
 * rides below the list. Every number a row draws comes from the payloads
 * (`/api/trace`, `/api/queue`, `/api/mixer/tasks`) — no speed, no ETA: a
 * guessed number would be the first lie the screen tells.
 *
 * The queue poll is also where the retired QueueSidebar's two duties landed:
 * cancelling an operation and noticing when an operation finished importing
 * (the list invalidation below). The sidebar paid for both with a /api/queue
 * poll every 2-10 s ON EVERY PAGE — the noise this consolidation removes.
 */

interface Props {
  data: TraceResponse | null
  loading: boolean
  /** The app's action catalogue + safe mode — what each row's buttons need. */
  actions: ActionsResponse | null
  /** Called after an action or sweep changed server state; refreshes the data. */
  onActionDone: () => void
}

/** The three filter tabs of decision L3 — a row lives in exactly one. */
type Bucket = 'active' | 'done' | 'error'

/**
 * Trace buckets follow the F-09 columns' semantics (the board's `COLUMNS`
 * map, retired with it): the flow still moving — `downloading` → `downloaded`
 * → `importing` — is Activa; a flow that STOPPED needing the operator —
 * `import_blocked` and `failed`, the old «Bloqueado» column ("the flow
 * stopped here") — is an Error row; `sent` (the old «Resuelto» column) is
 * Completada. The stage pill on each row keeps telling a block from a
 * failure apart inside «Errores».
 */
function traceBucket(stage: TraceStage): Bucket {
  if (stage === 'sent') return 'done'
  if (stage === 'import_blocked' || stage === 'failed') return 'error'
  return 'active'
}

/**
 * Copy buckets are the operation's own `status` (the copy, not its import
 * follow-up): pending/running → Activas, done → Completadas,
 * failed/cancelled → Errores. A status the map does not know is unsettled —
 * it stays in Activas where the operator can still see and override it.
 */
function copyBucket(status: string): Bucket {
  if (status === 'done') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'error'
  return 'active'
}

/** Mix buckets: running/queued/paused → Activas, done → Completadas,
 *  error/cancelled → Errores — same "unsettled stays visible" rule. */
function mixBucket(status: string): Bucket {
  if (status === 'done') return 'done'
  if (status === 'error' || status === 'cancelled') return 'error'
  return 'active'
}

interface TraceRowData {
  kind: 'trace'
  rowKey: string
  bucket: Bucket
  trace: Trace
}

interface CopyRowData {
  kind: 'copy'
  rowKey: string
  bucket: Bucket
  op: QueueOp
  /** From `/api/queue`'s `completed` — settled rows can't be cancelled. */
  archived: boolean
}

interface MixRowData {
  kind: 'mix'
  rowKey: string
  bucket: Bucket
  task: MuxTask
}

type RowData = TraceRowData | CopyRowData | MixRowData

/**
 * The one list S2 is about — and T3's seam: hoisting a just-submitted mix to
 * the top of «Activas» (with its accent border) is a reorder of the rows THIS
 * function returns, keyed by the stable `rowKey`s, never a second list beside
 * it. Order is source-stable and never re-sorted here: traces in payload
 * order, copy operations as the queue sends them (active first, then the last
 * ten settled, newest first), mix tasks in the backend's own order (running
 * first, queued FIFO, terminal last).
 */
function buildRows(
  traces: Trace[],
  queue: { queue: QueueOp[]; completed: QueueOp[] } | undefined,
  mixes: MuxTask[],
): RowData[] {
  const rows: RowData[] = []
  for (const t of traces) {
    rows.push({
      kind: 'trace',
      rowKey: `trace:${t.download_id}`,
      bucket: traceBucket(t.stage),
      trace: t,
    })
  }
  for (const op of queue?.queue ?? []) {
    rows.push({
      kind: 'copy',
      rowKey: `copy:${op.id}`,
      bucket: copyBucket(op.status),
      op,
      archived: false,
    })
  }
  for (const op of (queue?.completed ?? []).slice(-10).reverse()) {
    rows.push({
      kind: 'copy',
      rowKey: `copy:${op.id}`,
      bucket: copyBucket(op.status),
      op,
      archived: true,
    })
  }
  for (const task of mixes) {
    rows.push({
      kind: 'mix',
      rowKey: `mix:${task.task_id}`,
      bucket: mixBucket(task.status),
      task,
    })
  }
  return rows
}

/** The path the row shows for where the file is (or ended up). */
function cardPath(trace: Trace): string {
  if (trace.stage === 'sent') {
    return trace.destination ?? trace.queue?.output_path ?? trace.torrent?.current_path ?? ''
  }
  if (trace.stage === 'import_blocked' || trace.stage === 'failed') {
    return trace.queue?.output_path ?? trace.torrent?.content_path ?? trace.torrent?.current_path ?? ''
  }
  return ''
}

function TraceRow({
  row,
  meta,
  safeMode,
  onDone,
  onDetails,
}: {
  row: TraceRowData
  meta: Record<ActionKey, ActionMeta>
  safeMode: boolean
  onDone: () => void
  /** Opens this row's record in the detail overlay (F-09 phase 2). */
  onDetails: () => void
}) {
  const trace = row.trace
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
    <article className={`sg-row sg-row-trace sg-${row.bucket}`} aria-label={trace.title}>
      <div className="sg-row-main">
        <span className={`sg-svc sg-${trace.source}`}>{trace.source}</span>
        <span className="sg-title" title={trace.title}>
          {trace.title}
        </span>
        <span className={`sg-pill sg-pill-${trace.stage}`}>{STAGE_LABELS[trace.stage]}</span>
        {trace.category_ok === false && (
          <span className="sg-chip sg-chip-warn" title={trace.expected_category ?? undefined}>
            Cat. incorrecta
          </span>
        )}
        {trace.paused && <span className="sg-chip">En pausa</span>}
        {showBar && (
          <div className="sg-row-prog">
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
            <span className="sg-pct">{trace.torrent?.progress ?? 0}%</span>
          </div>
        )}
        <span className="sg-age">{relativeTime(trace.date)}</span>
      </div>
      {reason && <div className="sg-why">{reason}</div>}
      {path && (
        <div className="sg-path" title={path}>
          → {path}
        </div>
      )}
      <div className="sg-row-foot">
        <TraceActions trace={trace} meta={meta} safeMode={safeMode} onDone={onDone} />
        {/* The explicit door to the full record: a control of its own, so it
            never fights TraceActions for the row's clicks and the keyboard
            gets it for free. */}
        <button type="button" className="sg-detail-btn" onClick={onDetails}>
          Ver detalles
        </button>
      </div>
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

function CopyRow({
  row,
  onCancel,
  onComplete,
}: {
  row: CopyRowData
  onCancel: (id: string) => void
  onComplete: (id: string) => void
}) {
  const op = row.op
  return (
    <article className={`sg-row sg-row-copy sg-${row.bucket}`} aria-label={op.name}>
      <div className="sg-row-main">
        <span className={`sg-op-kind sg-op-${op.type}`}>
          {op.type === 'copy' ? 'Copiar' : 'Mover'}
        </span>
        <span className="sg-op-name" title={op.name}>
          {op.name}
        </span>
        <span className={`sg-op-status ${op.status}`}>{opStatusLabel(op)}</span>
        <span className="sg-op-progress">
          {op.total_bytes > 0
            ? `${op.progress}% · ${Math.round(op.copied_bytes / 1024 ** 2)} / ${Math.round(op.total_bytes / 1024 ** 2)} MB`
            : `${op.progress}%`}
        </span>
        {/* The × the retired QueueSidebar carried: only an operation still in
            the live queue can be cancelled. T1/S3's human override (✓) is
            broader: a settled-but-stuck row is exactly its target. */}
        {(op.status === 'running' || op.status === 'pending') && (
          <>
            {!row.archived && (
              <button
                type="button"
                className="sg-op-cancel"
                onClick={() => onCancel(op.id)}
                title="Cancelar operación"
              >
                ×
              </button>
            )}
            <button
              type="button"
              className="sg-op-ok"
              onClick={() => onComplete(op.id)}
              title="Marcar como completada"
              aria-label="Marcar como completada"
            >
              ✓
            </button>
          </>
        )}
      </div>
    </article>
  )
}

/* S11/T13 — the mixer's tasks, once the «Mezclas» band, now rows beside the
 * copy operations. Controls keep TaskList's semantics on the existing
 * endpoints (pause / cancel / resume), and a `queued` row is the waiting
 * state — cancelling one retires it before it ever runs.
 *
 * The active poll IS the progress refresh (S11-3, with or without SSE):
 * ~2 s while any mix is running or queued, ~10 s otherwise, on the shared
 * `['mixer-tasks']` cache every console reads. */

const MIX_STATUS_LABELS: Record<string, string> = {
  queued: 'En cola',
  running: 'En curso',
  paused: 'Pausada',
  done: 'Completada',
  error: 'Error',
  cancelled: 'Cancelada',
  pending: 'Pendiente',
  unknown: 'Desconocida',
}

/** Chip class: an unknown status falls back to the dim `pending` chip. */
function mixChipClass(status: string): string {
  return ['queued', 'running', 'paused', 'done', 'error', 'cancelled'].includes(status)
    ? status
    : 'pending'
}

function MixRow({
  row,
  onPause,
  onResume,
  onCancel,
}: {
  row: MixRowData
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
}) {
  const task = row.task
  return (
    <article
      className={`sg-row sg-row-mix sg-${row.bucket}`}
      aria-label={task.detail || task.task_id}
    >
      <div className="sg-row-main">
        <span className={`mixer-task-status mixer-status-${mixChipClass(task.status)}`}>
          {MIX_STATUS_LABELS[task.status] || task.status}
        </span>
        <span className="sg-mix-detail" title={task.detail}>
          {task.detail}
        </span>
        {task.output_path && (
          <span className="sg-mix-output" title={task.output_path}>
            → {task.output_path.split('/').pop()}
          </span>
        )}
        {(task.status === 'running' || task.status === 'paused') && (
          <div className="sg-row-prog">
            <div className="mixer-progress-bar">
              <div
                className="mixer-progress-fill"
                style={{ width: `${Math.round(task.progress * 100)}%` }}
              />
            </div>
            <span className="mixer-progress-pct">{Math.round(task.progress * 100)}%</span>
          </div>
        )}
        <div className="sg-mix-actions">
          {task.status === 'running' && (
            <>
              <button type="button" className="sg-mix-btn" onClick={() => onPause(task.task_id)}>
                ⏸ Pausar
              </button>
              <button
                type="button"
                className="sg-mix-btn sg-mix-btn-cancel"
                onClick={() => onCancel(task.task_id)}
              >
                ✕ Cancelar tarea
              </button>
            </>
          )}
          {task.status === 'paused' && (
            <>
              <button type="button" className="sg-mix-btn" onClick={() => onResume(task.task_id)}>
                ▶ Reanudar
              </button>
              <button
                type="button"
                className="sg-mix-btn sg-mix-btn-cancel"
                onClick={() => onCancel(task.task_id)}
              >
                ✕ Cancelar tarea
              </button>
            </>
          )}
          {task.status === 'queued' && (
            <button
              type="button"
              className="sg-mix-btn sg-mix-btn-cancel"
              onClick={() => onCancel(task.task_id)}
            >
              ✕ Cancelar tarea
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

/** One `dt`/`dd` row; an absent fact reads `—`, never a guess. */
function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string | number | null | undefined
  /** Machine facts (paths, IDs) read monospace; human labels never do. */
  mono?: boolean
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'sg-det-mono' : undefined}>{value ?? '—'}</dd>
    </>
  )
}

/**
 * F-09 phase 2's "Ver detalles": the full record `/api/trace` carries for one
 * download, resolving the chosen prototype's open question (panel or separate
 * view) in favour of the panel — the maestro–detalle Películas/Series already
 * chose, but overlaid on the unified list instead of re-flowing it.
 *
 * Coexistence is construction, not negotiation: the panel is absolutely
 * positioned INSIDE `.sg-frame`, a sibling of `.sg` — never a row of the
 * list. Opening it changes neither the rows nor the sweep below them (the
 * unit contract pins exactly that), and the list keeps polling underneath
 * and shows again the moment the panel closes.
 *
 * The honesty rule is inherited verbatim: only fields the payload carries —
 * no speed, no ETA, nothing extrapolated. Every field of the retired
 * Trazabilidad's record is here; queue messages appear in full (the row
 * shows only the first).
 *
 * Presentation follows Stitch 05: the title rides IN the header row, the
 * body is three headed groups (General / Ficheros / Bloqueo/Cola) instead
 * of one flat list, and paths/IDs read monospace (`sg-det-mono`, C-06).
 */
function TraceDetailPanel({ trace, onClose }: { trace: Trace; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const torrent = trace.torrent
  const queue = trace.queue
  const messages = queue?.messages ?? []

  return (
    <aside className="sg-det" aria-label={`Detalle de ${trace.title}`}>
      {/* Header zone (Stitch 05): title + stage pill + status chips + close —
          the title lives IN this row, never below it. */}
      <div className="sg-det-head">
        <h3 className="sg-det-title">{trace.title}</h3>
        <span className={`sg-svc sg-${trace.source}`}>{trace.source}</span>
        <span className={`sg-pill sg-pill-${trace.stage}`}>{STAGE_LABELS[trace.stage]}</span>
        {trace.category_ok === false && (
          <span className="sg-chip sg-chip-warn" title={trace.expected_category ?? undefined}>
            Cat. incorrecta
          </span>
        )}
        {trace.paused && <span className="sg-chip">En pausa</span>}
        <button
          type="button"
          className="sg-det-close"
          aria-label="Cerrar detalle"
          onClick={onClose}
          autoFocus
        >
          ×
        </button>
      </div>

      {/* Body in three visible groups (Stitch 05): one flat ~20-row list
          answers nothing — the headings are how the operator scans it. */}
      <section className="sg-det-group">
        <h4 className="sg-det-group-title">General</h4>
        <dl className="sg-det-meta">
          <DetailRow label="Etapa" value={STAGE_LABELS[trace.stage]} />
          <DetailRow label="Fecha" value={trace.date} />
          <DetailRow label="Índice" value={trace.indexer} />
          <DetailRow label="Cliente de descarga" value={trace.download_client} />
          <DetailRow label="Host del cliente" value={trace.download_client_host} />
          <DetailRow label="ID de descarga" value={trace.download_id} mono />
          <DetailRow label="Hash emparejado" value={trace.matched_hash} mono />
          <DetailRow label="Pausa" value={trace.paused ? 'Sí' : 'No'} />
          <dt>Progreso</dt>
          <dd className="sg-det-progress">
            {torrent ? (
              <>
                <div
                  className="sg-bar"
                  role="progressbar"
                  aria-valuenow={torrent.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Progreso de ${trace.title} (detalle)`}
                >
                  <i style={{ width: `${torrent.progress}%` }} />
                </div>
                <span>{torrent.progress}%</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </dl>
      </section>

      <section className="sg-det-group">
        <h4 className="sg-det-group-title">Ficheros</h4>
        <dl className="sg-det-meta">
          {torrent && (
            <>
              <DetailRow label="Estado del torrent" value={torrent.state} />
              <DetailRow label="Categoría" value={torrent.category} />
              <DetailRow label="Tamaño" value={torrent.size === null ? null : formatBytes(torrent.size)} />
              <DetailRow label="Guardado en" value={torrent.save_path} mono />
              <DetailRow label="Ruta actual" value={torrent.current_path} mono />
              <DetailRow label="Contenido" value={torrent.content_path} mono />
            </>
          )}
          <DetailRow label="Destino" value={trace.destination} mono />
          {queue && <DetailRow label="Ruta de salida" value={queue.output_path} mono />}
        </dl>
      </section>

      <section className="sg-det-group">
        <h4 className="sg-det-group-title">Bloqueo/Cola</h4>
        <dl className="sg-det-meta">
          {queue && (
            <>
              <DetailRow label="Estado de la cola" value={queue.state} />
              <DetailRow label="Estado de importación" value={queue.status} />
            </>
          )}
          <DetailRow label="Categoría esperada" value={trace.expected_category} />
          <DetailRow label="ID de cola" value={trace.ids.queue_id} mono />
          <DetailRow label="ID de episodio" value={trace.ids.episode_id} mono />
          <DetailRow label="ID de película" value={trace.ids.movie_id} mono />
          <DetailRow label="ID de serie" value={trace.ids.series_id} mono />
        </dl>
      </section>

      {messages.length > 0 && (
        <div className="sg-det-why">
          <span className="sg-det-why-label">Motivo</span>
          {/* Every message the payload carries, in the order it reported
              them — the row only had room for the first. */}
          <ol className="sg-det-why-list">
            {messages.map((m, i) => (
              <li key={`${i}-${m}`}>{m}</li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  )
}

const TAB_LABELS: Record<Bucket, string> = {
  active: 'Activas',
  done: 'Completadas',
  error: 'Errores',
}

const TAB_EMPTY: Record<Bucket, string> = {
  active: 'Sin tareas activas.',
  done: 'Sin tareas completadas.',
  error: 'Sin tareas con errores.',
}

export function Seguimiento({ data, loading, actions, onActionDone }: Props) {
  const queryClient = useQueryClient()
  const traces = data?.traces ?? []
  const [tab, setTab] = useState<Bucket>('active')

  const queueQuery = useQuery({
    queryKey: ['queue'],
    queryFn: queueStatus,
    // The ONLY queue poll left in the app: it lives on this view alone, not
    // mounted shell-wide like the sidebar's was.
    refetchInterval: (query) => ((query.state.data?.queue?.length ?? 0) > 0 ? 2000 : 10000),
  })

  // S11-3: the mixer poll IS the mix rows' progress refresh (~2 s active,
  // ~10 s idle) on the shared `['mixer-tasks']` cache every console reads.
  const mixerQuery = useQuery({
    queryKey: ['mixer-tasks'],
    queryFn: listTasks,
    refetchInterval: (query) => {
      const tasks = query.state.data?.tasks ?? []
      const active = tasks.some((t) => t.status === 'running' || t.status === 'queued')
      return active ? 2000 : 10000
    },
  })

  const cancelMutation = useMutation({
    mutationFn: queueCancel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  // T1/S3 — the human's override: the copy may be done on disk while the state
  // stayed blocked (dead consumer, stale row after a restart). Flipping it
  // writes BOTH sources of truth server-side; we only refetch the view.
  const completeMutation = useMutation({
    mutationFn: completeQueueOp,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  const mixCancelMut = useMutation({
    mutationFn: cancelTask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] }),
  })
  const mixPauseMut = useMutation({
    mutationFn: pauseTask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] }),
  })
  const mixResumeMut = useMutation({
    mutationFn: resumeTask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] }),
  })

  // Moved from the retired QueueSidebar: once OUR operation reports that the
  // arr imported (or failed to import) what it placed, the grabbed-marks the
  // Faltantes/Biblioteca lists draw are stale. Coverage is honest: this runs
  // while this view is open — the sidebar's answer was a shell-wide poll
  // every 2-10 s, which is exactly the noise being removed. Focus and
  // navigation refetches cover the rest.
  const importedIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const completed = queueQuery.data?.completed ?? []
    let shouldRefresh = false
    for (const op of completed) {
      if (
        !importedIdsRef.current.has(op.id)
        && (op.import_status === 'imported' || op.import_status === 'import_failed')
      ) {
        importedIdsRef.current.add(op.id)
        shouldRefresh = true
      }
    }
    if (shouldRefresh) {
      queryClient.invalidateQueries({ queryKey: ['wanted-movies-infinite'] })
      queryClient.invalidateQueries({ queryKey: ['wanted-episodes-infinite'] })
      queryClient.invalidateQueries({ queryKey: ['all-movies-infinite'] })
      queryClient.invalidateQueries({ queryKey: ['all-series-infinite'] })
      queryClient.invalidateQueries({ queryKey: ['wanted'] })
      queryClient.invalidateQueries({ queryKey: ['all-movies'] })
    }
  }, [queueQuery.data, queryClient])

  const actionMeta = useMemo(() => {
    const map = {} as Record<ActionKey, ActionMeta>
    for (const a of actions?.actions ?? []) map[a.key] = a
    return map
  }, [actions])

  const rows = useMemo(
    () => buildRows(traces, queueQuery.data, mixerQuery.data?.tasks ?? []),
    [traces, queueQuery.data, mixerQuery.data],
  )

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { active: 0, done: 0, error: 0 }
    for (const row of rows) c[row.bucket] += 1
    return c
  }, [rows])

  const visible = rows.filter((row) => row.bucket === tab)

  // Which record the overlay shows, keyed by the download's own id: a poll
  // that reorders rows (a stage change moves them between tabs) must never
  // swap the open panel's content. A record that leaves the payload closes
  // the panel with it — no stale detail of a download that is gone.
  const [detailId, setDetailId] = useState<string | null>(null)
  const detail = detailId === null ? null : traces.find((t) => t.download_id === detailId) ?? null

  if (!data && loading) {
    return <div className="sg-empty">Cargando seguimiento…</div>
  }

  // The top of this page is the task list and nothing else — no in-page
  // header, no summary strip, no board: the retired Trazabilidad must not
  // resurface here. The page title lives in the topbar; the sweep rides below
  // the list.
  //
  // The frame is the overlay's positioned box: 100% of the very content `.sg`
  // takes directly, so opening the panel changes neither the list nor the
  // sweep — the unit contract, held by construction.
  return (
    <div className="sg-frame">
      <section className="sg">
        <div className="sg-tabs" role="tablist" aria-label="Filtrar tareas">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'active'}
            className={`sg-tab${tab === 'active' ? ' sg-tab-on' : ''}`}
            onClick={() => setTab('active')}
          >
            Activas ({counts.active})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'done'}
            className={`sg-tab${tab === 'done' ? ' sg-tab-on' : ''}`}
            onClick={() => setTab('done')}
          >
            Completadas
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'error'}
            className={`sg-tab${tab === 'error' ? ' sg-tab-on' : ''}`}
            onClick={() => setTab('error')}
          >
            Errores
          </button>
          <span className="sg-total">{rows.length === 1 ? '1 tarea' : `${rows.length} tareas`}</span>
        </div>

        <div className="sg-list" role="tabpanel" aria-label={TAB_LABELS[tab]}>
          {rows.length === 0 ? (
            // The whole view is empty (every source, every state): the message
            // the dashboard's "Descargas atascadas" door has always landed on.
            <div className="sg-empty">Sin descargas registradas.</div>
          ) : visible.length === 0 ? (
            <div className="sg-empty">{TAB_EMPTY[tab]}</div>
          ) : (
            visible.map((row) => {
              if (row.kind === 'trace') {
                return (
                  <TraceRow
                    key={row.rowKey}
                    row={row}
                    meta={actionMeta}
                    safeMode={Boolean(actions?.safe_mode)}
                    onDone={onActionDone}
                    onDetails={() => setDetailId(row.trace.download_id)}
                  />
                )
              }
              if (row.kind === 'copy') {
                return (
                  <CopyRow
                    key={row.rowKey}
                    row={row}
                    onCancel={(id) => cancelMutation.mutate(id)}
                    onComplete={(id) => completeMutation.mutate(id)}
                  />
                )
              }
              return (
                <MixRow
                  key={row.rowKey}
                  row={row}
                  onPause={(id) => mixPauseMut.mutate(id)}
                  onResume={(id) => mixResumeMut.mutate(id)}
                  onCancel={(id) => mixCancelMut.mutate(id)}
                />
              )
            })
          )}
        </div>

        {/* The sweep belongs below the reading, not on top of it: the top of
            this page is the task list and nothing else. */}
        <div className="sg-sweep">
          <AutoCopyPanel safeMode={Boolean(actions?.safe_mode)} onDone={onActionDone} />
        </div>
      </section>

      {detail && <TraceDetailPanel trace={detail} onClose={() => setDetailId(null)} />}
    </div>
  )
}

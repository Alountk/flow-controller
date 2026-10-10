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
import { queueCancel, queueStatus, type QueueOp } from '../shared/api/files.ts'
import { formatBytes } from '../shared/utils/text.ts'
import { relativeTime } from '../shared/utils/time.ts'
import { AutoCopyPanel } from '../features/auto-copy/AutoCopyPanel.tsx'
import { TraceActions } from '../features/trace-actions/TraceActions.tsx'
import './Seguimiento.css'

/**
 * The view chosen in F-09 phase 0 (`seguimiento-02-kanban`): the state IS the
 * column. Four columns answer "¿dónde se corta?" without reading a single
 * card, and the operations queue rides below as a band — those are OUR copy /
 * move jobs, not the arr's downloads, so they never mix into the columns.
 *
 * The cards carry the same per-trace actions Trazabilidad offered (that page
 * was their only door until now) and the auto-copy sweep moved in with the
 * panel — retiring the old view must lose nothing. Phase 2's new actions
 * landed here: cancel a download (on the card) and the full item detail —
 * the "Ver detalles" overlay on the operations tail. Cards and panel both
 * draw only fields `/api/trace` actually carries: no speed, no ETA — the
 * torrent payload does not carry them and a guessed number would be the
 * first lie the screen tells.
 *
 * The operations band is also where the retired QueueSidebar's two duties
 * landed: cancelling an operation (the × on an active row) and noticing when
 * an operation finished importing (the list invalidation below). The sidebar
 * paid for both with a /api/queue poll every 2-10 s ON EVERY PAGE — the noise
 * this consolidation removes.
 */

interface Props {
  data: TraceResponse | null
  loading: boolean
  /** The app's action catalogue + safe mode — what each card's buttons need. */
  actions: ActionsResponse | null
  /** Called after an action or sweep changed server state; refreshes the data. */
  onActionDone: () => void
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

function KanbanCard({
  trace,
  meta,
  safeMode,
  onDone,
  onDetails,
}: {
  trace: Trace
  meta: Record<ActionKey, ActionMeta>
  safeMode: boolean
  onDone: () => void
  /** Opens this card's record in the detail overlay (F-09 phase 2). */
  onDetails: () => void
}) {
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
      <TraceActions trace={trace} meta={meta} safeMode={safeMode} onDone={onDone} />
      {/* The explicit door to the full record: a control of its own, so it
          never fights TraceActions for the card's clicks and the keyboard
          gets it for free. */}
      <div className="sg-card-foot">
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

function OpsBand({ safeMode, onDone }: { safeMode: boolean; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['queue'],
    queryFn: queueStatus,
    // The ONLY queue poll left in the app: it lives on this view alone, not
    // mounted shell-wide like the sidebar's was.
    refetchInterval: (query) => ((query.state.data?.queue?.length ?? 0) > 0 ? 2000 : 10000),
  })
  const active = data?.queue ?? []
  const recent = (data?.completed ?? []).slice(-10).reverse()

  const cancelMutation = useMutation({
    mutationFn: queueCancel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  // Moved from the retired QueueSidebar: once OUR operation reports that the
  // arr imported (or failed to import) what it placed, the grabbed-marks the
  // Faltantes/Biblioteca lists draw are stale. Coverage is honest: this runs
  // while this view is open — the sidebar's answer was a shell-wide poll
  // every 2-10 s, which is exactly the noise being removed. Focus and
  // navigation refetches cover the rest.
  const importedIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const completed = data?.completed ?? []
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
  }, [data, queryClient])

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
              {(op.status === 'running' || op.status === 'pending') && (
                <button
                  type="button"
                  className="sg-op-cancel"
                  onClick={() => cancelMutation.mutate(op.id)}
                  title="Cancelar operación"
                >
                  ×
                </button>
              )}
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

      <div className="sg-ops-rule" />
      {/* The sweep belongs with the app's operations, not on top of the board:
          the top of this page is the kanban and nothing else. */}
      <AutoCopyPanel safeMode={safeMode} onDone={onDone} />
    </section>
  )
}

/** One `dt`/`dd` row; an absent fact reads `—`, never a guess. */
function DetailRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </>
  )
}

/**
 * F-09 phase 2's "Ver detalles": the full record `/api/trace` carries for one
 * download, resolving the chosen prototype's open question (panel or separate
 * view) in favour of the panel — the maestro–detalle Películas/Series already
 * chose, but overlaid on the operations tail instead of re-flowing the grid.
 *
 * Coexistence is construction, not negotiation: the panel is absolutely
 * positioned INSIDE `.sg-frame`, a sibling of `.sg` — never a child of it.
 * The e2e pins `.sg` to exactly [sg-board, sg-ops] and measures the 70/30
 * split plus board-only scroll on those two boxes (kanban-fit.spec.ts), so
 * an extra flex child would rewrite that contract the moment the panel
 * opened. The overlay covers the tail's 30% zone; the tail keeps polling
 * underneath and shows again the moment the panel closes.
 *
 * The honesty rule is inherited verbatim: only fields the payload carries —
 * no speed, no ETA, nothing extrapolated. Every field of the retired
 * Trazabilidad's record is here; queue messages appear in full (the card
 * shows only the first).
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
      <div className="sg-det-head">
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

      <h3 className="sg-det-title">{trace.title}</h3>

      <dl className="sg-det-meta">
        <DetailRow label="Etapa" value={STAGE_LABELS[trace.stage]} />
        <DetailRow label="Fecha" value={trace.date} />
        <DetailRow label="Índice" value={trace.indexer} />
        <DetailRow label="Cliente de descarga" value={trace.download_client} />
        <DetailRow label="Host del cliente" value={trace.download_client_host} />
        <DetailRow label="ID de descarga" value={trace.download_id} />
        <DetailRow label="Hash emparejado" value={trace.matched_hash} />
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
        {torrent && (
          <>
            <DetailRow label="Estado del torrent" value={torrent.state} />
            <DetailRow label="Categoría" value={torrent.category} />
            <DetailRow label="Tamaño" value={torrent.size === null ? null : formatBytes(torrent.size)} />
            <DetailRow label="Guardado en" value={torrent.save_path} />
            <DetailRow label="Ruta actual" value={torrent.current_path} />
            <DetailRow label="Contenido" value={torrent.content_path} />
          </>
        )}
        <DetailRow label="Categoría esperada" value={trace.expected_category} />
        <DetailRow label="Destino" value={trace.destination} />
        {queue && (
          <>
            <DetailRow label="Estado de la cola" value={queue.state} />
            <DetailRow label="Estado de importación" value={queue.status} />
            <DetailRow label="Ruta de salida" value={queue.output_path} />
          </>
        )}
        <DetailRow label="ID de cola" value={trace.ids.queue_id} />
        <DetailRow label="ID de episodio" value={trace.ids.episode_id} />
        <DetailRow label="ID de película" value={trace.ids.movie_id} />
        <DetailRow label="ID de serie" value={trace.ids.series_id} />
      </dl>

      {messages.length > 0 && (
        <div className="sg-det-why">
          <span className="sg-det-why-label">Motivo</span>
          {messages.map((m, i) => (
            <p key={`${i}-${m}`}>{m}</p>
          ))}
        </div>
      )}
    </aside>
  )
}

export function Seguimiento({ data, loading, actions, onActionDone }: Props) {
  const traces = data?.traces ?? []

  const actionMeta = useMemo(() => {
    const map = {} as Record<ActionKey, ActionMeta>
    for (const a of actions?.actions ?? []) map[a.key] = a
    return map
  }, [actions])

  const grouped = useMemo(() => {
    const map = new Map<ColumnKey, Trace[]>()
    for (const col of COLUMNS) map.set(col.key, [])
    for (const t of traces) map.get(columnOf(t.stage))?.push(t)
    return map
  }, [traces])

  // Which record the overlay shows, keyed by the download's own id: a poll
  // that reorders cards (a stage change moves them between columns) must
  // never swap the open panel's content. A record that leaves the payload
  // closes the panel with it — no stale detail of a download that is gone.
  const [detailId, setDetailId] = useState<string | null>(null)
  const detail = detailId === null ? null : traces.find((t) => t.download_id === detailId) ?? null

  if (!data && loading) {
    return <div className="sg-empty">Cargando seguimiento…</div>
  }

  // Only the board on top — no in-page header, no summary strip, no sweep
  // block: the top of the retired Trazabilidad must not resurface here. The
  // page title lives in the topbar; the sweep rides in the operations tail.
  //
  // The frame is the overlay's positioned box: 100% of the very content
  // `.sg` took directly before, so `.sg` keeps EXACTLY its two children
  // (sg-board, sg-ops) and its 70/30 geometry whether the panel is open or
  // closed — the e2e contract, unchanged by construction.
  return (
    <div className="sg-frame">
      <section className="sg">
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
                      items.map((t, i) => (
                        <KanbanCard
                          key={`${t.download_id}-${i}`}
                          trace={t}
                          meta={actionMeta}
                          safeMode={Boolean(actions?.safe_mode)}
                          onDone={onActionDone}
                          onDetails={() => setDetailId(t.download_id)}
                        />
                      ))
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}

        <OpsBand
          safeMode={Boolean(actions?.safe_mode)}
          onDone={onActionDone}
        />
      </section>

      {detail && <TraceDetailPanel trace={detail} onClose={() => setDetailId(null)} />}
    </div>
  )
}

import '../../shared/ui/atoms.css'
import '../../shared/ui/modal.css'
import { useState, useEffect, useContext, useRef, type ReactNode } from 'react'
import { useDialog } from '../../shared/hooks/useDialog.ts'
import { useQuery } from '@tanstack/react-query'
import type { ActionKey, ActionMeta, ActionResult, Trace } from '../../shared/types.ts'
import { runAction, type ActionOptions } from '../../shared/api/actions.ts'
import { ackBlockedImport } from '../../shared/api/traces.ts'
import { apiFetch } from '../../shared/api/auth.ts'
import { EventStreamContext } from '../../shared/hooks/useEventStream.ts'
import { slug } from '../../shared/utils/slug.ts'
import { toast } from '../../shared/utils/toast.ts'
import { formatBytes as formatSize } from '../../shared/utils/text.ts'
import { Icon } from '../../shared/ui/Icon.tsx'
import type { IconName } from '../../shared/ui/iconPaths.ts'
import './TraceActions.css'

interface Props {
  trace: Trace
  meta: Record<ActionKey, ActionMeta>
  safeMode: boolean
  onDone: () => void
  /** The running copy: the row feeds its own progress bar with it. */
  onCopyTask?: (task: TaskProgress | null) => void
}

export interface TaskProgress {
  task_id: string
  src_path: string
  dst_path: string
  status: string
  copied_bytes: number
  total_bytes: number
  files_done: number
  files_total: number
  detail: string
}

interface Pending {
  action: ActionKey
  options: ActionOptions
}

// S2: the visible label text is the id/name source — one string, so both cannot drift.
const HOST_LABEL = 'Host del cliente de descargas'
const HOST_ID = slug(HOST_LABEL)
const REMOTE_LABEL = 'Ruta remota (dentro del contenedor del cliente)'
const REMOTE_ID = slug(REMOTE_LABEL)
const LOCAL_LABEL = 'Ruta local (dentro del contenedor del *arr)'
const LOCAL_ID = slug(LOCAL_LABEL)
const confirmOptionText = (action: ActionKey) =>
  action === 'remove_queue'
    ? 'Añadir a la blocklist (no volver a descargar)'
    : 'Eliminar también los archivos descargados'
const confirmOptionId = (action: ActionKey) => slug(confirmOptionText(action))

/** Why an action failed, in one line. */
function failureText(res: ActionResult): string {
  return res.error ?? (res.steps ?? []).map((s) => `${s.target}: ${s.detail}`).join(' · ')
}

function derivePathMapping(trace: Trace) {
  const host = trace.download_client_host || ''
  const output = trace.queue?.output_path || ''
  const remote_path = output.substring(0, output.lastIndexOf('/')) || ''
  // No local_path on purpose: the backend owns the container→host translation
  // (_VOLUME_MAP). Pre-filling it here with the download client's own namespace
  // produced a self-mapping (/downloads/incoming → /downloads/incoming) that
  // fixed nothing and stayed in the arr. An empty field lets the user override
  // it; otherwise the backend resolves it.
  return { host, remote_path }
}

const ACTION_ICONS: Partial<Record<ActionKey, IconName>> = {
  pause: 'pause',
  resume: 'play_arrow',
  retry_import: 'sync',
  research: 'search',
  copy_files: 'content_copy',
  cancel_download: 'close',
  remove_queue: 'delete',
  delete_torrent: 'delete',
  fix_category: 'label',
  fix_path_mapping: 'cable',
}

function actionsFor(trace: Trace): ActionKey[] {
  const list: ActionKey[] = []
  const hasHash = Boolean(trace.matched_hash)
  const queueId = trace.ids.queue_id
  const hasTarget = trace.source === 'sonarr' ? trace.ids.episode_id : trace.ids.movie_id

  switch (trace.stage) {
    case 'import_blocked':
      if (hasHash && trace.category_ok === false) list.push('fix_category')
      // No `queueId` guard on purpose, unlike `remove_queue` below: this action
      // sends ProcessMonitoredDownloads, a command with NO arguments, so it uses
      // no id. Guarding it on the id hid the button exactly when the arr queue
      // item was gone and the retry was most needed. Do not "restore" the guard.
      list.push('retry_import')
      if (trace.queue?.output_path) list.push('copy_files')
      if (trace.queue?.output_path) list.push('fix_path_mapping')
      if (hasTarget) list.push('research')
      if (queueId) list.push('remove_queue')
      break
    case 'downloaded':
      if (hasHash && trace.category_ok === false) list.push('fix_category')
      list.push('retry_import')
      if (trace.torrent?.content_path) list.push('copy_files')
      if (hasTarget) list.push('research')
      if (hasHash) list.push('delete_torrent')
      break
    case 'importing':
      list.push('retry_import')
      break
    case 'failed':
      if (hasTarget) list.push('research')
      if (queueId) list.push('remove_queue')
      if (hasHash) list.push('delete_torrent')
      break
    case 'downloading':
      if (hasHash) list.push(trace.paused ? 'resume' : 'pause')
      // Pause is reversible; cancelling is the one that stops the download
      // for good — and until now nothing on a downloading trace could.
      if (hasHash) list.push('cancel_download')
      if (hasTarget) list.push('research')
      break
    case 'sent':
      if (hasTarget) list.push('research')
      if (queueId) list.push('remove_queue')
      break
  }
  return list
}

function optionsFor(action: ActionKey, trace: Trace): ActionOptions | null {
  if (action === 'remove_queue') return { blocklist: true }
  if (action === 'delete_torrent') return { delete_files: true }
  if (action === 'cancel_download') return { delete_files: true }
  if (action === 'fix_path_mapping') return derivePathMapping(trace)
  if (action === 'copy_files') {
    const src = trace.torrent?.content_path || trace.torrent?.current_path || trace.queue?.output_path || ''
    return { output_path: src }
  }
  return null
}

const TERMINAL_STATUSES = ['imported', 'renamed_needed', 'import_timeout', 'error', 'cancelled']
const ACTIVE_STATUSES = ['running', 'done', 'importing', 'renamed_needed']

export function TraceActions({ trace, meta, safeMode, onDone, onCopyTask }: Props) {
  // B1: while the SSE stream is connected, copy-task events replace the poll
  // below (`refetchInterval` → false); a disconnect wakes it back up.
  const { connected } = useContext(EventStreamContext)
  const [pending, setPending] = useState<Pending | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [acking, setAcking] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [copyTask, setCopyTask] = useState<TaskProgress | null>(null)

  const keys = actionsFor(trace)

  useEffect(() => {
    onCopyTask?.(copyTask)
  }, [copyTask, onCopyTask])

  const { data: taskData } = useQuery({
    queryKey: ['task', copyTask?.task_id],
    queryFn: async () => {
      const res = await apiFetch(`/api/tasks/${copyTask!.task_id}`, {})
      return res.json() as Promise<{ ok: boolean } & TaskProgress>
    },
    enabled: !!copyTask && ACTIVE_STATUSES.includes(copyTask.status),
    refetchInterval: connected ? false : (query) => {
      const data = query.state.data as ({ ok: boolean } & TaskProgress) | undefined
      if (!data) return 1500
      if (TERMINAL_STATUSES.includes(data.status)) return false
      return 1500
    },
  })

  useEffect(() => {
    if (!taskData || !copyTask) return
    if (!taskData.ok) {
      setCopyTask(null)
      setResult({ ok: false, error: taskData.detail || 'Error obteniendo estado de tarea' })
      return
    }
    setCopyTask((prev) => prev ? { ...prev, ...taskData } : null)
    if (taskData.status === 'imported' || taskData.status === 'renamed_needed') {
      setCopyTask(null)
      setResult({ ok: true, steps: [{ target: 'filesystem', ok: true, detail: taskData.detail }] })
      onDone()
    } else if (taskData.status === 'import_timeout' || taskData.status === 'error') {
      setCopyTask(null)
      setResult({ ok: false, error: taskData.detail })
      if (taskData.status === 'import_timeout') onDone()
    } else if (taskData.status === 'cancelled') {
      setCopyTask(null)
      setResult({ ok: false, error: taskData.detail || 'Copia cancelada' })
      onDone()
    }
  }, [taskData, copyTask, onDone])

  // A success fades on its own; a failure stays until it is closed, so the
  // reason is still there when the operator looks back at the row.
  useEffect(() => {
    if (!result || !result.ok) return
    const t = setTimeout(() => setResult(null), 4000)
    return () => clearTimeout(t)
  }, [result])

  async function execute(action: ActionKey, options: ActionOptions) {
    // The confirmation closes at once: the row's busy button is the feedback
    // while the server resolves the destination, not a dialog that looks stuck.
    setPending(null)
    setBusy(action)
    setResult(null)
    try {
      const res = await runAction(action, trace, options)
      if (action === 'copy_files' && res.ok && 'task_id' in res) {
        const r = res as unknown as { task_id: string; src_path: string; dst_path: string }
        setCopyTask({
          task_id: r.task_id,
          src_path: r.src_path,
          dst_path: r.dst_path,
          status: 'running',
          copied_bytes: 0,
          total_bytes: 0,
          files_done: 0,
          files_total: 0,
          detail: 'iniciando...',
        })
      } else {
        setResult(res)
        if (res.ok) onDone()
        else toast(failureText(res), 'error')
      }
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message })
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
      setPending(null)
    }
  }

  function handleClick(action: ActionKey) {
    // A finished or blocked download: look at the destination before moving
    // anything — the file may already be there (Jellyfin sees it, or it is an
    // upgrade over a copy already in the library) and copying is moot.
    const settled = trace.stage === 'downloaded' || trace.stage === 'import_blocked'
    if (action === 'copy_files' && settled && trace.destination) {
      setChecking(true)
      return
    }
    const opts = optionsFor(action, trace)
    if (opts) {
      setPending({ action, options: opts })
    } else {
      void execute(action, {})
    }
  }

  /**
   * C-02 "limpiar": one click, no modal — the action records an
   * acknowledgement, it changes nothing on the arr, so there is nothing to
   * confirm. Success is NOT reported in a banner: `onDone` refetches the
   * board and the card leaves the column, which is the only feedback that
   * cannot lie about what happened. A refusal comes back as the same
   * `ActionResult` banner the actions use.
   */
  async function clearBlocked(settled = false) {
    setAcking(true)
    setResult(null)
    try {
      const res = await ackBlockedImport(trace, settled)
      if (res.ok) {
        onDone()
      } else {
        setResult(res)
      }
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message })
    } finally {
      setAcking(false)
    }
  }

  async function cancelTask() {
    if (!copyTask) return
    try {
      await apiFetch(`/api/tasks/${copyTask.task_id}/cancel`, { method: 'POST' })
    } catch {
      // Will be handled by polling
    }
  }

  // Nothing this card can offer (no key survived the catalogue, and no
  // leftover result to show): an empty bar inside a kanban card would be
  // padding that explains itself to nobody.
  const anyButton = keys.some((k) => Boolean(meta[k]))
  if (!anyButton && !result && !copyTask && !pending) return null

  return (
    <div className="trace-actions" onClick={(e) => e.stopPropagation()}>
      {keys.map((key) => {
        const m = meta[key]
        if (!m) return null
        const blocked = safeMode && m.destructive
        return (
          <button
            key={key}
            className={`action-btn${m.destructive ? ' destructive' : ''}${busy === key ? ' is-busy' : ''}`}
            title={blocked ? `${m.description} (bloqueada por modo seguro)` : m.description}
            aria-label={m.label}
            disabled={busy !== null || blocked || copyTask !== null}
            onClick={() => handleClick(key)}
          >
            {busy === key ? (
              <span className="action-spinner" aria-hidden="true" />
            ) : (
              ACTION_ICONS[key] && <Icon name={ACTION_ICONS[key]} size={14} />
            )}
            {busy === key ? 'Procesando…' : m.label}
          </button>
        )
      })}

      {/* C-02's "limpiar": NOT in the server catalogue — the catalogue is
          arr-command material (config.ACTIONS) and this is view state about
          a trace. Gated on the stage so only the blocked card offers it. */}
      {trace.stage === 'import_blocked' && (
        <button
          className={`action-btn${acking ? ' is-busy' : ''}`}
          aria-label="Descartar bloqueo"
          title="Reconoce este bloqueo: la tarjeta deja de ocupar la columna Bloqueado (el estado en el arr no cambia)"
          disabled={busy !== null || acking || copyTask !== null}
          onClick={() => void clearBlocked()}
        >
          {acking && <span className="action-spinner" aria-hidden="true" />}
          {acking ? 'Procesando…' : 'Descartar bloqueo'}
        </button>
      )}

      {/* A download the client still lists never leaves Activas by itself
          (paused, wrong category) even when the file is already in the
          library — the operator declares it done. */}
      {trace.stage === 'downloaded' && (
        <button
          className={`action-btn${acking ? ' is-busy' : ''}`}
          aria-label="Marcar como completada"
          title="Da esta descarga por terminada: pasa a Completadas (no cambia nada en el cliente ni en el arr)"
          disabled={busy !== null || acking || copyTask !== null}
          onClick={() => void clearBlocked(true)}
        >
          {acking ? <span className="action-spinner" aria-hidden="true" /> : <Icon name="check" size={14} />}
          {acking ? 'Procesando…' : 'Marcar como completada'}
        </button>
      )}

      {result && (
        <div className={`action-result ${result.ok ? 'ok' : 'bad'}`}>
          {result.ok
            ? (result.steps ?? []).map((s) => s.detail).join(' · ')
            : failureText(result)}
          <button
            className="action-result-close"
            aria-label="Cerrar aviso"
            onClick={() => setResult(null)}
          >
            ×
          </button>
        </div>
      )}

      {pending && (
        <TraceDialog label={meta[pending.action].label} onClose={() => setPending(null)}>
          <h3>{meta[pending.action].label}</h3>
          <p>{meta[pending.action].description}</p>

          {pending.action === 'fix_path_mapping' && (
            <div className="modal-fields">
              <label htmlFor={HOST_ID}>
                {HOST_LABEL}
                <input
                  type="text"
                  id={HOST_ID}
                  name={HOST_ID}
                  value={pending.options.host || ''}
                  onChange={(e) =>
                    setPending((p) => p ? { ...p, options: { ...p.options, host: e.target.value } } : p)
                  }
                />
              </label>
              <label htmlFor={REMOTE_ID}>
                {REMOTE_LABEL}
                <input
                  type="text"
                  id={REMOTE_ID}
                  name={REMOTE_ID}
                  value={pending.options.remote_path || ''}
                  onChange={(e) =>
                    setPending((p) => p ? { ...p, options: { ...p.options, remote_path: e.target.value } } : p)
                  }
                />
              </label>
              <label htmlFor={LOCAL_ID}>
                {LOCAL_LABEL}
                <input
                  type="text"
                  id={LOCAL_ID}
                  name={LOCAL_ID}
                  value={pending.options.local_path || ''}
                  onChange={(e) =>
                    setPending((p) => p ? { ...p, options: { ...p.options, local_path: e.target.value } } : p)
                  }
                />
              </label>
            </div>
          )}

          {pending.action !== 'fix_path_mapping' && pending.action !== 'copy_files' && (
            <label className="modal-check" htmlFor={confirmOptionId(pending.action)}>
              <input
                type="checkbox"
                id={confirmOptionId(pending.action)}
                name={confirmOptionId(pending.action)}
                checked={Boolean(
                  pending.action === 'remove_queue'
                    ? pending.options.blocklist
                    : pending.options.delete_files,
                )}
                onChange={(e) => {
                  const value = e.target.checked
                  setPending((p) =>
                    p
                      ? {
                          ...p,
                          options: {
                            ...p.options,
                            ...(p.action === 'remove_queue' ? { blocklist: value } : { delete_files: value }),
                          },
                        }
                      : p,
                  )
                }}
              />
              {confirmOptionText(pending.action)}
            </label>
          )}

          <div className="modal-buttons">
            <button className="action-btn" onClick={() => setPending(null)}>
              Cancelar
            </button>
            <button
              className="action-btn destructive"
              onClick={() => void execute(pending.action, pending.options)}
            >
              Confirmar
            </button>
          </div>
        </TraceDialog>
      )}

      {checking && trace.destination && (
        <DestinationCheck
          folder={trace.destination}
          wanted={baseName(
            trace.torrent?.content_path || trace.torrent?.current_path || trace.queue?.output_path || '',
          )}
          onClose={() => setChecking(false)}
          onArrived={() => {
            setChecking(false)
            void clearBlocked(true)
          }}
          onCopy={() => {
            setChecking(false)
            const opts = optionsFor('copy_files', trace)
            if (opts) setPending({ action: 'copy_files', options: opts })
          }}
        />
      )}

      {copyTask && (
        <button className="action-btn cancel-btn" onClick={cancelTask}>
          Cancelar copia
        </button>
      )}
    </div>
  )
}

/** Without `onClose` the dialog cannot be dismissed (copy in progress): Escape and the backdrop do nothing. */
function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

interface FolderItem {
  name: string
  is_dir: boolean
  size: number
}

/** Lists the destination folder so the operator can see whether the download
 *  already arrived; "ya está" settles the row, otherwise the copy proceeds. */
function DestinationCheck({ folder, wanted, onClose, onArrived, onCopy }: {
  folder: string
  wanted: string
  onClose: () => void
  onArrived: () => void
  onCopy: () => void
}) {
  const [items, setItems] = useState<FolderItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    apiFetch(`/api/files/browse?path=${encodeURIComponent(folder)}`)
      .then((r) => r.json())
      .then((body: { ok?: boolean; items?: FolderItem[]; error?: string }) => {
        if (!alive) return
        if (body.ok) setItems(body.items ?? [])
        else setError(body.error ?? 'No se pudo leer la carpeta')
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => { alive = false }
  }, [folder])

  const match = items?.some((i) => i.name === wanted) ?? false

  return (
    <TraceDialog label="Verificar destino" onClose={onClose}>
      <h3>Verificar destino</h3>
      <p>
        <code>{folder}</code>
      </p>
      {error && <p role="alert">{error}</p>}
      {!error && items === null && <p>Leyendo la carpeta…</p>}
      {items && items.length === 0 && <p>La carpeta está vacía.</p>}
      {items && items.length > 0 && (
        <ul className="dest-list">
          {items.map((i) => (
            <li key={i.name} className={i.name === wanted ? 'is-match' : undefined}>
              {i.name}
              {!i.is_dir && <span> · {formatSize(i.size)}</span>}
              {i.name === wanted && <strong> · coincide con la descarga</strong>}
            </li>
          ))}
        </ul>
      )}
      {items && !match && wanted && <p>«{wanted}» no aparece en la carpeta.</p>}
      <div className="modal-buttons">
        <button className="action-btn" onClick={onClose}>Cancelar</button>
        <button className="action-btn" onClick={onCopy}>No ha llegado: copiar</button>
        <button className="action-btn" onClick={onArrived}>Ya está en destino</button>
      </div>
    </TraceDialog>
  )
}

function TraceDialog({ label, onClose, className, children }: {
  label: string
  onClose?: () => void
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDialog(ref, () => onClose?.())
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={className ? `modal ${className}` : 'modal'}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

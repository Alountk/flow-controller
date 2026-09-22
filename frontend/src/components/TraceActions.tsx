import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ActionKey, ActionMeta, ActionResult, Trace } from '../types'
import { runAction, type ActionOptions } from '../api/actions'
import { apiFetch } from '../api/auth'
import './TraceActions.css'

interface Props {
  trace: Trace
  meta: Record<ActionKey, ActionMeta>
  safeMode: boolean
  onDone: () => void
}

interface Pending {
  action: ActionKey
  options: ActionOptions
}

interface TaskProgress {
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

function derivePathMapping(trace: Trace) {
  const host = trace.download_client_host || ''
  const output = trace.queue?.output_path || ''
  const remote_path = output.substring(0, output.lastIndexOf('/')) || ''
  const local_path = '/downloads/incoming'
  return { host, remote_path, local_path }
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
  if (action === 'fix_path_mapping') return derivePathMapping(trace)
  if (action === 'copy_files') {
    const src = trace.torrent?.content_path || trace.torrent?.current_path || trace.queue?.output_path || ''
    return { output_path: src }
  }
  return null
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[i]}`
}

const TERMINAL_STATUSES = ['imported', 'renamed_needed', 'import_timeout', 'error', 'cancelled']
const ACTIVE_STATUSES = ['running', 'done', 'importing', 'renamed_needed']

export function TraceActions({ trace, meta, safeMode, onDone }: Props) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [copyTask, setCopyTask] = useState<TaskProgress | null>(null)

  const keys = actionsFor(trace)

  const { data: taskData } = useQuery({
    queryKey: ['task', copyTask?.task_id],
    queryFn: async () => {
      const res = await apiFetch(`/api/tasks/${copyTask!.task_id}`, {})
      return res.json() as Promise<{ ok: boolean } & TaskProgress>
    },
    enabled: !!copyTask && ACTIVE_STATUSES.includes(copyTask.status),
    refetchInterval: (query) => {
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

  // Auto-dismiss action results after 4 seconds
  useEffect(() => {
    if (!result) return
    const t = setTimeout(() => setResult(null), 4000)
    return () => clearTimeout(t)
  }, [result])

  async function execute(action: ActionKey, options: ActionOptions) {
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
      }
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message })
    } finally {
      setBusy(null)
      setPending(null)
    }
  }

  function handleClick(action: ActionKey) {
    const opts = optionsFor(action, trace)
    if (opts) {
      setPending({ action, options: opts })
    } else {
      void execute(action, {})
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

  const progressPct = copyTask && copyTask.total_bytes > 0
    ? Math.round((copyTask.copied_bytes / copyTask.total_bytes) * 100)
    : 0

  return (
    <div className="trace-actions" onClick={(e) => e.stopPropagation()}>
      {keys.map((key) => {
        const m = meta[key]
        if (!m) return null
        const blocked = safeMode && m.destructive
        return (
          <button
            key={key}
            className={`action-btn ${m.destructive ? 'destructive' : ''}`}
            title={blocked ? `${m.description} (bloqueada por modo seguro)` : m.description}
            disabled={busy !== null || blocked || copyTask !== null}
            onClick={() => handleClick(key)}
          >
            {busy === key ? '…' : m.label}
          </button>
        )
      })}

      {result && (
        <div className={`action-result ${result.ok ? 'ok' : 'bad'}`}>
          {result.ok
            ? (result.steps ?? []).map((s) => s.detail).join(' · ')
            : result.error ?? (result.steps ?? []).map((s) => `${s.target}: ${s.detail}`).join(' · ')}
          <button className="action-result-close" onClick={() => setResult(null)}>
            ×
          </button>
        </div>
      )}

      {pending && (
        <div className="modal-backdrop" onClick={() => setPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{meta[pending.action].label}</h3>
            <p>{meta[pending.action].description}</p>

            {pending.action === 'fix_path_mapping' && (
              <div className="modal-fields">
                <label>
                  Host del cliente de descargas
                  <input
                    type="text"
                    value={pending.options.host || ''}
                    onChange={(e) =>
                      setPending((p) => p ? { ...p, options: { ...p.options, host: e.target.value } } : p)
                    }
                  />
                </label>
                <label>
                  Ruta remota (dentro del contenedor del cliente)
                  <input
                    type="text"
                    value={pending.options.remote_path || ''}
                    onChange={(e) =>
                      setPending((p) => p ? { ...p, options: { ...p.options, remote_path: e.target.value } } : p)
                    }
                  />
                </label>
                <label>
                  Ruta local (dentro del contenedor del *arr)
                  <input
                    type="text"
                    value={pending.options.local_path || ''}
                    onChange={(e) =>
                      setPending((p) => p ? { ...p, options: { ...p.options, local_path: e.target.value } } : p)
                    }
                  />
                </label>
              </div>
            )}

            {pending.action !== 'fix_path_mapping' && (
              <label className="modal-check">
                <input
                  type="checkbox"
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
                            options:
                              p.action === 'remove_queue'
                                ? { blocklist: value }
                                : { delete_files: value },
                          }
                        : p,
                    )
                  }}
                />
                {pending.action === 'remove_queue'
                  ? 'Añadir a la blocklist (no volver a descargar)'
                  : 'Eliminar también los archivos descargados'}
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
          </div>
        </div>
      )}

      {copyTask && (
        <div className="modal-backdrop">
          <div className="modal copy-progress-modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {copyTask.status === 'importing' ? 'Verificando import...' :
               copyTask.status === 'imported' ? 'Importado correctamente' :
               copyTask.status === 'renamed_needed' ? 'Importado — renombrado pendiente' :
               copyTask.status === 'import_timeout' ? 'Timeout de import' :
               'Copiar archivos'}
            </h3>

            <div className="copy-paths">
              <div className="copy-path-row">
                <span className="copy-path-label">origen:</span>
                <code className="copy-path-value">{copyTask.src_path}</code>
              </div>
              <div className="copy-path-row">
                <span className="copy-path-label">destino:</span>
                <code className="copy-path-value">{copyTask.dst_path}</code>
              </div>
            </div>

            {copyTask.status !== 'importing' && (
              <>
                <div className="copy-bar-container">
                  <div className="copy-bar" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="copy-stats">
                  <span>{formatBytes(copyTask.copied_bytes)} / {formatBytes(copyTask.total_bytes)}</span>
                  <span>{progressPct}%</span>
                </div>
                {copyTask.files_total > 0 && (
                  <div className="copy-files-count">
                    {copyTask.files_done} / {copyTask.files_total} archivos
                  </div>
                )}
              </>
            )}

            {copyTask.status === 'importing' && (
              <div className="copy-importing">
                <span className="copy-spinner" />
                <span>Esperando que Sonarr/Radarr importe y renombre el archivo...</span>
              </div>
            )}

            <p className="copy-detail">{copyTask.detail}</p>

            <div className="modal-buttons">
              <button className="action-btn cancel-btn" onClick={cancelTask}>
                Cancelar copia
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

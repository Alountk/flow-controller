import { useState } from 'react'
import type { ActionKey, ActionMeta, ActionResult, Trace } from '../types'
import { runAction, type ActionOptions } from '../api/actions'

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

function derivePathMapping(trace: Trace) {
  const host = trace.download_client_host || ''
  const output = trace.queue?.output_path || ''
  // remote_path = directorio del output_path (sin el nombre de archivo)
  const remote_path = output.substring(0, output.lastIndexOf('/')) || ''
  // local_path: por defecto /downloads/incoming para aMuTorrent
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
      if (queueId) list.push('retry_import')
      if (trace.queue?.output_path) list.push('copy_files')
      if (trace.queue?.output_path) list.push('fix_path_mapping')
      if (hasTarget) list.push('research')
      if (queueId) list.push('remove_queue')
      break
    case 'downloaded':
      if (hasHash && trace.category_ok === false) list.push('fix_category')
      list.push('retry_import')
      if (trace.torrent?.current_path) list.push('copy_files')
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
    const src = trace.torrent?.current_path || trace.queue?.output_path || ''
    return { output_path: src }
  }
  return null
}

export function TraceActions({ trace, meta, safeMode, onDone }: Props) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)

  const keys = actionsFor(trace)

  async function execute(action: ActionKey, options: ActionOptions) {
    setBusy(action)
    setResult(null)
    try {
      const res = await runAction(action, trace, options)
      setResult(res)
      if (res.ok) onDone()
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
            disabled={busy !== null || blocked}
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
    </div>
  )
}

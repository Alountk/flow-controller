import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  searchWanted,
  cancelWantedSearch,
  type BulkSearchResult,
} from '../../../shared/api/wanted.ts'
import { toast } from '../../../shared/utils/toast.ts'
import type { MediaKind } from '../types.ts'

/**
 * The mass missing-search trigger and its C-09 confirmation, as one unit.
 *
 * The backend launches NOTHING without `confirm: true` (one careless call
 * fired grabs for 24 movies on 2026-10-07, uncancellable at the time), so
 * the press probes with confirm=false, the dialog states the count the list
 * is holding — the count belongs to whoever holds the list — and only the
 * explicit Confirmar carries confirm=true. The cancel endpoint joins in at
 * exactly one moment: after the launch returned its `command_id`, which is
 * the only moment a command exists to cancel.
 *
 * The dialog reuses the app's confirmation modal (the TraceActions pattern:
 * `.modal-backdrop` > `.modal` > `.modal-buttons`) and the ambient toasts of
 * F-13 — the same feedback a grab or a scan gives, never a new paradigm.
 */
interface BulkSearchFlowProps {
  kind: MediaKind
  /** The missing list's own total: the "N" the dialog states. */
  count: number
  /** A text filter narrows this count, but the launch would not honor it. */
  filtered: boolean
}

/** What the launched step keeps: the handle cancel needs, and the ack. */
interface LaunchedRun {
  commandId: number | null
  detail: string | null
}

export function BulkSearchFlow({ kind, count, filtered }: BulkSearchFlowProps) {
  const isMovies = kind === 'movies'
  const source = isMovies ? 'radarr' : 'sonarr'
  const service = isMovies ? 'Radarr' : 'Sonarr'
  const [dialog, setDialog] = useState<'confirm' | 'launched' | null>(null)
  const [launched, setLaunched] = useState<LaunchedRun | null>(null)

  const remember = (res: BulkSearchResult) =>
    setLaunched({ commandId: res.command_id ?? null, detail: res.detail ?? null })

  const probe = useMutation({
    mutationFn: () => searchWanted(source, false),
    onSuccess: (res) => {
      if (res.needs_confirm) {
        setDialog('confirm')
        return
      }
      // Defensive: a pre-C-09 backend would have launched on sight. The
      // launch already happened, so there is nothing left to confirm — but
      // its answer still gets the launched step, because the command id it
      // carries is exactly what cancel needs.
      if (res.ok) {
        remember(res)
        setDialog('launched')
        toast(res.detail || 'Búsqueda masiva lanzada', 'ok')
      } else {
        toast(res.error || res.detail || 'No se pudo pedir la confirmación', 'error')
      }
    },
    onError: () => toast('No se pudo contactar con el servidor', 'error'),
  })

  const launch = useMutation({
    mutationFn: () => searchWanted(source, true),
    onSuccess: (res) => {
      if (res.ok) {
        remember(res)
        setDialog('launched')
        toast(res.detail || 'Búsqueda masiva lanzada', 'ok')
      } else {
        // Stay on the confirm step: the count is still there to accept again.
        toast(res.error || res.detail || 'No se pudo lanzar la búsqueda', 'error')
      }
    },
    onError: () => toast('No se pudo contactar con el servidor', 'error'),
  })

  const cancel = useMutation({
    mutationFn: (commandId: number) => cancelWantedSearch(source, commandId),
    onSuccess: (res) => {
      if (res.ok) {
        toast(res.detail || 'Búsqueda cancelada', 'ok')
        setDialog(null)
        setLaunched(null)
      } else {
        // 404 at the arr (already finished) lands here: keep the step open
        // so the operator sees why and still holds the "Cerrar" exit.
        toast(res.error || res.detail || 'No se pudo cancelar el comando', 'error')
      }
    },
    onError: () => toast('No se pudo contactar con el servidor', 'error'),
  })

  /** A launch or a cancel in flight owns the dialog: nobody may close it. */
  const dialogBusy = launch.isPending || cancel.isPending

  function close() {
    if (dialogBusy) return
    setDialog(null)
    setLaunched(null)
  }

  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dialogBusy) {
        setDialog(null)
        setLaunched(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, dialogBusy])

  const countLabel = `${count} ${count === 1 ? 'resultado' : 'resultados'}`
  const commandId = launched?.commandId ?? null
  const triggerLabel = isMovies ? '🔍 Buscar todas las faltantes' : '🔍 Buscar todos los faltantes'

  return (
    <>
      <button
        className="action-btn search-all"
        onClick={() => probe.mutate()}
        disabled={probe.isPending || count <= 0 || filtered}
        // The launch sweeps EVERY missing title; a filtered total would
        // understate the blast radius of the very thing this confirms.
        title={
          filtered
            ? 'La búsqueda masiva busca todos los faltantes, no solo los filtrados: limpia el filtro para lanzarla'
            : undefined
        }
      >
        {probe.isPending ? 'Buscando...' : triggerLabel}
      </button>

      {dialog === 'confirm' && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{countLabel} — ¿lanzar búsqueda?</h3>
            <p>
              Se lanzará la búsqueda masiva de faltantes en {service}. Puede disparar muchas
              descargas de golpe: revisa el recuento antes de confirmar.
            </p>
            <div className="modal-buttons">
              <button className="action-btn" onClick={close}>
                Cancelar
              </button>
              <button
                className="action-btn destructive"
                onClick={() => launch.mutate()}
                disabled={launch.isPending}
              >
                {launch.isPending ? 'Lanzando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'launched' && launched && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Búsqueda lanzada</h3>
            <p>{launched.detail || 'La búsqueda masiva ya está en curso.'}</p>
            {commandId != null && (
              <p>Comando #{commandId} — se puede cancelar mientras siga en curso.</p>
            )}
            <div className="modal-buttons">
              <button className="action-btn" onClick={close}>
                Cerrar
              </button>
              {commandId != null && (
                <button
                  className="action-btn destructive"
                  onClick={() => cancel.mutate(commandId)}
                  disabled={cancel.isPending}
                >
                  {cancel.isPending ? 'Cancelando...' : 'Cancelar búsqueda'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

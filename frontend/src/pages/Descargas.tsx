import { useRef, useState, type ReactNode } from 'react'
import { useDialog } from '../shared/hooks/useDialog.ts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  amuleDownloadsAction,
  getAmuleCategories,
  getAmuleDownloads,
  type AmuleDownloadAction,
  type AmuleDownloadActionBody,
} from '../shared/api/amuleDownloads.ts'
import type { AmuleDownloadRow, AmuleDownloadState } from '../shared/types.ts'
import { errorMessage, formatBytes } from '../shared/utils/text.ts'
import { toast } from '../shared/utils/toast.ts'
import './Descargas.css'

/**
 * Descargas (pagina-descargas T3): la cola eD2K de aMule en vivo, con control
 * por fichero. Las filas se pintan desde una forma de vista única (la costura
 * S4): cuando qBittorrent entre, entra por ese mismo mapeo.
 */

const STATE_LABELS: Record<AmuleDownloadState, string> = {
  downloading: 'Descargando',
  paused: 'En pausa',
  completed: 'Completada',
  waiting: 'En espera',
}

/** El orden del selector es de prioridad ascendente con Auto/Release al final,
 *  no el orden numérico del enum de aMule (4 es «Muy baja»). */
const PRIORITY_OPTIONS = [
  { value: 4, label: 'Muy baja' },
  { value: 0, label: 'Baja' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'Alta' },
  { value: 3, label: 'Muy alta' },
  { value: 5, label: 'Auto' },
  { value: 6, label: 'Release' },
]

/** La fila del proveedor, ya formateada para pintar. La página no mira
 *  `source`: todo pasa por aquí primero (costura S4). */
interface RowView {
  key: string
  hash: string
  source: string
  name: string
  state: AmuleDownloadState
  statusCode: string
  pct: number
  progressText: string
  speedText: string
  etaText: string
  sizeText: string
  sourcesText: string
  category: number | null
  priority: number
}

function formatEta(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total} s`
  const mins = Math.round(total / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h ${mins % 60} min`
}

function toRowView(row: AmuleDownloadRow): RowView {
  return {
    key: `${row.source}:${row.hash}`,
    hash: row.hash,
    source: row.source,
    name: row.name,
    state: row.state,
    statusCode: String(row.status_code),
    pct: row.progress_pct,
    progressText: `${row.progress_pct}%`,
    // Sin velocidad no hay transferencia: la fila muestra una raya, no «0 B/s».
    speedText: row.speed > 0 ? `${formatBytes(row.speed)}/s` : '—',
    etaText: formatEta(row.eta_seconds),
    sizeText: `${formatBytes(row.size_done)} / ${formatBytes(row.size_full)}`,
    sourcesText: `${row.sources} ${row.sources === 1 ? 'fuente' : 'fuentes'}`,
    category: row.category,
    priority: row.priority,
  }
}

function Row({
  view,
  categories,
  onAction,
  onDelete,
}: {
  view: RowView
  categories: Record<string, number> | null
  onAction: (action: AmuleDownloadAction, body: AmuleDownloadActionBody) => void
  onDelete: (view: RowView) => void
}) {
  const paused = view.state === 'paused'
  const currentCategory = Object.entries(categories ?? {}).find(([, index]) => index === view.category)

  return (
    <article className="dl-row" aria-label={view.name}>
      <div className="dl-row-main">
        <span className="dl-source">{view.source}</span>
        <span className="dl-name" title={view.name}>
          {view.name}
        </span>
        <span className={`dl-chip dl-chip-${view.state}`} title={view.statusCode}>
          {STATE_LABELS[view.state]}
        </span>
        {currentCategory && <span className="dl-category">{currentCategory[0]}</span>}
      </div>

      <div className="dl-row-prog">
        <div
          className="dl-bar"
          role="progressbar"
          aria-valuenow={view.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progreso de ${view.name}`}
        >
          <i style={{ width: `${view.pct}%` }} />
        </div>
        <span className="dl-pct">{view.progressText}</span>
        <span className="dl-speed">{view.speedText}</span>
        <span className="dl-eta">{view.etaText}</span>
        <span className="dl-size">{view.sizeText}</span>
        <span className="dl-sources">{view.sourcesText}</span>
      </div>

      <div className="dl-row-controls">
        <button
          type="button"
          className="dl-toggle"
          onClick={() => onAction(paused ? 'resume' : 'pause', { file_hash: view.hash })}
        >
          {paused ? 'Continuar' : 'Pausar'}
        </button>

        <span className="dl-field">
          <span className="dl-field-label">Prioridad</span>
          <select
            aria-label="Prioridad"
            value={String(view.priority)}
            onChange={(e) =>
              onAction('priority', { file_hash: view.hash, priority: Number(e.target.value) })
            }
          >
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </span>

        <span className="dl-field">
          <span className="dl-field-label">Categoría</span>
          <select
            aria-label="Categoría"
            value={currentCategory ? String(currentCategory[1]) : ''}
            onChange={(e) =>
              onAction('category', { file_hash: view.hash, category: Number(e.target.value) })
            }
          >
            {Object.entries(categories ?? {}).map(([title, index]) => (
              <option key={index} value={index}>
                {title}
              </option>
            ))}
          </select>
        </span>

        <button type="button" className="dl-delete" onClick={() => onDelete(view)}>
          Borrar
        </button>
      </div>
    </article>
  )
}

export default function Descargas() {
  const queryClient = useQueryClient()
  const listQuery = useQuery({
    queryKey: ['amule-downloads'],
    queryFn: getAmuleDownloads,
    refetchInterval: 5000,
  })
  const categoriesQuery = useQuery({
    queryKey: ['amule-categories'],
    queryFn: getAmuleCategories,
    staleTime: 60_000,
  })
  const categories = categoriesQuery.data?.ok ? categoriesQuery.data.categories : null

  const [pending, setPending] = useState<RowView | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)

  const run = (action: AmuleDownloadAction, body: AmuleDownloadActionBody) => {
    void (async () => {
      try {
        const result = await amuleDownloadsAction(action, body)
        // La negativa del servidor (SAFE_MODE incluido) se cuenta UNA vez: aquí.
        toast(result.detail, result.ok ? 'ok' : 'error')
        if (result.ok) void queryClient.invalidateQueries({ queryKey: ['amule-downloads'] })
      } catch (exc) {
        toast(errorMessage(exc), 'error')
      }
    })()
  }

  const cancelDelete = () => {
    setPending(null)
    setDeleteFiles(false)
  }

  const confirmDelete = () => {
    if (!pending) return
    const { hash } = pending
    // Capturada antes del reset: `delete_files: true` sólo con la casilla puesta.
    const files = deleteFiles
    setPending(null)
    setDeleteFiles(false)
    run('delete', { file_hash: hash, delete_files: files })
  }

  const data = listQuery.data
  const views = data?.ok ? data.downloads.map(toRowView) : []

  return (
    <section className="dl">
      <header className="dl-header">
        <h2 className="dl-title">Descargas</h2>
        <p className="dl-subtitle">Cola de aMule en vivo, con control por fichero</p>
      </header>

      {listQuery.isPending && <p className="dl-empty">Cargando…</p>}
      {listQuery.isError && (
        <p className="dl-alert" role="alert">
          {errorMessage(listQuery.error)}
        </p>
      )}
      {data && !data.ok && (
        <p className="dl-alert" role="alert">
          {data.detail}
        </p>
      )}
      {data?.ok && data.downloads.length === 0 && (
        <p className="dl-empty">No hay descargas en aMule</p>
      )}

      {views.length > 0 && (
        <div className="dl-list">
          {views.map((view) => (
            <Row
              key={view.key}
              view={view}
              categories={categories}
              onAction={run}
              onDelete={(target) => {
                setDeleteFiles(false)
                setPending(target)
              }}
            />
          ))}
        </div>
      )}

      {pending && (
        <ConfirmDialog onClose={cancelDelete}>
          <p className="dl-confirm-question">
            ¿Borrar «{pending.name}»? La descarga se quitará de la cola de aMule.
          </p>
          <label className="dl-confirm-files">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => setDeleteFiles(e.target.checked)}
            />
            Borrar también los ficheros descargados
          </label>
          <div className="dl-confirm-actions">
            <button type="button" className="dl-danger" onClick={confirmDelete}>
              Sí, borrar
            </button>
            <button type="button" onClick={cancelDelete}>
              Cancelar
            </button>
          </div>
        </ConfirmDialog>
      )}
    </section>
  )
}

function ConfirmDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialog(ref, onClose)
  return (
    <div className="dl-backdrop" onClick={onClose}>
      <div
        className="dl-confirm"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Confirmar borrado"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

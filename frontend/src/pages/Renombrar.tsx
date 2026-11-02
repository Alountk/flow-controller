import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  renameApply,
  renameCandidates,
  type RenameCandidate,
  type RenameResult,
} from '../shared/api/files.ts'
import { LibraryRenameDialog } from '../features/file-manager/LibraryRenameDialog.tsx'
import { toast } from '../shared/utils/toast.ts'
import './Renombrar.css'

/**
 * Every 4K/3D copy that does not follow Radarr's template yet.
 *
 * The rows are the preview: older name above, the proposed one below, and the
 * sidecars that travel with it. Renaming one by one inside the explorer does
 * not scale to a library, which is why this page exists and the explorer's
 * action is gone — two doors with their own rules would drift.
 */

/** The pair as the row shows it, including the folder the copy lands in. */
function proposedPath(item: RenameCandidate): string {
  const parent = item.src.split('/').slice(0, -1).join('/')
  const folder = item.loose && item.folder ? `/${item.folder}` : ''
  return `${parent}${folder}/${item.name}${item.extension ?? ''}`
}

function currentPath(item: RenameCandidate): string {
  return item.src
}

export function Renombrar() {
  const queryClient = useQueryClient()
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [report, setReport] = useState<{ ok: boolean; lines: string[] } | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['rename-candidates'],
    queryFn: renameCandidates,
    refetchOnWindowFocus: false,
  })

  const items = data?.items ?? []
  // A copy nobody could identify has no proposed name to batch-apply: it can
  // only be fixed by editing it by hand, so it never travels with the batch.
  const selected = useMemo(
    () =>
      items
        .filter((item) => item.ok && item.movie && !skipped.has(item.src))
        .map((item) => item.src),
    [items, skipped],
  )

  function toggle(src: string) {
    setSkipped((prev) => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src)
      else next.add(src)
      return next
    })
  }

  /** One request at a time on purpose: these are renames on real files. */
  const applyMut = useMutation({
    mutationFn: async (paths: string[]) => {
      const done: RenameResult[] = []
      for (const path of paths) {
        const item = items.find((candidate) => candidate.src === path)
        if (!item) continue
        done.push(
          await renameApply({
            remote_path: item.src,
            folder: item.loose ? (item.folder ?? '') : '',
            name: item.name ?? '',
          }),
        )
      }
      return done
    },
    onSuccess: (results) => {
      const lines = results.flatMap((result) =>
        (result.moved ?? []).map((entry) => `${entry.from} → ${entry.to}`),
      )
      const failures = results.flatMap((result) =>
        result.detail && !result.ok ? [result.detail] : (result.failed ?? []).map((f) => f.detail),
      )
      const ok = results.every((result) => result.ok)
      setReport({ ok, lines: [...lines, ...failures] })
      toast(
        ok ? `Renombradas ${results.length}` : 'Alguna copia no se pudo renombrar',
        ok ? 'ok' : 'error',
      )
      void queryClient.invalidateQueries({ queryKey: ['rename-candidates'] })
      setSkipped(new Set())
    },
    onError: (err: Error) => setReport({ ok: false, lines: [err.message] }),
  })

  const doneCount = items.length - selected.length

  return (
    <section className="renombrar">
      <header className="renombrar-head">
        <div>
          <h2>Renombrar</h2>
          <p className="renombrar-sub">
            Las copias 4K/3D que no siguen la plantilla de Radarr. La carpeta y el nombre son
            propuestas: puedes editarlas antes de aplicar, y nada se mueve hasta que lo pidas.
          </p>
        </div>
        <button
          type="button"
          className="renombrar-apply"
          disabled={selected.length === 0 || applyMut.isPending}
          onClick={() => applyMut.mutate(selected)}
        >
          {applyMut.isPending ? 'Renombrando…' : `Aplicar a las seleccionadas (${selected.length})`}
        </button>
      </header>

      {isLoading && <div className="renombrar-note">Leyendo la biblioteca…</div>}
      {error && <div className="fm-error">{(error as Error).message}</div>}

      {data && items.length === 0 && (
        <div className="renombrar-note">
          {data.detail || 'Ninguna copia 4K/3D se queda fuera de la plantilla.'}
        </div>
      )}

      {items.length > 0 && (
        <div className="renombrar-list">
          <div className="renombrar-row renombrar-row-head">
            <span />
            <span>Ahora · propuesta</span>
            <span>También se renombra</span>
            <span>{doneCount > 0 ? `${doneCount} sin marcar` : ''}</span>
          </div>
          {items.map((item) => {
            const selectable = item.ok && item.movie != null
            const checked = selectable && !skipped.has(item.src)
            return (
              <div key={item.src} className={`renombrar-row${item.ok ? '' : ' blocked'}`}>
                <input
                  type="checkbox"
                  aria-label={`Seleccionar ${item.src}`}
                  checked={checked}
                  disabled={!selectable}
                  title={selectable ? '' : 'Sin propuesta: edítala a mano'}
                  onChange={() => toggle(item.src)}
                />
                <div className="renombrar-pair">
                  <span className="renombrar-from" title={currentPath(item)}>
                    {currentPath(item)}
                  </span>
                  <span className="renombrar-to" title={proposedPath(item)}>
                    {item.ok ? proposedPath(item) : 'Sin propuesta'}
                  </span>
                </div>
                <div className="renombrar-sidecars">
                  {(item.sidecars ?? []).length > 0 &&
                    `También: ${(item.sidecars ?? []).map((s) => s.from).join(', ')}`}
                </div>
                <div className="renombrar-actions">
                  {(item.warnings ?? []).map((warning) => (
                    <span key={warning} className="renombrar-warn" title={warning}>
                      ⚠ {warning}
                    </span>
                  ))}
                  <button
                    type="button"
                    className="fm-action-btn"
                    onClick={() => setEditing(item.src)}
                  >
                    Editar
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {report && (
        <div className={`renombrar-report${report.ok ? '' : ' bad'}`}>
          <strong>{report.ok ? 'Hecho' : 'Con incidencias'}</strong>
          <ul>
            {report.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button type="button" className="fm-action-btn" onClick={() => setReport(null)}>
            Cerrar
          </button>
        </div>
      )}

      {editing && (
        <LibraryRenameDialog
          path={editing}
          onClose={() => setEditing(null)}
          onRenamed={(detail) => {
            setEditing(null)
            toast(detail, 'ok')
            void queryClient.invalidateQueries({ queryKey: ['rename-candidates'] })
          }}
        />
      )}
    </section>
  )
}

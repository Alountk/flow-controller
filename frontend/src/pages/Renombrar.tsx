import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchRoots,
  renameApply,
  renameCandidates,
  renames,
  type RenameCandidate,
  type RenameLogRow,
  type RenameResult,
} from '../shared/api/files.ts'
import { LibraryRenameDialog } from '../features/file-manager/LibraryRenameDialog.tsx'
import { toast } from '../shared/utils/toast.ts'
import './Renombrar.css'
import '../shared/ui/atoms.css'

/**
 * Every 4K/3D copy that does not follow Radarr's template yet, and the record of
 * what was already renamed.
 *
 * The two are one page because they answer one question in two directions: what
 * is left to do, and what has been done. The batch only ever applies rows that
 * have a proposal — a copy nobody could name can only be fixed by editing it.
 */

type View = 'candidates' | 'log'

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? path : path.slice(0, cut)
}

/** The pair as the row shows it, including the folder the copy lands in. */
function proposedPath(item: RenameCandidate): string {
  const parent = parentOf(item.src)
  const folder = item.loose && item.folder ? `/${item.folder}` : ''
  return `${parent}${folder}/${item.name}${item.extension ?? ''}`
}

/** The class a copy already lives in, read from the configured roots. */
function rootLabel(path: string, roots: { path: string; role?: string }[]): string {
  const root = roots.find(
    (candidate) =>
      path === candidate.path || path.startsWith(`${candidate.path.replace(/\/+$/, '')}/`),
  )
  if (root?.role === '4k') return '4K'
  if (root?.role === '3d') return '3D'
  return ''
}

/** Short enough to sit in a table cell, honest enough to read. */
function relative(seconds: number): string {
  const diff = Math.max(0, Date.now() / 1000 - seconds)
  if (diff < 60) return 'hace un momento'
  if (diff < 3600) return `hace ${Math.max(1, Math.floor(diff / 60))} min`
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`
  if (diff < 172800) return 'ayer'
  return `hace ${Math.floor(diff / 86400)} días`
}

function stamp(seconds: number): string {
  const at = new Date(seconds * 1000)
  const date = at.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
  const time = at.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  return `${date} · ${time}`
}

export function Renombrar() {
  const queryClient = useQueryClient()
  const [view, setView] = useState<View>('candidates')
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [report, setReport] = useState<{ ok: boolean; lines: string[] } | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['rename-candidates'],
    queryFn: renameCandidates,
    refetchOnWindowFocus: false,
  })
  const rootsQuery = useQuery({
    queryKey: ['roots'],
    queryFn: fetchRoots,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  })
  // One read per visit, cached: the count on the chip is part of the design, and
  // a count that only appears after clicking would be a chip that changes shape.
  const logQuery = useQuery({
    queryKey: ['renames'],
    queryFn: () => renames(),
    refetchOnWindowFocus: false,
  })

  const roots = rootsQuery.data?.roots ?? []
  const items = data?.items ?? []
  const renamed = logQuery.data?.items ?? []

  // A copy nobody could identify, or one the template could not name, has no
  // proposal to batch-apply: it can only be fixed by editing it by hand, so it
  // never travels with the batch.
  const selected = useMemo(
    () =>
      items
        .filter((item) => item.ok && item.movie && item.named && !skipped.has(item.src))
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
            origin: 'lote',
            movie_id: item.movie?.id ?? 0,
          }),
        )
      }
      return done
    },
    onSuccess: (results) => {
      const lines = results.flatMap((result) =>
        (result.moved ?? []).map((entry) =>
          // A move that keeps the file's name is a filing, not a rename: saying
          // only "renombrado" is what made a half plan look like a failure.
          baseName(entry.from) === baseName(entry.to)
            ? `${entry.from} → ${entry.to} (solo se movió a su carpeta)`
            : `${entry.from} → ${entry.to}`,
        ),
      )
      const failures = results.flatMap((result) =>
        result.detail && !result.ok ? [result.detail] : (result.failed ?? []).map((f) => f.detail),
      )
      const late = results.flatMap((result) =>
        result.rescan && !result.rescan.ok
          ? [`Renombrado, pero Radarr no confirmó el rescan: ${result.rescan.detail}`]
          : [],
      )
      const ok = results.every((result) => result.ok) && late.length === 0
      setReport({ ok, lines: [...lines, ...failures, ...late] })
      toast(
        ok ? `Renombradas ${results.length}` : 'Alguna copia no se pudo renombrar',
        ok ? 'ok' : 'error',
      )
      void queryClient.invalidateQueries({ queryKey: ['rename-candidates'] })
      void queryClient.invalidateQueries({ queryKey: ['renames'] })
      setSkipped(new Set())
    },
    onError: (err: Error) => setReport({ ok: false, lines: [err.message] }),
  })

  const fourKCount = items.filter((item) => rootLabel(item.src, roots) === '4K').length
  const summary = [
    `${items.length} ${items.length === 1 ? 'copia fuera' : 'copias fuera'} de plantilla`,
    fourKCount > 0 ? `${fourKCount} de ellas en carpetas 4K` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="renombrar">
      <header className="renombrar-head">
        <div>
          <h2>Renombrar</h2>
          <p className="renombrar-sub">Copias 4K y 3D que no siguen la plantilla de Radarr</p>
        </div>
        <div className="renombrar-head-actions">
          <button
            type="button"
            className="renombrar-refresh"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['rename-candidates'] })
              void queryClient.invalidateQueries({ queryKey: ['renames'] })
            }}
          >
            <span aria-hidden="true">↻ </span>Actualizar
          </button>
          <button
            type="button"
            className="renombrar-apply"
            disabled={selected.length === 0 || applyMut.isPending}
            onClick={() => applyMut.mutate(selected)}
          >
            {applyMut.isPending
              ? 'Renombrando…'
              : `Aplicar ${selected.length} ${selected.length === 1 ? 'cambio' : 'cambios'}`}
          </button>
        </div>
      </header>

      <div className="renombrar-tabs" role="tablist" aria-label="Vistas de renombrado">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'candidates'}
          className={`renombrar-tab${view === 'candidates' ? ' is-active' : ''}`}
          onClick={() => setView('candidates')}
        >
          Candidatos {items.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'log'}
          className={`renombrar-tab${view === 'log' ? ' is-active' : ''}`}
          onClick={() => setView('log')}
        >
          Renombrados {renamed.length}
        </button>
      </div>

      {isLoading && <div className="renombrar-note">Leyendo la biblioteca…</div>}
      {error && <div className="fm-error">{(error as Error).message}</div>}

      {view === 'candidates' && (
        <>
          {items.length > 0 && (
            <div className="renombrar-card">
              <strong>{summary}</strong>
              <p>
                El nombre viejo se muestra arriba y el nuevo debajo; los subtítulos y el .nfo
                viajan con el vídeo
              </p>
            </div>
          )}

          {data && items.length === 0 && (
            <div className="renombrar-note">
              {data.detail || 'Ninguna copia 4K/3D se queda fuera de la plantilla.'}
            </div>
          )}

          {items.length > 0 && (
            <table className="renombrar-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="renombrar-sr">Seleccionar</span>
                  </th>
                  <th scope="col">Ahora</th>
                  <th scope="col">Queda como</th>
                  <th scope="col">Carpeta</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  // `named` false means the template could not write this
                  // movie's name: there is no proposal, so nothing to batch.
                  const selectable = item.ok && item.movie != null && item.named === true
                  const checked = selectable && !skipped.has(item.src)
                  const label = rootLabel(item.src, roots)
                  const warnings = item.warnings ?? []
                  return (
                    <tr key={item.src} className={selectable ? '' : 'is-blocked'}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar ${item.src}`}
                          checked={checked}
                          disabled={!selectable}
                          title={selectable ? '' : 'Sin propuesta: edítala a mano'}
                          onChange={() => toggle(item.src)}
                        />
                      </td>
                      <td>
                        <span className="renombrar-from" title={item.src}>
                          {baseName(item.src)}
                        </span>
                      </td>
                      <td>
                        {selectable ? (
                          <>
                            <span className="renombrar-to" title={proposedPath(item)}>
                              {baseName(proposedPath(item))}
                            </span>
                            {(item.sidecars ?? []).length > 0 && (
                              <span className="renombrar-sidecars">
                                También: {(item.sidecars ?? []).map((s) => s.from).join(', ')}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="renombrar-blocked">
                            {warnings[0] ??
                              (item.movie
                                ? 'La plantilla no se pudo evaluar con esta copia'
                                : 'No se pudo identificar la película')}
                            {(item.sidecars ?? []).length > 0 && (
                              <span className="renombrar-sidecars">
                                También: {(item.sidecars ?? []).map((s) => s.from).join(', ')}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="renombrar-folder" title={parentOf(proposedPath(item))}>
                          {parentOf(proposedPath(item))}
                        </span>
                      </td>
                      <td>
                        {selectable ? (
                          <span className="renombrar-badge">{label || '—'}</span>
                        ) : (
                          <span className="renombrar-badge is-review">Revisar</span>
                        )}
                      </td>
                      <td className="renombrar-cell-actions">
                        {selectable && (
                          <button
                            type="button"
                            className="fm-action-btn"
                            onClick={() => toggle(item.src)}
                          >
                            {skipped.has(item.src) ? 'Incluir' : 'Omitir'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="fm-action-btn"
                          onClick={() => setEditing(item.src)}
                        >
                          Editar
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
        </>
      )}

      {view === 'log' && (
        <>
          {renamed.length > 0 && (
            <div className="renombrar-card">
              <strong>
                {renamed.length} {renamed.length === 1 ? 'copia renombrada' : 'copias renombradas'} ·
                la última {relative(renamed[0].renamed_at)}
              </strong>
              <p>
                El registro se guarda al aplicarlo: si un fichero vuelve a salir de plantilla,
                aparece otra vez en Candidatos.
              </p>
            </div>
          )}

          {logQuery.isLoading && <div className="renombrar-note">Leyendo el registro…</div>}

          {!logQuery.isLoading && renamed.length === 0 && (
            <div className="renombrar-note">Todavía no se ha renombrado nada.</div>
          )}

          {renamed.length > 0 && (
            <table className="renombrar-table">
              <thead>
                <tr>
                  <th scope="col">Nombre actual</th>
                  <th scope="col">Antes</th>
                  <th scope="col">Cuándo</th>
                  <th scope="col">Origen</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {renamed.map((row: RenameLogRow) => (
                  <tr key={`${row.dst}-${row.renamed_at}`}>
                    <td>
                      <span className="renombrar-to" title={row.dst}>
                        {baseName(row.dst)}
                      </span>
                    </td>
                    <td>
                      <span className="renombrar-from" title={row.src}>
                        {baseName(row.src)}
                      </span>
                    </td>
                    <td>
                      <span className="renombrar-when">{stamp(row.renamed_at)}</span>
                    </td>
                    <td>
                      <span
                        className={`renombrar-badge${row.origin === 'a mano' ? ' is-hand' : ''}`}
                      >
                        {row.origin}
                      </span>
                    </td>
                    <td className="renombrar-cell-actions">
                      {/* No hay navegación al explorador con una carpeta como
                          parámetro: se muestra la ruta en vez de un botón que
                          llevaría a la raíz. */}
                      {row.exists ? (
                        <span className="renombrar-folder" title={parentOf(row.dst)}>
                          {parentOf(row.dst)}
                        </span>
                      ) : (
                        <span className="renombrar-when">El fichero ya no está</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {editing && (
        <LibraryRenameDialog
          path={editing}
          onClose={() => setEditing(null)}
          onRenamed={(detail) => {
            setReport({ ok: true, lines: [detail] })
            void queryClient.invalidateQueries({ queryKey: ['rename-candidates'] })
            void queryClient.invalidateQueries({ queryKey: ['renames'] })
          }}
        />
      )}
    </section>
  )
}

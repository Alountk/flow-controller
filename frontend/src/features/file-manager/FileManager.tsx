import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { FileItem, RetentionFile } from '../../shared/types.ts'
import {
  fetchRoots,
  fetchRetention,
  createDirectory,
  renameItem,
  deleteItem,
  queueAdd,
} from '../../shared/api/files.ts'
import { filterByName, useBrowse } from '../../shared/hooks/useFilesNavigator.ts'
import { FileNavigator, type FileNavigatorEntry } from '../../shared/ui/FileNavigator.tsx'
import { areAllVisibleSelected, toggleVisibleSelection } from '../../shared/utils/selection.ts'
import './FileManager.css'

/** "1 colocado" / "7 colocados" — a count without an agreement is noise. */
function countWord(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** One item's outcome. The backend answers per file, never per batch. */
interface BatchOutcome {
  path: string
  name: string
  ok: boolean
  detail: string
}

/**
 * What the last batch left behind. Only the refusals are kept on screen: a
 * summary of successes is a toast, but a failure has to stay readable with the
 * backend's own reason until the user dismisses it.
 */
interface BatchReport {
  failures: BatchOutcome[]
  total: number
}

interface RootsItem {
  path: string
  name: string
  role?: 'navigation' | 'library' | '4k' | '3d'
  label?: string
  service?: string
}

interface PaneProps {
  roots: RootsItem[]
  index: number
  otherPath: string
  onPathChange: (index: number, path: string) => void
}

function FilePane({ roots, index, otherPath, onPathChange }: PaneProps) {
  const queryClient = useQueryClient()
  const initialRoot = roots[index]?.path || roots[0]?.path || '/'
  const [selectedRoot, setSelectedRoot] = useState(initialRoot)
  const [path, setPath] = useState(initialRoot)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [nameFilter, setNameFilter] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const filterRef = useRef<HTMLInputElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const onPathChangeRef = useRef<((index: number, path: string) => void) | null>(null)
  onPathChangeRef.current = onPathChange

  const { data: browseData, isLoading } = useBrowse(path, !!path)

  // Ages for the directory just browsed, keyed by the RESOLVED path the
  // backend answered with — both listings come from that same resolution, so
  // the two can be joined by path without guessing.
  const resolvedPath = browseData?.ok ? browseData.path : null
  const { data: retentionData } = useQuery({
    queryKey: ['retention', resolvedPath],
    queryFn: () => fetchRetention(resolvedPath!),
    enabled: resolvedPath !== null,
    // Navigating must not blank the chips already on screen: the previous
    // directory's ages stay visible until the new ones arrive, and the join
    // is by absolute path, so a stale row can never light up the wrong file.
    placeholderData: keepPreviousData,
  })

  useEffect(() => {
    if (browseData?.ok) {
      setSelected(new Set())
      onPathChangeRef.current?.(index, browseData.path)
    } else if (browseData?.error) {
      setError(browseData.error)
    }
  }, [browseData, index])

  // «/» jumps to the filter (S11c). The input guard keeps the key typing in
  // create/rename fields; `defaultPrevented` hands the key to one pane only.
  useEffect(() => {
    function onShortcut(e: KeyboardEvent) {
      if (e.key !== '/' || e.defaultPrevented) return
      const active = document.activeElement
      if (active instanceof HTMLElement && active.closest('input, textarea, select, [contenteditable]')) return
      if (active !== document.body && !paneRef.current?.contains(active)) return
      e.preventDefault()
      filterRef.current?.focus()
    }
    document.addEventListener('keydown', onShortcut)
    return () => document.removeEventListener('keydown', onShortcut)
  }, [])

  const invalidateBrowse = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['files-browse', path] })
  }, [queryClient, path])

  const createDir = useMutation({
    mutationFn: (fullPath: string) => createDirectory(fullPath),
    onSuccess: (res) => {
      if (res.ok) {
        setCreating(false)
        setNewName('')
        invalidateBrowse()
        showToast('Carpeta creada')
      } else {
        setError(res.detail)
      }
    },
  })

  const rename = useMutation({
    mutationFn: ({ oldPath, newPath }: { oldPath: string; newPath: string }) => renameItem(oldPath, newPath),
    onSuccess: (res) => {
      if (res.ok) {
        setRenaming(null)
        invalidateBrowse()
      } else {
        setError(res.detail)
      }
    },
  })

  const del = useMutation({
    mutationFn: (p: string) => deleteItem(p),
    onSuccess: (res) => {
      if (res.ok) {
        invalidateBrowse()
      } else {
        setError(res.detail)
      }
    },
  })

  const queue = useMutation({
    mutationFn: ({ type, src, dst }: { type: 'copy' | 'move'; src: string; dst: string }) =>
      queueAdd(type, src, dst),
    onSuccess: (res) => {
      if (res.ok) {
        showToast(`${res.detail}`)
        queryClient.invalidateQueries({ queryKey: ['queue'] })
      } else {
        setError(res.detail)
      }
    },
  })

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  function handleCopyPath(target: string) {
    void navigator.clipboard
      .writeText(target)
      .then(() => showToast('Ruta copiada'))
      .catch(() => setError('No se pudo copiar la ruta'))
  }

  function navigateTo(p: string) {
    setSelected(new Set())
    setPath(p)
  }

  function handleVolumeChange(newRoot: string) {
    setSelectedRoot(newRoot)
    setSelected(new Set())
    setPath(newRoot)
  }

  function parentDir() {
    if (path === selectedRoot) return selectedRoot
    const parts = path.split('/')
    const parent = parts.slice(0, -1).join('/') || '/'
    if (parent.length < selectedRoot.length || !parent.startsWith(selectedRoot)) {
      return selectedRoot
    }
    return parent
  }

  function handleCreate() {
    if (!newName.trim()) return
    createDir.mutate(`${path}/${newName.trim()}`)
  }

  function handleRename(item: FileNavigatorEntry) {
    if (!renameValue.trim() || renameValue === item.name) {
      setRenaming(null)
      return
    }
    const dir = item.path.substring(0, item.path.lastIndexOf('/'))
    rename.mutate({ oldPath: item.path, newPath: `${dir}/${renameValue.trim()}` })
  }

  function handleDelete(item: FileNavigatorEntry) {
    if (!confirm(`¿Eliminar ${item.name}?`)) return
    del.mutate(item.path)
  }

  function handleQueue(type: 'copy' | 'move', item: FileNavigatorEntry) {
    const dst = `${otherPath}/${item.name}`
    queue.mutate({ type, src: item.path, dst })
  }

  const items = browseData?.ok ? browseData.items : []
  const itemKey = (item: FileItem) => item.path
  // The shared name filter; an unfiltered pane keeps the whole listing and
  // every on-screen action below (selection, batch) works on exactly it.
  const visibleItems = filterByName(items, nameFilter)
  const allVisibleSelected = areAllVisibleSelected(selected, visibleItems, itemKey)

  // The join: the retention endpoint answers a top-level `path` plus each
  // file's `name`, while rows are keyed by `item.path`. Both come from the
  // same resolved directory, so `path + '/' + name` IS `item.path` — no
  // fallback here on purpose: a key that does not match must not be papered
  // over with a fuzzy lookup, it would mean the two responses disagree.
  const retentionByPath = new Map<string, RetentionFile>(
    (retentionData?.files ?? []).map((f) => [`${retentionData!.path}/${f.name}`, f]),
  )
  const expiredPaths = visibleItems
    .filter((item) => retentionByPath.get(item.path)?.expired)
    .map((item) => item.path)

  /** The row's retention chip. Unknown age (`null`: store unreadable) and
   *  files the endpoint did not report render NOTHING — a fabricated age
   *  could justify deleting a file that was never recorded. */
  function ageChip(item: FileNavigatorEntry) {
    const info = retentionByPath.get(item.path)
    if (!info) return null
    // Caducado is a STATE, not an error: `--warn`, never `--bad`.
    if (info.expired) return <span className="fm-age expired">caducado</span>
    if (info.age_days === null) return null
    if (info.age_days < 1) return <span className="fm-age">hoy</span>
    const days = Math.floor(info.age_days)
    return <span className="fm-age">hace {days} {days === 1 ? 'día' : 'días'}</span>
  }

  /** The row's provenance chip (F-07): why the file is here — `cola ·
   *  importando` / `histórico` / `lo pedimos nosotros`. Display-only: it
   *  explains, it never gates. A file no source claims (`null`, both fields
   *  together) renders NOTHING — same honesty rule as the age chip, because
   *  a guessed provenance would be a claim nobody made. */
  function provenanceChip(item: FileNavigatorEntry) {
    const label = retentionByPath.get(item.path)?.provenance_label
    if (!label) return null
    return <span className="fm-prov">{label}</span>
  }

  function toggleRowSelection(itemPath: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(itemPath)) next.delete(itemPath)
      else next.add(itemPath)
      return next
    })
  }

  function toggleAllSelection() {
    // The shared helper, never a second copy: select-all only ever touches the
    // rows currently on screen, so it cannot act on a file nobody is looking at.
    setSelected((prev) => toggleVisibleSelection(prev, visibleItems, itemKey))
  }

  // The rows below are FileNavigator's; these four slots keep the pane's own
  // row content (selection, inline rename, path cell, chips, buttons) in JSX.

  function renderRowStart(entry: FileNavigatorEntry) {
    return (
      <input
        type="checkbox"
        className="fm-item-check"
        checked={selected.has(entry.path)}
        onChange={() => toggleRowSelection(entry.path)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Seleccionar ${entry.name}`}
      />
    )
  }

  function renderRowName(entry: FileNavigatorEntry) {
    if (renaming !== entry.path) return <span className="fm-name">{entry.name}</span>
    return (
      <input
        className="fm-rename-input"
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleRename(entry)
          if (e.key === 'Escape') setRenaming(null)
        }}
        onBlur={() => handleRename(entry)}
        autoFocus
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  function renderFileMeta(entry: FileNavigatorEntry) {
    return (
      <>
        {/* Derived from the row's data, never invented — a row with no path
            renders no path cell. */}
        {entry.path && <span className="fm-row-path" title={entry.path}>{entry.path}</span>}
        {ageChip(entry)}
        {provenanceChip(entry)}
      </>
    )
  }

  function renderRowActions(entry: FileNavigatorEntry) {
    return (
      <>
        <button
          className="fm-sm-btn accent"
          title="Copiar al otro panel"
          onClick={(e) => { e.stopPropagation(); handleQueue('copy', entry) }}
        >
          ⬎
        </button>
        <button
          className="fm-sm-btn accent"
          title="Mover al otro panel"
          onClick={(e) => { e.stopPropagation(); handleQueue('move', entry) }}
        >
          ⬏
        </button>
        <button
          className="fm-sm-btn"
          title="Copiar ruta absoluta POSIX"
          aria-label="Copiar ruta absoluta POSIX"
          onClick={(e) => { e.stopPropagation(); handleCopyPath(entry.path) }}
        >
          ⧉
        </button>
        <button
          className="fm-sm-btn"
          title="Renombrar"
          onClick={(e) => {
            e.stopPropagation()
            setRenaming(entry.path)
            setRenameValue(entry.name)
          }}
        >
          ✏
        </button>
        <button
          className="fm-sm-btn danger"
          title="Eliminar"
          onClick={(e) => { e.stopPropagation(); handleDelete(entry) }}
        >
          🗑
        </button>
      </>
    )
  }

  /**
   * One batch: one request per file, one honest result per file.
   *
   * Sequential on purpose — these endpoints talk to a network mount, and N
   * concurrent unlinks against CIFS is how you get timeouts. Copy/move only
   * enqueues (the queue is already sequential and SQLite-backed), but delete
   * runs the unlinks itself, so both go through the same loop.
   */
  async function runBatch(action: 'copy' | 'move' | 'delete') {
    // Selection dies on navigation AND on a filter change, so every selected
    // path belongs to the rows currently on screen.
    const targets = visibleItems.filter((item) => selected.has(item.path))
    if (targets.length === 0 || batchBusy) return

    setBatchBusy(true)
    setBatchReport(null)

    const results: BatchOutcome[] = []
    for (const item of targets) {
      let res: { ok: boolean; detail: string }
      try {
        res = action === 'delete'
          ? await deleteItem(item.path)
          : await queueAdd(action, item.path, `${otherPath}/${item.name}`)
      } catch (err) {
        // A dead mount is one failed item, not a reason to drop the rest.
        res = { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
      results.push({ path: item.path, name: item.name, ok: res.ok, detail: res.detail })
    }

    const failures = results.filter((r) => !r.ok)
    setBatchBusy(false)
    setBatchReport(failures.length > 0 ? { failures, total: results.length } : null)
    // The batch is consumed either way: leaving the rows selected would invite
    // a second click that enqueues everything a second time.
    setSelected(new Set())

    const okCount = results.length - failures.length
    const done = action === 'delete'
      ? countWord(okCount, 'eliminado', 'eliminados')
      : countWord(okCount, 'colocado', 'colocados')
    showToast(`${done}, ${countWord(failures.length, 'rechazado', 'rechazados')}`)

    if (action === 'delete') {
      // The unlinks change what the retention endpoint answers: rows for the
      // deleted files get pruned, so its cache must be re-read, not trusted.
      invalidateBrowse()
      queryClient.invalidateQueries({ queryKey: ['retention'] })
    } else queryClient.invalidateQueries({ queryKey: ['queue'] })
  }

  function handleBatchDelete() {
    const n = selected.size
    const what = n === 1 ? 'elemento seleccionado' : 'elementos seleccionados'
    const message = `¿Eliminar ${n} ${what}? Esta acción no se puede deshacer: no podrás recuperar los datos borrados.`
    if (!confirm(message)) return
    void runBatch('delete')
  }

  // Plain options first, then the configured destinations in their own group —
  // the mounts are what the panes navigate, the labelled roots are places you
  // jump to. The group only renders when there is something to group.
  const plainRoots = roots.filter((r) => !r.role || r.role === 'navigation')
  const destinationRoots = roots.filter((r) => r.role && r.role !== 'navigation')

  return (
    <div className="fm-pane">
      <div className="fm-toolbar">
        <select
          className="fm-volume-select"
          value={selectedRoot}
          onChange={(e) => handleVolumeChange(e.target.value)}
        >
          {plainRoots.map((r) => (
            <option key={r.path} value={r.path}>{r.label ?? r.name}</option>
          ))}
          {destinationRoots.length > 0 && (
            <optgroup label="Destinos">
              {destinationRoots.map((r) => (
                <option key={r.path} value={r.path}>{r.label ?? r.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          className="fm-nav-btn"
          onClick={() => navigateTo(parentDir())}
          title="Subir"
          disabled={path === selectedRoot}
        >
          ⬆
        </button>
        {/* Clickable breadcrumb (S11a): each segment navigates to that
            ancestor, clamped to the selected volume — never above it. */}
        <div className="fm-path" title={path}>
          {path.split('/').filter(Boolean).map((seg, i, segs) => {
            const target = `/${segs.slice(0, i + 1).join('/')}`
            const inside =
              target === selectedRoot || target.startsWith(`${selectedRoot.replace(/\/$/, '')}/`)
            return (
              <Fragment key={`${i}-${seg}`}>
                <span className="fm-crumb-sep">/</span>
                {inside ? (
                  <button type="button" className="fm-crumb-btn" onClick={() => navigateTo(target)}>
                    {seg}
                  </button>
                ) : (
                  <span className="fm-crumb-seg">{seg}</span>
                )}
              </Fragment>
            )
          })}
        </div>
        <input
          type="search"
          className="fm-filter"
          ref={filterRef}
          placeholder="Buscar carpeta o archivo... [ / ]"
          aria-label="Filtrar archivos"
          value={nameFilter}
          onChange={(e) => {
            setNameFilter(e.target.value)
            // The selection describes rows on screen: a row the filter hides
            // can no longer be acted on, so it leaves the selection — the
            // same rule navigation already applies.
            setSelected(new Set())
          }}
        />
        <button className="fm-action-btn" onClick={() => setCreating(true)}>
          + Carpeta
        </button>
        <button className="fm-action-btn" onClick={invalidateBrowse}>
          ↻
        </button>
        {expiredPaths.length > 0 && (
          <button
            className="fm-action-btn"
            onClick={() => setSelected(new Set(expiredPaths))}
            title="Selecciona solo los que ya han pasado la ventana de retención"
          >
            Marcar caducados
          </button>
        )}
      </div>

      {error && <div className="fm-error" onClick={() => setError(null)}>{error}</div>}
      {toast && <div className="fm-toast">{toast}</div>}

      {creating && (
        <div className="fm-input-row">
          <input
            className="fm-input"
            placeholder="Nombre de la carpeta..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
            autoFocus
          />
          <button className="fm-action-btn" onClick={handleCreate}>Crear</button>
          <button className="fm-cancel-btn" onClick={() => setCreating(false)}>Cancelar</button>
        </div>
      )}

      {visibleItems.length > 0 && (
        <div className="fm-select-bar">
          <label className="fm-select-all">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAllSelection}
            />
            <span>Seleccionar todo</span>
          </label>
        </div>
      )}

      {selected.size > 0 && (
        <div className="fm-batch-bar">
          <span className="fm-batch-count">
            {selected.size} seleccionado{selected.size === 1 ? '' : 's'}
          </span>
          <button
            className="fm-action-btn"
            onClick={() => runBatch('copy')}
            disabled={batchBusy}
          >
            Copiar
          </button>
          <button
            className="fm-action-btn"
            onClick={() => runBatch('move')}
            disabled={batchBusy}
          >
            Mover
          </button>
          <button
            className="fm-action-btn"
            onClick={handleBatchDelete}
            disabled={batchBusy}
          >
            Eliminar
          </button>
          <button
            className="fm-cancel-btn"
            onClick={() => setSelected(new Set())}
            disabled={batchBusy}
          >
            Limpiar
          </button>
        </div>
      )}

      {batchReport && (
        <div className="fm-batch-report">
          <div className="fm-batch-report-head">
            <span className="fm-batch-report-title">
              Rechazados: {batchReport.failures.length} de {batchReport.total}
            </span>
            <button
              className="fm-cancel-btn"
              title="Cerrar detalle"
              onClick={() => setBatchReport(null)}
            >
              ✕
            </button>
          </div>
          <ul className="fm-batch-report-list">
            {batchReport.failures.map((f) => (
              <li key={f.path} className="fm-batch-report-item">
                <span className="fm-batch-report-name">{f.name}</span>
                <span className="fm-batch-report-detail">{f.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isLoading ? (
        <div className="fm-loading">Cargando...</div>
      ) : items.length === 0 ? (
        <div className="fm-empty">Directorio vacío</div>
      ) : visibleItems.length === 0 ? (
        // Same dim line as an empty directory — a filter that matches
        // nothing still has to say so instead of leaving a blank pane.
        <div className="fm-empty">Sin resultados</div>
      ) : (
        <>
          <div className="fm-head-row">
            <span>Nombre</span>
            <span>Procedencia</span>
            <span>Retención</span>
            <span>Tamaño</span>
            <span>Modificado</span>
            <span>Acciones</span>
          </div>
          <FileNavigator
            variant="region"
            mode="both"
            layout="rows"
            path={path}
            filter={nameFilter}
            showIcons
            showSizes
            showDates
            onNavigate={navigateTo}
            isRowSelected={(entry) => selected.has(entry.path)}
            onRowClick={(entry) => setSelected(new Set([entry.path]))}
            renderRowStart={renderRowStart}
            renderRowName={renderRowName}
            renderFileMeta={renderFileMeta}
            renderRowActions={renderRowActions}
          />
        </>
      )}
    </div>
  )
}

export function FileManager() {
  const [panePaths, setPanePaths] = useState<Record<number, string>>({})

  const { data: rootsData } = useQuery({
    queryKey: ['roots'],
    queryFn: fetchRoots,
  })

  const roots = rootsData?.roots ?? []

  const handlePathChange = useCallback((index: number, path: string) => {
    setPanePaths((prev) => ({ ...prev, [index]: path }))
  }, [])

  function getOtherPath(currentIndex: number): string {
    const otherIndex = currentIndex === 0 ? 1 : 0
    return panePaths[otherIndex] || roots[otherIndex]?.path || '/'
  }

  return (
    <section className="fm">
      <div className="fm-header">
        <h2>Explorador de Archivos</h2>
      </div>

      <div className="fm-dual">
        {roots.length >= 2 && (
          <>
            <FilePane
              key="pane-0"
              roots={roots}
              index={0}
              otherPath={getOtherPath(0)}
              onPathChange={handlePathChange}
            />
            <FilePane
              key="pane-1"
              roots={roots}
              index={1}
              otherPath={getOtherPath(1)}
              onPathChange={handlePathChange}
            />
          </>
        )}
        {roots.length === 1 && (
          <FilePane
            key="pane-0"
            roots={roots}
            index={0}
            otherPath={panePaths[0] || roots[0]?.path || '/'}
            onPathChange={handlePathChange}
          />
        )}
      </div>
    </section>
  )
}

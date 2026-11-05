import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  filterByName,
  formatDate,
  formatSize,
  parentDir,
  useBrowse,
  useRoots,
} from '../hooks/useFilesNavigator.ts'
import './FileExplorer.css'

/**
 * El explorador de archivos de la app. Uno solo, con las mismas cinco zonas en
 * todas partes: ruta, herramientas, cabecera, filas y pie.
 *
 * Lo único que cambia entre un sitio y otro es el MARCO (`page` dentro de la
 * página, `dialog` en un modal) y las capacidades que inyecta quien lo usa.
 * No hay banderas para esconder zonas: cinco exploradores distintos salieron de
 * exactamente eso.
 */

export interface FileExplorerEntry {
  key: string
  name: string
  path: string
  isDir: boolean
  /** The backend's `is_video`; absent means unknown, never "not a video". */
  isVideo?: boolean
  size: number
  modified: number
}

export interface ExplorerRoot {
  path: string
  name: string
  /** The words the picker shows when they say more than the name. */
  label?: string
  role?: 'navigation' | 'library' | '4k' | '3d'
}

export type ExplorerPresentation = 'page' | 'dialog'

/** `folders` never lists files: a destination is never a file. */
export type ExplorerAccept = 'folders' | 'files' | 'both'

interface FileExplorerProps {
  presentation?: ExplorerPresentation
  /** `dialog` only: the caller mounts the explorer while it is open. */
  open?: boolean
  accept: ExplorerAccept
  title?: string
  subtitle?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Seeded once on mount — consumers remount the explorer per open. */
  initialPath?: string
  /** Controlled current path: navigation reports via `onNavigate`, the caller
   *  drives the listing (Archivos navigates from its own panes). */
  path?: string
  /** Controlled name filter; without it the explorer's own input drives it. */
  filter?: string
  onFilterChange?(value: string): void
  /** Hide files the backend classifies as non-video; `is_video` absent stays
   *  visible — unknown, never "not a video" (shared/types.ts). */
  onlyVideo?: boolean
  rootLabel?: string
  emptyLabel?: string
  /** Buttons the caller owns, drawn on the toolbar's right: create a folder,
   *  mark expired rows, copy to the other pane. Content, never chrome. */
  toolbarActions?: ReactNode
  /** Row slots: the checkbox, an inline-rename name cell, extra meta under the
   *  name, and the right-hand actions. Content, never chrome. */
  renderRowStart?: (entry: FileExplorerEntry) => ReactNode
  renderRowName?: (entry: FileExplorerEntry) => ReactNode
  renderFileMeta?: (entry: FileExplorerEntry) => ReactNode
  renderRowActions?: (entry: FileExplorerEntry) => ReactNode
  isRowSelected?: (entry: FileExplorerEntry) => boolean
  /** Row single-click; without it a row click opens directories. */
  onRowClick?(entry: FileExplorerEntry): void
  onNavigate?(path: string): void
  onSelect?(path: string): void
  onConfirm?(path: string): void
  onCancel?(): void
}

/** Root select, breadcrumbs and up/refresh: the explorer's first zone, and on
 *  its own for the screens that only need to say where they are looking. */
export function PathBar({
  roots,
  path,
  onNavigate,
  onRefresh,
  rootLabel,
  allRootsLabel,
}: {
  roots: ExplorerRoot[]
  path: string
  onNavigate(path: string): void
  onRefresh?(): void
  rootLabel?: string
  /** Present only where «todas las raíces» is a place you can be. */
  allRootsLabel?: string
}) {
  // The mounts are what a pane navigates; the labelled roots are places you
  // jump to. Grouping only when both kinds exist, or the group is noise.
  const destinations = roots.filter((root) => root.role && root.role !== 'navigation')
  const navigable = roots.filter((root) => !root.role || root.role === 'navigation')
  const rootPaths = roots.map((root) => root.path)
  const containingRoot =
    rootPaths.find((root) => path === root || path.startsWith(`${root}/`)) ?? ''
  const rest = containingRoot ? path.slice(containingRoot.length).split('/').filter(Boolean) : []

  return (
    <div className="explorer-bar">
      {rootLabel && (
        <label className="explorer-bar-label" htmlFor="explorer-root">
          {rootLabel}
        </label>
      )}
      <select
        className="explorer-select"
        id="explorer-root"
        name="explorer-root"
        value={containingRoot}
        onChange={(event) => onNavigate(event.target.value)}
      >
        {allRootsLabel && <option value="">{allRootsLabel}</option>}
        {navigable.length > 0 && destinations.length > 0 ? (
          <>
            <optgroup label="Raíces">
              {navigable.map((root) => (
                <option key={root.path} value={root.path}>
                  {root.label ?? root.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Destinos">
              {destinations.map((root) => (
                <option key={root.path} value={root.path}>
                  {root.label ?? root.name}
                </option>
              ))}
            </optgroup>
          </>
        ) : (
          roots.map((root) => (
            <option key={root.path} value={root.path}>
              {root.label ?? root.name}
            </option>
          ))
        )}
      </select>

      <nav className="explorer-crumbs" aria-label="Ruta">
        {path === '' ? (
          <span className="explorer-crumb is-muted">Todas las raíces</span>
        ) : (
          <>
            <button
              type="button"
              className="explorer-crumb"
              onClick={() => onNavigate(containingRoot)}
            >
              {containingRoot}
            </button>
            {rest.map((segment, index) => {
              const target = `${containingRoot}/${rest.slice(0, index + 1).join('/')}`
              return (
                <Fragment key={target}>
                  <span className="explorer-crumb-sep" aria-hidden="true">
                    ›
                  </span>
                  <button
                    type="button"
                    className="explorer-crumb"
                    onClick={() => onNavigate(target)}
                    title={target}
                  >
                    {segment}
                  </button>
                </Fragment>
              )
            })}
          </>
        )}
      </nav>

      <button
        type="button"
        className="explorer-btn"
        onClick={() => onNavigate(parentDir(path, rootPaths))}
        disabled={path === ''}
      >
        ⬆ Subir
      </button>
      {onRefresh && (
        <button type="button" className="explorer-btn" title="Refrescar listado" onClick={onRefresh}>
          ⟳ Refrescar
        </button>
      )}
    </div>
  )
}

/** One row's type, from what the backend said about it. */
function typeOf(entry: FileExplorerEntry): string {
  if (entry.isDir) return 'Carpeta'
  return entry.isVideo === false ? 'Fichero' : 'Vídeo'
}

export function FileExplorer({
  presentation = 'page',
  open,
  accept,
  title = 'Elegir carpeta',
  subtitle,
  confirmLabel,
  cancelLabel = 'Cancelar',
  initialPath,
  path,
  filter,
  onFilterChange,
  onlyVideo = false,
  rootLabel,
  emptyLabel = 'Carpeta vacía',
  toolbarActions,
  renderRowStart,
  renderRowName,
  renderFileMeta,
  renderRowActions,
  isRowSelected,
  onRowClick,
  onNavigate,
  onSelect,
  onConfirm,
  onCancel,
}: FileExplorerProps) {
  const active = open ?? true
  const [internalPath, setInternalPath] = useState(initialPath ?? '')
  // Controlled callers drive navigation from their own chrome.
  const currentPath = path ?? internalPath
  const [picked, setPicked] = useState<string | null>(null)
  const [internalFilter, setInternalFilter] = useState('')
  const query = filter ?? internalFilter
  const rootsQuery = useRoots(active)
  const roots = rootsQuery.data?.roots ?? []
  const browseQuery = useBrowse(currentPath, active && currentPath !== '')

  function visit(next: string) {
    if (path === undefined) setInternalPath(next)
    setPicked(null)
    onNavigate?.(next)
  }

  // Roots carry their display name; a directory listing drops files entirely in
  // folder mode — a destination is never a file.
  const entries: FileExplorerEntry[] =
    currentPath === ''
      ? roots.map((root) => ({
          key: root.path,
          name: root.name,
          path: root.path,
          isDir: true,
          size: 0,
          modified: 0,
        }))
      : (browseQuery.data?.items ?? [])
          .filter((entry) => accept !== 'folders' || entry.is_dir)
          .filter((entry) => !onlyVideo || entry.is_dir || entry.is_video !== false)
          .map((entry) => ({
            key: entry.path,
            name: entry.name,
            path: entry.path,
            isDir: entry.is_dir,
            isVideo: entry.is_video,
            size: entry.size,
            modified: entry.modified,
          }))

  const visible = filterByName(entries, query)
  const chosen = picked ?? (currentPath === '' ? null : currentPath)

  useEffect(() => {
    setPicked(null)
  }, [currentPath])

  // A region lives inside a root and starts there; a dialog starts by asking
  // which root. `page` is the frame the panes and the pickers embed.
  useEffect(() => {
    if (presentation === 'page' && path === undefined && currentPath === '' && roots[0]) {
      visit(roots[0].path)
    }
  }, [presentation, path, currentPath, roots])


  if (!active) return null

  function activate(entry: FileExplorerEntry) {
    if (onRowClick) {
      onRowClick(entry)
      return
    }
    if (entry.isDir) {
      visit(entry.path)
      return
    }
    setPicked(entry.path)
    onSelect?.(entry.path)
  }

  const chrome = (
    <>
      <PathBar
        roots={roots}
        path={currentPath}
        onNavigate={visit}
        onRefresh={currentPath === '' ? undefined : () => void browseQuery.refetch()}
        rootLabel={rootLabel}
      />

      <div className="explorer-toolbar">
        <input
          type="search"
          className="explorer-filter"
          placeholder="Filtrar por nombre…"
          aria-label="Filtrar por nombre"
          value={query}
          onChange={(event) => (onFilterChange ?? setInternalFilter)(event.target.value)}
        />
        <span className="explorer-count">
          {visible.length} {visible.length === 1 ? 'elemento' : 'elementos'}
        </span>
        {toolbarActions && <span className="explorer-toolbar-actions">{toolbarActions}</span>}
      </div>

      <div className="explorer-head">
        <span className="explorer-col-name">Nombre</span>
        <span className="explorer-col-type">Tipo</span>
        <span className="explorer-col-size">Tamaño</span>
        <span className="explorer-col-date">Modificado</span>
        {renderRowActions && <span className="explorer-col-actions">Acciones</span>}
      </div>

      <div className="explorer-rows">
        {visible.map((entry) => (
          <div
            key={entry.key}
            className={`explorer-row${isRowSelected?.(entry) || picked === entry.path ? ' is-selected' : ''}${entry.isDir ? ' is-dir' : ''}`}
            onClick={() => activate(entry)}
            onDoubleClick={() =>
              entry.isDir ? visit(entry.path) : onConfirm?.(entry.path)
            }
          >
            {/* The checkbox cell exists even without a slot: a grid that
                shifts one column left squeezes the name to three letters. */}
            <span className="explorer-check">{renderRowStart?.(entry)}</span>
            <span className="explorer-icon" aria-hidden="true">
              {entry.isDir ? '📁' : entry.isVideo === false ? '📄' : '🎬'}
            </span>
            <div className="explorer-name">
              {/* Without a caller slot the name IS the keyboard path; with one,
                  the caller's own content decides how a row is opened. */}
              {renderRowName ? (
                renderRowName(entry)
              ) : (
                <button
                  type="button"
                  className="explorer-open"
                  title={entry.name}
                  onClick={(event) => {
                    event.stopPropagation()
                    activate(entry)
                  }}
                >
                  {entry.name}
                </button>
              )}
              {renderFileMeta && <div className="explorer-meta">{renderFileMeta(entry)}</div>}
            </div>
            <span className="explorer-type">{typeOf(entry)}</span>
            <span className="explorer-size">{entry.isDir ? '—' : formatSize(entry.size)}</span>
            <span className="explorer-date">{formatDate(entry.modified)}</span>
            <div className="explorer-actions">{renderRowActions?.(entry)}</div>
          </div>
        ))}
        {visible.length === 0 && (
          // A filter that matches nothing says so in the same words everywhere;
          // an empty folder says what the caller calls it.
          <div className="explorer-empty">
            {query.trim() ? 'Sin coincidencias' : emptyLabel}
          </div>
        )}
      </div>

      <footer className="explorer-foot">
        <span className="explorer-foot-count">
          <span className="explorer-foot-path" title={chosen ?? currentPath}>
            {chosen ?? (currentPath || '—')}
          </span>
        </span>
        {presentation === 'dialog' ? (
          <span className="explorer-foot-actions">
            <button type="button" className="explorer-btn" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className="explorer-btn is-primary"
              disabled={!chosen}
              onClick={() => chosen && onConfirm?.(chosen)}
            >
              {confirmLabel ?? (accept === 'folders' ? 'Elegir esta carpeta' : 'Elegir este fichero')}
            </button>
          </span>
        ) : (
          <span className="explorer-foot-count">Mostrando {visible.length}</span>
        )}
      </footer>
    </>
  )

  if (presentation === 'dialog') {
    return (
      <>
        <div className="explorer-backdrop" onClick={onCancel} />
        <div className="explorer-dialog" role="dialog" aria-label={title}>
          <header className="explorer-dialog-head">
            <div>
              <h2 className="explorer-dialog-title">{title}</h2>
              {subtitle && <p className="explorer-dialog-subtitle">{subtitle}</p>}
            </div>
            <button type="button" className="explorer-dialog-close" onClick={onCancel} aria-label="Cerrar">
              ✕
            </button>
          </header>
          {chrome}
        </div>
      </>
    )
  }

  return <div className="explorer">{chrome}</div>
}

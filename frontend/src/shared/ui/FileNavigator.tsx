import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { formatSize, parentDir, useBrowse, useRoots } from '../hooks/useFilesNavigator.ts'
import './FileNavigator.css'

export interface FileNavigatorEntry {
  key: string
  name: string
  path: string
  isDir: boolean
  size: number
}

interface FileNavigatorProps {
  /** `dialog` is the F1 modal picker; `region` embeds the same navigator in
   *  the caller's own modal chrome, with no backdrop or dialog semantics. */
  variant?: 'dialog' | 'region'
  open?: boolean
  /** Seeded once on mount — consumers remount the navigator per open. */
  initialPath?: string
  /** F1 ships `folder` fully; `file`/`both` also list files, and a file row
   *  click confirms that file — no other file affordances exist yet. */
  mode: 'folder' | 'file' | 'both'
  ariaLabel?: string
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  hint?: string
  /** Region: roots as a `<select>` row instead of the dialog's list view. */
  rootPicker?: 'list' | 'select'
  rootLabel?: string
  /** Empty-option label; without it the path auto-seeds to the first root. */
  selectPlaceholder?: string
  showRefresh?: boolean
  showFilter?: boolean
  showIcons?: boolean
  showSizes?: boolean
  /** Region: one mixed listing (scan) or dirs over files (mixer picker). */
  layout?: 'unified' | 'split'
  selection?: 'none' | 'file'
  renderFileMeta?: (entry: FileNavigatorEntry) => ReactNode
  emptyLabel?: string
  onNavigate?(path: string): void
  onSelect?(path: string): void
  onConfirm?(path: string): void
  onCancel?(): void
}

/** Modal file/folder navigator over the allowed roots: roots view at '',
 *  breadcrumbs up the chain, and every navigation reported via `onNavigate`. */
export function FileNavigator({
  variant = 'dialog',
  open,
  initialPath,
  mode,
  ariaLabel = 'Elegir carpeta de destino',
  title = 'Elegir carpeta de destino',
  confirmLabel = 'Elegir esta carpeta',
  cancelLabel = 'Cancelar',
  hint,
  rootPicker = 'list',
  rootLabel,
  selectPlaceholder,
  showRefresh = false,
  showFilter = false,
  showIcons = false,
  showSizes = false,
  layout = 'unified',
  selection = 'none',
  renderFileMeta,
  emptyLabel,
  onNavigate,
  onSelect,
  onConfirm,
  onCancel,
}: FileNavigatorProps) {
  // Region callers mount the navigator only while their modal is open.
  const active = open ?? true
  const [path, setPath] = useState(initialPath ?? '')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const rootsQuery = useRoots(active)
  const roots = rootsQuery.data?.roots ?? []
  const rootPaths = roots.map((root) => root.path)
  const browseQuery = useBrowse(path, active && path !== '')

  function visit(next: string) {
    setPath(next)
    setSelectedFile(null)
    onNavigate?.(next)
  }

  function goUp() {
    visit(parentDir(path, rootPaths))
  }

  // No placeholder option means the caller wants to open on the first root —
  // the mixer picker has no origins state to show.
  useEffect(() => {
    const first = roots[0]
    if (rootPicker === 'select' && selectPlaceholder === undefined && path === '' && first) {
      visit(first.path)
    }
  }, [rootPicker, selectPlaceholder, path, roots])

  // Roots carry their display name; a directory listing is filtered to
  // directories only in folder mode — a file is never a destination.
  const entries: FileNavigatorEntry[] =
    path === ''
      ? roots.map((root) => ({
          key: root.path,
          name: root.name,
          path: root.path,
          isDir: true,
          size: 0,
        }))
      : (browseQuery.data?.items ?? [])
          .filter((entry) => mode !== 'folder' || entry.is_dir)
          .map((entry) => ({
            key: entry.path,
            name: entry.name,
            path: entry.path,
            isDir: entry.is_dir,
            size: entry.size,
          }))

  if (!active) return null

  if (variant === 'region') {
    const query = filter.trim().toLocaleLowerCase()
    const matchesFilter = (name: string) => !query || name.toLocaleLowerCase().includes(query)
    const visibleDirs = entries.filter((e) => e.isDir && matchesFilter(e.name))
    const visibleFiles = entries.filter((e) => !e.isDir && matchesFilter(e.name))
    const visibleEntries = entries.filter((e) => matchesFilter(e.name))
    // The select shows the root holding `path`, never a guessed volume.
    const containingRoot = rootPaths.find((r) => path === r || path.startsWith(`${r}/`)) ?? ''

    return (
      <>
        {rootPicker === 'select' && (
          <div className="scan-row">
            {rootLabel && <label className="scan-label">{rootLabel}</label>}
            <select
              className="fm-volume-select"
              value={containingRoot}
              onChange={(e) => visit(e.target.value)}
            >
              {selectPlaceholder !== undefined && <option value="">{selectPlaceholder}</option>}
              {roots.map((root) => (
                <option key={root.path} value={root.path}>{root.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="fm-nav-btn"
              title="Subir"
              onClick={goUp}
              disabled={path === '' || path === containingRoot}
            >
              ⬆ Subir
            </button>
            {showRefresh && path !== '' && (
              <button
                type="button"
                className="fm-nav-btn"
                title="Refrescar listado"
                onClick={() => void browseQuery.refetch()}
              >
                ↻
              </button>
            )}
          </div>
        )}

        {showFilter && (
          <div className="scan-row">
            <input
              type="search"
              className="fm-filter-input"
              placeholder="Buscar carpeta o archivo…"
              aria-label="Buscar carpeta o archivo"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}

        {path !== '' && layout === 'unified' && (
          <div className="scan-path-list">
            <div className="scan-current-path">{path}</div>
            {visibleEntries.map((entry) =>
              entry.isDir ? (
                <div
                  key={entry.key}
                  className="scan-folder-item"
                  onClick={() => visit(entry.path)}
                >
                  {showIcons && '📁 '}{entry.name}
                </div>
              ) : (
                <div
                  key={entry.key}
                  className="scan-file-row"
                  onClick={
                    selection === 'file'
                      ? () => {
                          setSelectedFile(entry.path)
                          onSelect?.(entry.path)
                        }
                      : undefined
                  }
                >
                  {showIcons && <span className="scan-file-row-icon">📄</span>}
                  <div className="scan-file-row-main">
                    <span className="scan-file-row-name" title={entry.name}>{entry.name}</span>
                    {renderFileMeta?.(entry)}
                  </div>
                  {showSizes && <span className="scan-file-row-size">{formatSize(entry.size)}</span>}
                </div>
              ),
            )}
            {visibleEntries.length === 0 && emptyLabel && (
              <div className="scan-no-subfolders">{emptyLabel}</div>
            )}
          </div>
        )}

        {path !== '' && layout === 'split' && (
          <div className="scan-path-list">
            <div className="scan-current-path">{path}</div>
            {visibleDirs.map((entry) => (
              <div
                key={entry.key}
                className="scan-folder-item"
                onClick={() => visit(entry.path)}
              >
                {showIcons && '📁 '}{entry.name}
              </div>
            ))}
            {visibleDirs.length === 0 && (
              <div className="scan-no-subfolders">
                {!query
                  ? 'Sin subcarpetas'
                  : visibleFiles.length === 0
                    ? 'Sin coincidencias'
                    : 'Sin carpetas'}
              </div>
            )}
          </div>
        )}

        {layout === 'split' && visibleFiles.length > 0 && (
          <div className="scan-file-list">
            {visibleFiles.map((entry) => (
              <div
                key={entry.key}
                className={`scan-file-item ${selectedFile === entry.path ? 'selected' : ''}`}
                onClick={
                  selection === 'file'
                    ? () => {
                        setSelectedFile(entry.path)
                        onSelect?.(entry.path)
                      }
                    : undefined
                }
                onDoubleClick={() => onConfirm?.(entry.path)}
              >
                {showIcons && <span className="fm-icon">📄</span>}
                <span className="fm-name">{entry.name}</span>
                {showSizes && <span className="fm-size">{formatSize(entry.size)}</span>}
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <div className="folder-picker-backdrop" onClick={onCancel} />
      <div className="folder-picker" role="dialog" aria-label={ariaLabel}>
        <div className="folder-picker-header">
          <span className="folder-picker-title">{title}</span>
          <span className="folder-picker-count">
            {entries.length} elemento{entries.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="folder-picker-toolbar">
          <button type="button" className="folder-picker-up" onClick={goUp} disabled={path === ''}>
            ⬆ Subir
          </button>
        </div>
        {path !== '' && (
          <div className="folder-picker-crumb">
            {segments(path).map((seg, i) => (
              <Fragment key={`${i}-${seg}`}>
                {i > 0 && <span className="folder-picker-crumb-sep">▸</span>}
                <span className="folder-picker-crumb-seg">{seg}</span>
              </Fragment>
            ))}
          </div>
        )}
        <div className="folder-picker-rows">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className="folder-picker-row"
              onClick={() => (entry.isDir ? visit(entry.path) : onConfirm?.(entry.path))}
            >
              {entry.name}
            </button>
          ))}
        </div>
        {hint && <div className="folder-picker-hint">{hint}</div>}
        <div className="folder-picker-path">{path}</div>
        <div className="folder-picker-actions">
          <button
            type="button"
            className="folder-picker-choose"
            onClick={() => onConfirm?.(path)}
            disabled={path === ''}
          >
            {confirmLabel}
          </button>
          <button type="button" className="folder-picker-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </>
  )
}

// Plain segment names, never the full path: the exact full path must stay a
// single untouched node (the footer) for callers that match on it.
function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

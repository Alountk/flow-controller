import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  filterByName,
  formatDate,
  formatSize,
  parentDir,
  useBrowse,
  useRoots,
} from '../hooks/useFilesNavigator.ts'
import './FileNavigator.css'

export interface FileNavigatorEntry {
  key: string
  name: string
  path: string
  isDir: boolean
  size: number
  modified: number
}

interface FileNavigatorProps {
  /** `dialog` is the F1 modal picker; `region` embeds the same navigator in
   *  the caller's own modal chrome, with no backdrop or dialog semantics. */
  variant?: 'dialog' | 'region'
  open?: boolean
  /** Seeded once on mount — consumers remount the navigator per open. */
  initialPath?: string
  /** Controlled current path: navigation reports via `onNavigate`, the caller
   *  drives the listing (FileManager's panes navigate from their own toolbar). */
  path?: string
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
  /** Region: one mixed listing (scan), dirs over files (mixer picker), or
   *  dense rows with full chrome (name, meta, size, date, actions). */
  layout?: 'unified' | 'split' | 'rows'
  /** Controlled name filter applied to the rows; without it the built-in
   *  filter input's own state drives the filtering. */
  filter?: string
  /** Hide files the backend classifies as non-video; `is_video` absent stays
   *  visible — unknown, never "not a video" (shared/types.ts). */
  onlyVideo?: boolean
  selection?: 'none' | 'file'
  renderFileMeta?: (entry: FileNavigatorEntry) => ReactNode
  /** Row-layout slots: leading cell (checkbox), name-cell override (inline
   *  rename), and the right-hand actions cell. */
  renderRowStart?: (entry: FileNavigatorEntry) => ReactNode
  renderRowName?: (entry: FileNavigatorEntry) => ReactNode
  renderRowActions?: (entry: FileNavigatorEntry) => ReactNode
  /** Row layout: modified-date column and the caller's row highlight. */
  showDates?: boolean
  isRowSelected?: (entry: FileNavigatorEntry) => boolean
  /** Row single-click; without it a row click opens directories. */
  onRowClick?(entry: FileNavigatorEntry): void
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
  path,
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
  onlyVideo = false,
  filter,
  selection = 'none',
  renderFileMeta,
  renderRowStart,
  renderRowName,
  renderRowActions,
  showDates = false,
  isRowSelected,
  onRowClick,
  emptyLabel,
  onNavigate,
  onSelect,
  onConfirm,
  onCancel,
}: FileNavigatorProps) {
  // Region callers mount the navigator only while their modal is open.
  const active = open ?? true
  const [internalPath, setInternalPath] = useState(initialPath ?? '')
  // Controlled callers drive navigation from their own chrome.
  const currentPath = path ?? internalPath
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [filterState, setFilterState] = useState('')
  const rootsQuery = useRoots(active)
  const roots = rootsQuery.data?.roots ?? []
  const rootPaths = roots.map((root) => root.path)
  const browseQuery = useBrowse(currentPath, active && currentPath !== '')

  function visit(next: string) {
    if (path === undefined) setInternalPath(next)
    setSelectedFile(null)
    onNavigate?.(next)
  }

  function goUp() {
    visit(parentDir(currentPath, rootPaths))
  }

  // No placeholder option means the caller wants to open on the first root —
  // the mixer picker has no origins state to show.
  useEffect(() => {
    const first = roots[0]
    if (
      path === undefined &&
      rootPicker === 'select' &&
      selectPlaceholder === undefined &&
      currentPath === '' &&
      first
    ) {
      visit(first.path)
    }
  }, [path, rootPicker, selectPlaceholder, currentPath, roots])

  // Roots carry their display name; a directory listing is filtered to
  // directories only in folder mode — a file is never a destination.
  const entries: FileNavigatorEntry[] =
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
          .filter((entry) => mode !== 'folder' || entry.is_dir)
          .filter((entry) => !onlyVideo || entry.is_dir || entry.is_video !== false)
          .map((entry) => ({
            key: entry.path,
            name: entry.name,
            path: entry.path,
            isDir: entry.is_dir,
            size: entry.size,
            modified: entry.modified,
          }))

  if (!active) return null

  if (variant === 'region') {
    const filterQuery = filter ?? filterState
    const visibleEntries = filterByName(entries, filterQuery)
    const visibleDirs = visibleEntries.filter((e) => e.isDir)
    const visibleFiles = visibleEntries.filter((e) => !e.isDir)
    // The select shows the root holding `path`, never a guessed volume.
    const containingRoot =
      rootPaths.find((r) => currentPath === r || currentPath.startsWith(`${r}/`)) ?? ''

    // Without rootLabel the select renders bare, as before; row buttons
    // stay outside the label that wraps it.
    const rootSelect = (
      <select
        className="fm-volume-select"
        id="fm-volume-root"
        name="fm-volume-root"
        value={containingRoot}
        onChange={(e) => visit(e.target.value)}
      >
        {selectPlaceholder !== undefined && <option value="">{selectPlaceholder}</option>}
        {roots.map((root) => (
          <option key={root.path} value={root.path}>{root.name}</option>
        ))}
      </select>
    )

    return (
      <>
        {rootPicker === 'select' && (
          <div className="scan-row">
            {rootLabel ? (
              <label className="scan-label" htmlFor="fm-volume-root">
                {rootLabel}
                {rootSelect}
              </label>
            ) : (
              rootSelect
            )}
            <button
              type="button"
              className="fm-nav-btn"
              title="Subir"
              onClick={goUp}
              disabled={currentPath === '' || currentPath === containingRoot}
            >
              ⬆ Subir
            </button>
            {showRefresh && currentPath !== '' && (
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
              value={filterState}
              onChange={(e) => setFilterState(e.target.value)}
            />
          </div>
        )}

        {currentPath !== '' && layout === 'unified' && (
          <div className="scan-path-list">
            <div className="scan-current-path">{currentPath}</div>
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

        {currentPath !== '' && layout === 'split' && (
          <div className="scan-path-list">
            <div className="scan-current-path">{currentPath}</div>
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
                {!filterQuery.trim()
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

        {currentPath !== '' && layout === 'rows' && (
          <div className="fm-list">
            {visibleEntries.map((entry) => (
              <div
                key={entry.key}
                className={`fm-item ${entry.isDir ? 'dir' : ''}${isRowSelected?.(entry) ? ' selected' : ''}`}
                onClick={() =>
                  onRowClick ? onRowClick(entry) : entry.isDir && visit(entry.path)
                }
                onDoubleClick={() => entry.isDir && visit(entry.path)}
              >
                {renderRowStart?.(entry)}
                {showIcons && <span className="fm-icon">{entry.isDir ? '📁' : '📄'}</span>}
                {renderRowName ? (
                  renderRowName(entry)
                ) : (
                  <span className="fm-name">{entry.name}</span>
                )}
                {renderFileMeta?.(entry)}
                {showSizes && (
                  <span className="fm-size">{entry.isDir ? '—' : formatSize(entry.size)}</span>
                )}
                {showDates && <span className="fm-date">{formatDate(entry.modified)}</span>}
                {renderRowActions && (
                  <div className="fm-item-actions">{renderRowActions(entry)}</div>
                )}
              </div>
            ))}
            {visibleEntries.length === 0 && emptyLabel && (
              <div className="fm-empty">{emptyLabel}</div>
            )}
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
          <button type="button" className="folder-picker-up" onClick={goUp} disabled={currentPath === ''}>
            ⬆ Subir
          </button>
        </div>
        {currentPath !== '' && (
          <div className="folder-picker-crumb">
            {segments(currentPath).map((seg, i) => (
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
        <div className="folder-picker-path">{currentPath}</div>
        <div className="folder-picker-actions">
          <button
            type="button"
            className="folder-picker-choose"
            onClick={() => onConfirm?.(currentPath)}
            disabled={currentPath === ''}
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

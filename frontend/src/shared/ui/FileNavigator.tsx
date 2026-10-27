import { Fragment, useState } from 'react'
import { parentDir, useBrowse, useRoots } from '../hooks/useFilesNavigator.ts'
import './FileNavigator.css'

interface FileNavigatorProps {
  open: boolean
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
  onNavigate?(path: string): void
  onConfirm(path: string): void
  onCancel(): void
}

interface NavigatorEntry {
  key: string
  name: string
  path: string
  isDir: boolean
}

/** Modal file/folder navigator over the allowed roots: roots view at '',
 *  breadcrumbs up the chain, and every navigation reported via `onNavigate`. */
export function FileNavigator({
  open,
  initialPath,
  mode,
  ariaLabel = 'Elegir carpeta de destino',
  title = 'Elegir carpeta de destino',
  confirmLabel = 'Elegir esta carpeta',
  cancelLabel = 'Cancelar',
  hint,
  onNavigate,
  onConfirm,
  onCancel,
}: FileNavigatorProps) {
  const [path, setPath] = useState(initialPath ?? '')
  const rootsQuery = useRoots(open)
  const rootPaths = (rootsQuery.data?.roots ?? []).map((root) => root.path)
  const browseQuery = useBrowse(path, open && path !== '')

  function visit(next: string) {
    setPath(next)
    onNavigate?.(next)
  }

  function goUp() {
    visit(parentDir(path, rootPaths))
  }

  if (!open) return null

  // Roots carry their display name; a directory listing is filtered to
  // directories only in folder mode — a file is never a destination.
  const entries: NavigatorEntry[] =
    path === ''
      ? (rootsQuery.data?.roots ?? []).map((root) => ({
          key: root.path,
          name: root.name,
          path: root.path,
          isDir: true,
        }))
      : (browseQuery.data?.items ?? [])
          .filter((entry) => mode !== 'folder' || entry.is_dir)
          .map((entry) => ({
            key: entry.path,
            name: entry.name,
            path: entry.path,
            isDir: entry.is_dir,
          }))

  // Plain segment names, never the full path: the exact full path must stay a
  // single untouched node (the footer) for callers that match on it.
  const segments = path.split('/').filter(Boolean)

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
            {segments.map((seg, i) => (
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
              onClick={() => (entry.isDir ? visit(entry.path) : onConfirm(entry.path))}
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
            onClick={() => onConfirm(path)}
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

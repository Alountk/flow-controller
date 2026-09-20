import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { FileItem } from '../types'
import {
  fetchRoots,
  browsePath,
  createDirectory,
  renameItem,
  deleteItem,
  queueAdd,
} from '../api/files'
import './FileManager.css'

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString('es-ES', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

interface RootsItem {
  path: string
  name: string
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
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onPathChangeRef = useRef<((index: number, path: string) => void) | null>(null)
  onPathChangeRef.current = onPathChange

  const { data: browseData, isLoading } = useQuery({
    queryKey: ['browse', path],
    queryFn: () => browsePath(path),
    enabled: !!path,
  })

  useEffect(() => {
    if (browseData?.ok) {
      setSelected(null)
      onPathChangeRef.current?.(index, browseData.path)
    } else if (browseData?.error) {
      setError(browseData.error)
    }
  }, [browseData, index])

  const invalidateBrowse = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['browse', path] })
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

  function navigateTo(p: string) {
    setSelected(null)
    setPath(p)
  }

  function handleVolumeChange(newRoot: string) {
    setSelectedRoot(newRoot)
    setSelected(null)
    setPath(newRoot)
  }

  function handleDoubleClick(item: FileItem) {
    if (item.is_dir) navigateTo(item.path)
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

  function handleRename(item: FileItem) {
    if (!renameValue.trim() || renameValue === item.name) {
      setRenaming(null)
      return
    }
    const dir = item.path.substring(0, item.path.lastIndexOf('/'))
    rename.mutate({ oldPath: item.path, newPath: `${dir}/${renameValue.trim()}` })
  }

  function handleDelete(item: FileItem) {
    if (!confirm(`¿Eliminar ${item.name}?`)) return
    del.mutate(item.path)
  }

  function handleQueue(type: 'copy' | 'move', item: FileItem) {
    const dst = `${otherPath}/${item.name}`
    queue.mutate({ type, src: item.path, dst })
  }

  const items = browseData?.ok ? browseData.items : []

  return (
    <div className="fm-pane">
      <div className="fm-toolbar">
        <select
          className="fm-volume-select"
          value={selectedRoot}
          onChange={(e) => handleVolumeChange(e.target.value)}
        >
          {roots.map((r) => (
            <option key={r.path} value={r.path}>{r.name}</option>
          ))}
        </select>
        <button
          className="fm-nav-btn"
          onClick={() => navigateTo(parentDir())}
          title="Subir"
          disabled={path === selectedRoot}
        >
          ⬆
        </button>
        <div className="fm-path" title={path}>{path}</div>
        <button className="fm-action-btn" onClick={() => setCreating(true)}>
          + Carpeta
        </button>
        <button className="fm-action-btn" onClick={invalidateBrowse}>
          ↻
        </button>
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

      {isLoading ? (
        <div className="fm-loading">Cargando...</div>
      ) : items.length === 0 ? (
        <div className="fm-empty">Directorio vacío</div>
      ) : (
        <div className="fm-list">
          {items.map((item) => (
            <div
              key={item.path}
              className={`fm-item ${selected === item.path ? 'selected' : ''} ${item.is_dir ? 'dir' : ''}`}
              onClick={() => setSelected(item.path)}
              onDoubleClick={() => handleDoubleClick(item)}
            >
              <span className="fm-icon">{item.is_dir ? '📁' : '📄'}</span>
              {renaming === item.path ? (
                <input
                  className="fm-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(item)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => handleRename(item)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="fm-name">{item.name}</span>
              )}
              <span className="fm-size">{item.is_dir ? '—' : formatSize(item.size)}</span>
              <span className="fm-date">{formatDate(item.modified)}</span>
              <div className="fm-item-actions">
                <button
                  className="fm-sm-btn accent"
                  title="Copiar al otro panel"
                  onClick={(e) => { e.stopPropagation(); handleQueue('copy', item) }}
                >
                  ⬎
                </button>
                <button
                  className="fm-sm-btn accent"
                  title="Mover al otro panel"
                  onClick={(e) => { e.stopPropagation(); handleQueue('move', item) }}
                >
                  ⬏
                </button>
                <button
                  className="fm-sm-btn"
                  title="Renombrar"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenaming(item.path)
                    setRenameValue(item.name)
                  }}
                >
                  ✏
                </button>
                <button
                  className="fm-sm-btn danger"
                  title="Eliminar"
                  onClick={(e) => { e.stopPropagation(); handleDelete(item) }}
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
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

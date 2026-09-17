import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileItem } from '../types'
import {
  fetchRoots,
  browsePath,
  createDirectory,
  renameItem,
  deleteItem,
  queueAdd,
  queueStatus,
  type QueueOp,
} from '../api/files'

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

interface PaneProps {
  root: string
  otherPath: string
  onAction: () => void
  onPathChange: (path: string) => void
}

function FilePane({ root, otherPath, onAction, onPathChange }: PaneProps) {
  const [path, setPath] = useState(root)
  const [items, setItems] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = useCallback(async (p: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await browsePath(p)
      if (res.ok) {
        setItems(res.items)
        setPath(res.path)
        onPathChange(res.path)
      } else {
        setError(res.error || 'Error')
        setItems([])
      }
    } catch {
      setError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }, [onPathChange])

  useEffect(() => { load(path) }, [path, load])

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  function navigateTo(p: string) {
    setSelected(null)
    setPath(p)
  }

  function handleDoubleClick(item: FileItem) {
    if (item.is_dir) navigateTo(item.path)
  }

  function parentDir() {
    const parts = path.split('/')
    if (parts.length <= 2) return '/'
    return parts.slice(0, -1).join('/') || '/'
  }

  async function handleCreate() {
    if (!newName.trim()) return
    const res = await createDirectory(`${path}/${newName.trim()}`)
    if (res.ok) {
      setCreating(false)
      setNewName('')
      load(path)
      onAction()
    } else {
      setError(res.detail)
    }
  }

  async function handleRename(item: FileItem) {
    if (!renameValue.trim() || renameValue === item.name) {
      setRenaming(null)
      return
    }
    const dir = item.path.substring(0, item.path.lastIndexOf('/'))
    const res = await renameItem(item.path, `${dir}/${renameValue.trim()}`)
    if (res.ok) {
      setRenaming(null)
      load(path)
      onAction()
    } else {
      setError(res.detail)
    }
  }

  async function handleDelete(item: FileItem) {
    if (!confirm(`¿Eliminar ${item.name}?`)) return
    const res = await deleteItem(item.path)
    if (res.ok) {
      load(path)
      onAction()
    } else {
      setError(res.detail)
    }
  }

  async function handleQueue(type: 'copy' | 'move', item: FileItem) {
    const dst = `${otherPath}/${item.name}`
    const res = await queueAdd(type, item.path, dst)
    if (res.ok) {
      showToast(`${type === 'copy' ? 'Copiar' : 'Mover'}: ${item.name} → cola`)
    } else {
      setError(res.detail)
    }
  }

  return (
    <div className="fm-pane">
      <div className="fm-toolbar">
        <button className="fm-nav-btn" onClick={() => navigateTo(parentDir())} title="Subir">
          ⬆
        </button>
        <div className="fm-path" title={path}>{path}</div>
        <button className="fm-action-btn" onClick={() => setCreating(true)}>
          + Carpeta
        </button>
        <button className="fm-action-btn" onClick={() => load(path)}>
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

      {loading ? (
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
  const [roots, setRoots] = useState<{ path: string; name: string }[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [panePaths, setPanePaths] = useState<Record<string, string>>({})
  const [queue, setQueue] = useState<QueueOp[]>([])
  const [completed, setCompleted] = useState<QueueOp[]>([])

  useEffect(() => {
    fetchRoots().then((r) => setRoots(r.roots))
  }, [])

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Poll queue status
  useEffect(() => {
    let active = true
    async function poll() {
      try {
        const res = await queueStatus()
        if (!active) return
        setQueue(res.queue)
        setCompleted(res.completed)
      } catch { /* ignore */ }
    }
    poll()
    const iv = setInterval(poll, 2000)
    return () => { active = false; clearInterval(iv) }
  }, [])

  function handlePathChange(root: string, path: string) {
    setPanePaths((prev) => ({ ...prev, [root]: path }))
  }

  function getOtherPath(currentRoot: string): string {
    const otherRoot = roots.find((r) => r.path !== currentRoot)
    if (!otherRoot) return '/'
    return panePaths[otherRoot.path] || otherRoot.path
  }

  const activeOps = queue.filter((o) => o.status === 'pending' || o.status === 'running')
  const recentDone = completed.slice(-5).reverse()

  return (
    <section className="fm">
      <div className="fm-header">
        <h2>Explorador de Archivos</h2>
      </div>

      {(activeOps.length > 0 || recentDone.length > 0) && (
        <div className="fm-status-bar">
          {activeOps.length > 0 && (
            <div className="fm-status-active">
              {activeOps.map((op) => (
                <div key={op.id} className={`fm-status-op ${op.status}`}>
                  <span className="fm-status-icon">
                    {op.status === 'running' ? '🔄' : '⏳'}
                  </span>
                  <span className="fm-status-text">
                    {op.type === 'copy' ? 'Copiando' : 'Moviendo'}: {op.name}
                  </span>
                </div>
              ))}
            </div>
          )}
          {recentDone.length > 0 && (
            <div className="fm-status-done">
              {recentDone.map((op) => (
                <div key={op.id} className={`fm-status-op ${op.status}`}>
                  <span className="fm-status-icon">
                    {op.status === 'done' ? '✅' : '❌'}
                  </span>
                  <span className="fm-status-text">
                    {op.detail || op.name}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="fm-dual">
        {roots.map((root) => (
          <FilePane
            key={`${root.path}-${refreshKey}`}
            root={root.path}
            otherPath={getOtherPath(root.path)}
            onAction={refresh}
            onPathChange={(p) => handlePathChange(root.path, p)}
          />
        ))}
      </div>
    </section>
  )
}

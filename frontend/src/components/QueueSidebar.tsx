import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queueStatus, queueCancel } from '../api/files'
import type { QueueOp } from '../api/files'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function QueueOpItem({ op, onCancel }: { op: QueueOp; onCancel: (id: string) => void }) {
  const isActive = op.status === 'pending' || op.status === 'running'
  const isImporting = op.import_status === 'importing'
  const isFailed = op.status === 'failed'
  const isDone = op.status === 'done'

  const icon = isActive ? (op.status === 'running' ? '🔄' : '⏳')
    : isImporting ? '📥'
    : isDone && op.import_status === 'imported' ? '✅'
    : isDone && op.import_status === 'import_failed' ? '⚠️'
    : isDone ? '✅'
    : isFailed ? '❌'
    : '🚫'

  const typeLabel = op.type === 'copy' ? 'Copiar' : 'Mover'

  return (
    <div className={`qsidebar-item ${op.status} ${isImporting ? 'importing' : ''}`}>
      <div className="qsidebar-item-top">
        <span className="qsidebar-icon">{icon}</span>
        <div className="qsidebar-item-info">
          <div className="qsidebar-item-name" title={op.name}>{op.name}</div>
          <div className="qsidebar-item-type">{typeLabel}</div>
        </div>
        {(isActive || isImporting) && (
          <button className="qsidebar-cancel" onClick={() => onCancel(op.id)} title="Cancelar">×</button>
        )}
      </div>
      {isActive && (
        <div className="qsidebar-progress">
          <div className="qsidebar-bar-track">
            <div className="qsidebar-bar-fill" style={{ width: `${op.progress}%` }} />
          </div>
          <div className="qsidebar-progress-text">
            {op.total_bytes > 0 ? (
              <>{op.progress}% · {formatBytes(op.copied_bytes)} / {formatBytes(op.total_bytes)}</>
            ) : op.files_total > 0 ? (
              <>{op.files_done} / {op.files_total} archivos</>
            ) : (
              <>{op.progress}%</>
            )}
          </div>
        </div>
      )}
      {isImporting && (
        <div className="qsidebar-import-status">
          <span className="qsidebar-import-spinner">↻</span> Importando en Radarr...
        </div>
      )}
      {!isActive && !isImporting && op.detail && (
        <div className={`qsidebar-item-detail ${op.status} ${op.import_status}`}>
          {op.detail}
        </div>
      )}
    </div>
  )
}

export function QueueSidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const queryClient = useQueryClient()

  const { data: queueData } = useQuery({
    queryKey: ['queue'],
    queryFn: queueStatus,
    refetchInterval: (query) => {
      const data = query.state.data
      return (data?.queue?.length ?? 0) > 0 ? 2000 : 10000
    },
  })

  const cancelMutation = useMutation({
    mutationFn: queueCancel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  const activeOps = queueData?.queue ?? []
  const recentDone = (queueData?.completed ?? []).slice(-5).reverse()
  const activeCount = activeOps.length

  const importedIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const completed = queueData?.completed ?? []
    let shouldRefresh = false
    for (const op of completed) {
      if (
        !importedIdsRef.current.has(op.id)
        && (op.import_status === 'imported' || op.import_status === 'import_failed')
      ) {
        importedIdsRef.current.add(op.id)
        shouldRefresh = true
      }
    }
    if (shouldRefresh) {
      queryClient.invalidateQueries({ queryKey: ['wanted'] })
      queryClient.invalidateQueries({ queryKey: ['all-movies'] })
    }
  }, [queueData, queryClient])

  return (
    <>
      {collapsed && (
        <button
          className={`qsidebar-toggle-fixed ${activeCount > 0 ? 'has-ops' : ''}`}
          onClick={() => setCollapsed(false)}
          title={`Cola de operaciones${activeCount > 0 ? ` (${activeCount} activas)` : ''}`}
        >
          {activeCount > 0 && <span className="qsidebar-toggle-count">{activeCount}</span>}
          ◀
        </button>
      )}

      <div
        className={`qsidebar ${collapsed ? 'collapsed' : ''}`}
        style={collapsed ? { transform: 'translateX(100%)' } : undefined}
      >
        <div className="qsidebar-header" onClick={() => setCollapsed(true)}>
          <span className="qsidebar-title">
            Cola de operaciones
            {activeCount > 0 && <span className="qsidebar-count">{activeCount}</span>}
          </span>
          <span className="qsidebar-toggle">▶</span>
        </div>
        <div className="qsidebar-body">
          {activeOps.length === 0 && recentDone.length === 0 ? (
            <div className="qsidebar-empty">Sin operaciones</div>
          ) : (
            <>
              {activeOps.map((op) => (
                <QueueOpItem key={op.id} op={op} onCancel={(id) => cancelMutation.mutate(id)} />
              ))}
              {recentDone.length > 0 && (
                <div className="qsidebar-done-section">
                  <div className="qsidebar-done-label">Recientes</div>
                  {recentDone.map((op) => (
                    <QueueOpItem key={op.id} op={op} onCancel={() => {}} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}

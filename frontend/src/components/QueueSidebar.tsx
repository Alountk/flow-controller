import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queueStatus, queueCancel } from '../api/files'
import type { QueueOp } from '../api/files'
import type { Download } from '../api/downloads'
import {
  downloadStateLabel,
  formatEta,
  formatSpeed,
  useDownloads,
} from '../hooks/useDownloads'
import './QueueSidebar.css'

function DownloadItem({ download }: { download: Download }) {
  const badge = downloadStateLabel(download)

  return (
    <div className={`qsidebar-download ${download.problem ? 'problem' : ''}`}>
      <div className="qsidebar-download-title" title={download.title}>
        {download.title}
      </div>

      <div className="qsidebar-progress">
        <div className="qsidebar-bar-track">
          <div
            className={`qsidebar-bar-fill ${download.problem ? 'problem' : ''}`}
            style={{ width: `${download.progress}%` }}
          />
        </div>
      </div>

      <div className="qsidebar-download-meta">
        <span className={`qsidebar-badge ${download.problem ? 'problem' : ''}`}>{badge}</span>
        <span className="qsidebar-download-progress">{download.progress}%</span>
      </div>

      {/* Speed, ETA and seeds exist only when the download client answered. */}
      {download.matched ? (
        <div className="qsidebar-download-stats">
          <span>⬇ {formatSpeed(download.speed)}</span>
          <span>⏱ {formatEta(download.eta_seconds)}</span>
          {download.seeders !== null && <span>🌱 {download.seeders}</span>}
        </div>
      ) : (
        <div className="qsidebar-download-nostats">Sin datos del cliente de descargas</div>
      )}

      {download.messages.length > 0 && (
        <div className="qsidebar-download-message">{download.messages[0]}</div>
      )}
    </div>
  )
}

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

  const { data: downloadsData } = useDownloads()
  const downloads = downloadsData?.downloads ?? []
  const downloadErrors = downloadsData?.errors ?? []
  const problemCount = downloads.filter((d) => d.problem).length

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
      queryClient.invalidateQueries({ queryKey: ['wanted-movies-infinite'] })
      queryClient.invalidateQueries({ queryKey: ['wanted-episodes-infinite'] })
      queryClient.invalidateQueries({ queryKey: ['all-movies-infinite'] })
      queryClient.invalidateQueries({ queryKey: ['all-series-infinite'] })
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
            {problemCount > 0 && (
              <span className="qsidebar-count qsidebar-count-problem">{problemCount}</span>
            )}
          </span>
          <span className="qsidebar-toggle">▶</span>
        </div>
        {/* Vertical split: the sidebar is ~280px wide, so splitting it
            horizontally would leave a third too narrow for the long release
            titles this app deals with. */}
        <div className="qsidebar-split">
          <div className="qsidebar-section qsidebar-section-ops">
            <div className="qsidebar-section-title">
              Operaciones
              {activeCount > 0 && <span className="qsidebar-count">{activeCount}</span>}
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

          <div className="qsidebar-section qsidebar-section-downloads">
            <div className="qsidebar-section-title">
              Descargas
              {downloads.length > 0 && <span className="qsidebar-count">{downloads.length}</span>}
              {problemCount > 0 && (
                <span className="qsidebar-count qsidebar-count-problem">{problemCount}</span>
              )}
            </div>
            <div className="qsidebar-body">
              {downloadErrors.map((failure) => (
                <div key={failure.source} className="qsidebar-download-error" role="alert">
                  {failure.error}
                </div>
              ))}
              {downloads.length === 0 && downloadErrors.length === 0 && (
                <div className="qsidebar-empty">Sin descargas</div>
              )}
              {downloads.map((download) => (
                <DownloadItem key={download.id} download={download} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

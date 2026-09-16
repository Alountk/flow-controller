import type { ServiceStatus } from '../types'

const ICONS: Record<string, string> = {
  radarr: '🎬',
  sonarr: '📺',
  amutorrent: '⬇️',
}

interface Props {
  service: ServiceStatus
}

export function ServiceNode({ service }: Props) {
  const { key, label, state, reason, meta } = service
  const torrents = meta?.torrents

  return (
    <div className={`pipeline-node ${state}`}>
      <div className="node-icon">{ICONS[key] ?? '⚙️'}</div>
      <div className="node-label">{label}</div>
      <div className={`node-state ${state}`}>{state}</div>
      <div className="node-reason">{reason}</div>

      {meta?.version && (
        <div className="node-meta">
          <span className="node-meta-tag">v{meta.version.replace(/^v/, '')}</span>
        </div>
      )}

      {torrents && (
        <div className="node-stats">
          <div className="node-stat">
            <span className="node-stat-value">{torrents.downloading}</span>
            <span className="node-stat-label">activas</span>
          </div>
          <div className="node-stat">
            <span className="node-stat-value">{torrents.completed}</span>
            <span className="node-stat-label">completas</span>
          </div>
          {torrents.errors > 0 && (
            <div className="node-stat error">
              <span className="node-stat-value">{torrents.errors}</span>
              <span className="node-stat-label">errores</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

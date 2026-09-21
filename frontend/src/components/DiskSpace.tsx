import { useQuery } from '@tanstack/react-query'
import type { DiskResponse } from '../types'
import './DiskSpace.css'
import { apiFetch } from '../api/auth'

async function fetchDisk(): Promise<DiskResponse> {
  const res = await apiFetch('/api/disk', {})
  return res.json() as Promise<DiskResponse>
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function getBarColor(percent: number): string {
  if (percent >= 90) return 'var(--bad)'
  if (percent >= 75) return 'var(--warn)'
  return 'var(--ok)'
}

export function DiskSpace() {
  const { data, isPending } = useQuery({
    queryKey: ['disk'],
    queryFn: fetchDisk,
    refetchInterval: 30000,
  })

  return (
    <section className="disk-space">
      <div className="disk-header">
        <h2>Espacio en Disco</h2>
      </div>

      {isPending ? (
        <div className="wanted-loading">Cargando...</div>
      ) : data && data.volumes.length > 0 ? (
        <div className="disk-volumes">
          {data.volumes.map((vol) => (
            <div key={vol.path} className={`disk-card ${vol.error ? 'disk-error' : ''}`}>
              <div className="disk-card-header">
                <span className="disk-name">{vol.name}</span>
                <span className="disk-path">{vol.path}</span>
              </div>
              {vol.error ? (
                <div className="disk-unavailable">{vol.error}</div>
              ) : (
                <>
                  <div className="disk-bar-container">
                    <div
                      className="disk-bar"
                      style={{
                        width: `${vol.percent}%`,
                        backgroundColor: getBarColor(vol.percent),
                      }}
                    />
                  </div>
                  <div className="disk-stats">
                    <span className="disk-stat">
                      <span className="disk-stat-label">Usado</span>
                      <span className="disk-stat-value">{formatBytes(vol.used_bytes)}</span>
                    </span>
                    <span className="disk-stat">
                      <span className="disk-stat-label">Libre</span>
                      <span className="disk-stat-value">{formatBytes(vol.free_bytes)}</span>
                    </span>
                    <span className="disk-stat">
                      <span className="disk-stat-label">Total</span>
                      <span className="disk-stat-value">{formatBytes(vol.total_bytes)}</span>
                    </span>
                    <span className="disk-stat disk-percent" style={{ color: getBarColor(vol.percent) }}>
                      {vol.percent}%
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="wanted-empty">No hay volúmenes configurados</div>
      )}
    </section>
  )
}

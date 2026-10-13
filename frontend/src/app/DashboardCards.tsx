import type {
  DiskResponse,
  DownloadEntry,
  ServiceStatus,
  Trace,
  TraceSummary,
} from '../shared/types.ts'
import { formatBytes } from '../shared/utils/text.ts'

interface DashboardCardsProps {
  downloads: DownloadEntry[]
  disk: DiskResponse | undefined
  summary: TraceSummary | undefined
  traces: Trace[]
  services: ServiceStatus[]
  onOpenSeguimiento: () => void
}

const SOURCE_LABELS: Record<string, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  amutorrent: 'AmuTorrent',
}

/**
 * The four stat cards of Stitch design 01. Every value, subtitle and footer is
 * derived from a real payload — a footer only renders when there is a fact to
 * report (honesty rule of the handoff).
 */
export function DashboardCards({
  downloads,
  disk,
  summary,
  traces,
  services,
  onOpenSeguimiento,
}: DashboardCardsProps) {
  // Card 1 — the arr queue's own verdict (importBlocked/failed/downloadFailed).
  const stuck = downloads.filter((entry) => entry.problem)
  const stuckBySource = new Map<string, number>()
  for (const entry of stuck) {
    stuckBySource.set(entry.source, (stuckBySource.get(entry.source) ?? 0) + 1)
  }
  const breakdown = Object.keys(SOURCE_LABELS)
    .filter((key) => (stuckBySource.get(key) ?? 0) > 0)
    .map((key) => `${stuckBySource.get(key)} en ${SOURCE_LABELS[key]}`)
    .join(', ')

  // Card 2 — the trace layer's blocked imports and where they point.
  const blocked = summary?.import_blocked ?? 0
  const blockedDestination = traces.find(
    (item) => item.stage === 'import_blocked' && item.destination,
  )?.destination

  // Card 3 — first healthy volume; the dashboard shows one mount, not a fleet.
  const volume = disk?.volumes?.find((item) => !item.error)

  // Card 4 — configured services only; hidden when nothing is configured.
  const online = services.filter((item) => item.state === 'online')
  const offline = services.filter((item) => item.state !== 'online')
  const offlineFooter = offline
    .map(
      (item) =>
        `${item.label}: ${item.reason || (item.state === 'misconfigured' ? 'Clave rechazada' : 'Sin datos')}`,
    )
    .join(' · ')

  return (
    <div className="dashboard-grid">
      <button
        type="button"
        className="dash-card"
        onClick={onOpenSeguimiento}
        title="Ver el seguimiento de las descargas"
      >
        <span className="dash-label">Descargas atascadas</span>
        <span className="dash-value">{stuck.length} elementos</span>
        {breakdown && <span className="dash-sub">{breakdown}</span>}
        {stuck.length > 0 && <span className="dash-foot warn">Requiere revisión manual</span>}
      </button>

      <div className="dash-card">
        <span className="dash-label">Importaciones bloqueadas</span>
        <span className="dash-value">{blocked} elementos</span>
        {blockedDestination && (
          <span className="dash-foot mono">Destino: {blockedDestination}</span>
        )}
      </div>

      <div className="dash-card">
        <span className="dash-label">Espacio en disco</span>
        <span className="dash-value">
          {volume ? `${formatBytes(volume.free_bytes)} libres` : 'Sin datos'}
        </span>
        {volume && (
          <span className="dash-sub">Capacidad total: {formatBytes(volume.total_bytes)}</span>
        )}
        {volume && <span className="dash-foot mono">Punto de montaje: {volume.path}</span>}
      </div>

      {services.length > 0 && (
        <div className="dash-card">
          <span className="dash-label">Estado de servicios</span>
          <span className="dash-value">
            {online.length} de {services.length} activos
          </span>
          {online.length > 0 && (
            <span className="dash-sub">{online.map((item) => item.label).join(' y ')} operativos</span>
          )}
          {offline.length > 0 && <span className="dash-foot bad">{offlineFooter}</span>}
        </div>
      )}
    </div>
  )
}

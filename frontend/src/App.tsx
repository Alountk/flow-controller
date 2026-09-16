import { useCallback, useMemo } from 'react'
import { usePolling } from './hooks/usePolling'
import { PipelineVisual } from './components/PipelineVisual'
import { TraceView } from './components/TraceView'
import {
  parseStatus,
  type ActionsResponse,
  type ServiceStatus,
  type StatusResponse,
  type ServiceKey,
  type TraceResponse,
} from './types'

const SERVICES: { key: ServiceKey; label: string }[] = [
  { key: 'radarr', label: 'Radarr' },
  { key: 'amutorrent', label: 'AmuTorrent' },
  { key: 'sonarr', label: 'Sonarr' },
]

function App() {
  const {
    data,
    error,
    loading,
    lastUpdated,
    refresh: refreshStatus,
  } = usePolling<StatusResponse>('/api/status', {
    intervalMs: 5000,
  })

  const {
    data: traceData,
    loading: traceLoading,
    refresh: refreshTrace,
  } = usePolling<TraceResponse>('/api/trace', {
    intervalMs: 15000,
  })

  const { data: actionsData } = usePolling<ActionsResponse>('/api/actions', {
    intervalMs: 60000,
  })

  const handleActionDone = useCallback(() => {
    refreshTrace()
    refreshStatus()
  }, [refreshTrace, refreshStatus])

  const services: ServiceStatus[] = useMemo(
    () =>
      SERVICES.map(({ key, label }) => {
        const { state, reason } = parseStatus(data?.[key])
        const meta = key === 'amutorrent' ? data?.amutorrent_meta : undefined
        return { key, label, state, reason, meta }
      }),
    [data],
  )

  const allOnline = services.every((s) => s.state === 'online')
  const anyOffline = services.some((s) => s.state === 'offline')
  const broken = services.find((s) => s.state === 'offline')

  const flowTitle = allOnline
    ? 'Flujo operativo'
    : anyOffline
      ? `Flujo cortado en ${broken?.label ?? 'servicio'}`
      : 'Comprobando servicios…'

  const flowDesc = allOnline
    ? 'Radarr, AmuTorrent y Sonarr responden correctamente.'
    : anyOffline
      ? broken?.reason
      : 'Esperando la primera comprobación.'

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Flow Controller</h1>
          <p className="subtitle">Control del flujo Radarr → AmuTorrent → Sonarr</p>
        </div>
        <div className="header-meta">
          <span>
            <span className={`dot ${loading ? '' : 'live'}`} />
            {loading ? 'Conectando…' : 'En vivo'}
          </span>
          <span>
            {lastUpdated
              ? `Última actualización: ${new Date(lastUpdated).toLocaleTimeString()}`
              : 'Sin datos aún'}
          </span>
        </div>
      </header>

      <PipelineVisual services={services} />

      <div className={`flow-banner ${allOnline ? 'ok' : anyOffline ? 'broken' : ''}`}>
        <span className={`flow-big-dot ${allOnline ? 'ok' : 'broken'}`} />
        <div>
          <div className="flow-title">{flowTitle}</div>
          <div className="flow-desc">{flowDesc}</div>
        </div>
      </div>

      {error && <div className="error-box">Error de conexión con el backend: {error}</div>}

      <div className="legend">
        <span><span className="dot" style={{ background: 'var(--ok)' }} /> Servicio online</span>
        <span><span className="dot" style={{ background: 'var(--bad)' }} /> Servicio offline / flujo cortado</span>
      </div>

      <TraceView
        data={traceData}
        loading={traceLoading}
        actions={actionsData}
        onActionDone={handleActionDone}
      />
    </div>
  )
}

export default App

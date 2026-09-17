import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePolling } from './hooks/usePolling'
import { Sidebar, type Page } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { PipelineVisual } from './components/PipelineVisual'
import { TraceView } from './components/TraceView'
import { MissingContent } from './components/MissingContent'
import { FileManager } from './components/FileManager'
import { Prototypes } from './components/Prototypes'
import { setApiKey } from './api/auth'
import {
  parseStatus,
  type ActionsResponse,
  type ServiceStatus,
  type StatusResponse,
  type ServiceKey,
  type TraceResponse,
  type ConfigResponse,
} from './types'

const SERVICES: { key: ServiceKey; label: string }[] = [
  { key: 'radarr', label: 'Radarr' },
  { key: 'amutorrent', label: 'AmuTorrent' },
  { key: 'sonarr', label: 'Sonarr' },
]

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard',
  trace: 'Trazabilidad',
  wanted: 'Faltantes',
  files: 'Archivos',
  prototypes: 'Prototipos',
}

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

  const { data: configData } = usePolling<ConfigResponse>('/api/config', {
    intervalMs: 60000,
  })

  useEffect(() => {
    if (configData?.api_key) setApiKey(configData.api_key)
  }, [configData])

  const [page, setPage] = useState<Page>('dashboard')

  const developer = configData?.developer ?? false

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

  const downloading = traceData?.summary?.downloading ?? 0
  const importBlocked = traceData?.summary?.import_blocked ?? 0
  const failed = traceData?.summary?.failed ?? 0
  const completed = traceData?.summary?.downloaded ?? 0

  return (
    <div className="layout">
      <Sidebar active={page} onNavigate={setPage} developer={developer} />

      <div className="main">
        <Topbar
          title={PAGE_TITLES[page]}
          loading={loading}
          lastUpdated={lastUpdated}
        />

        <div className="content">
          {page === 'dashboard' && (
            <>
              <div className="content-header">
                <h1>Resumen del sistema</h1>
                <p>Estado actual del pipeline de media y actividad reciente</p>
              </div>

              <PipelineVisual services={services} />

              {error && <div className="error-box">Error de conexión con el backend: {error}</div>}

              <div className={`flow-banner ${allOnline ? 'ok' : anyOffline ? 'broken' : ''}`}>
                <span className={`flow-big-dot ${allOnline ? 'ok' : 'broken'}`} />
                <div>
                  <div className="flow-title">
                    {allOnline
                      ? 'Flujo operativo'
                      : anyOffline
                        ? `Flujo cortado en ${broken?.label ?? 'servicio'}`
                        : 'Comprobando servicios…'}
                  </div>
                  <div className="flow-desc">
                    {allOnline
                      ? 'Radarr, AmuTorrent y Sonarr responden correctamente.'
                      : anyOffline
                        ? broken?.reason
                        : 'Esperando la primera comprobación.'}
                  </div>
                </div>
              </div>

              <div className="dashboard-grid">
                <div className="dash-card">
                  <span className="dash-label">Descargando</span>
                  <span className="dash-value accent">{downloading}</span>
                  <span className="dash-sub">activas</span>
                </div>
                <div className="dash-card">
                  <span className="dash-label">Stuck</span>
                  <span className="dash-value warn">{importBlocked}</span>
                  <span className="dash-sub">atención</span>
                </div>
                <div className="dash-card">
                  <span className="dash-label">Fallidas</span>
                  <span className="dash-value bad">{failed}</span>
                  <span className="dash-sub">últimas 24h</span>
                </div>
                <div className="dash-card">
                  <span className="dash-label">Completadas</span>
                  <span className="dash-value ok">{completed}</span>
                  <span className="dash-sub">esta semana</span>
                </div>
              </div>

              <div className="legend">
                <span><span className="dot" style={{ background: 'var(--ok)' }} /> Servicio online</span>
                <span><span className="dot" style={{ background: 'var(--bad)' }} /> Servicio offline / flujo cortado</span>
              </div>
            </>
          )}

          {page === 'trace' && (
            <TraceView
              data={traceData}
              loading={traceLoading}
              actions={actionsData}
              onActionDone={handleActionDone}
            />
          )}

          {page === 'wanted' && (
            <MissingContent />
          )}

          {page === 'files' && (
            <FileManager />
          )}

          {page === 'prototypes' && <Prototypes />}
        </div>
      </div>
    </div>
  )
}

export default App

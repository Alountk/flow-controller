import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AuthGate } from './components/AuthGate'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { PipelineVisual } from './components/PipelineVisual'
import { TraceView } from './components/TraceView'
import { MissingContent } from './components/MissingContent'
import { FileManager } from './components/FileManager'
import { Prototypes } from './components/Prototypes'
import { QueueSidebar } from './components/QueueSidebar'
import { Settings } from './components/Settings'
import { Calendar } from './components/Calendar'
import { DiskSpace } from './components/DiskSpace'
import { MediaMixer } from './components/MediaMixer'
import {
  apiFetch,
  forgetApiKey,
  getApiKey,
  hasStoredApiKey,
  setUnauthorizedHandler,
  verifyApiKey,
} from './api/auth'
import { usePageRoute } from './hooks/usePageRoute'
import { useConfiguredServices } from './hooks/useConfiguredServices'
import {
  parseStatus,
  type ActionsResponse,
  type ServiceStatus,
  type StatusResponse,
  type ServiceKey,
  type TraceResponse,
  type ConfigResponse,
} from './types'
import type { Page } from './components/Sidebar'

/**
 * Authenticated JSON fetch.
 *
 * It used to call bare `fetch`, so /api/status, /api/trace and /api/actions
 * went out with no X-Api-Key header. They were unauthenticated at the time, so
 * nobody noticed; the moment those routes started requiring the key, every
 * dashboard call failed with 401 for anyone who had one configured.
 *
 * It goes through `apiFetch` so a rejected key also re-prompts.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

const SERVICES: { key: ServiceKey; label: string }[] = [
  { key: 'radarr', label: 'Radarr' },
  { key: 'amutorrent', label: 'AmuTorrent' },
  { key: 'sonarr', label: 'Sonarr' },
]

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard',
  trace: 'Trazabilidad',
  wanted: 'Faltantes',
  calendar: 'Calendario',
  disk: 'Espacio en Disco',
  files: 'Archivos',
  mixer: 'Media Mixer',
  config: 'Configuración',
  prototypes: 'Prototipos',
}

function App() {
  const queryClient = useQueryClient()
  const { ready: servicesReady, isConfigured, hasAnyArr } = useConfiguredServices()

  // Declared before the queries: they are gated on it.
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingStored, setCheckingStored] = useState(true)

  const { data, error, isPending } = useQuery<StatusResponse>({
    queryKey: ['status'],
    queryFn: () => fetchJson('/api/status'),
    refetchInterval: 5000,
    enabled: authenticated,
  })

  const { data: traceData, isPending: traceLoading } = useQuery<TraceResponse>({
    queryKey: ['trace'],
    queryFn: () => fetchJson('/api/trace'),
    refetchInterval: 15000,
    enabled: authenticated,
  })

  const { data: actionsData } = useQuery<ActionsResponse>({
    queryKey: ['actions'],
    queryFn: () => fetchJson('/api/actions'),
    refetchInterval: 60000,
    enabled: authenticated,
  })

  const { data: configData } = useQuery<ConfigResponse>({
    queryKey: ['config'],
    queryFn: () => fetchJson('/api/config'),
    staleTime: Infinity,
  })

  // The backend no longer serves the key, so one is either already remembered
  // by this browser or the user is asked for it.

  useEffect(() => {
    if (!configData) return

    if (!configData.auth_required) {
      setAuthenticated(true)
      setCheckingStored(false)
      return
    }

    // A remembered key may have been rotated on the server, so validate it
    // rather than trusting it and firing a screenful of 401s.
    if (!hasStoredApiKey()) {
      setCheckingStored(false)
      return
    }
    let active = true
    verifyApiKey(getApiKey()).then((ok) => {
      if (!active) return
      if (ok) setAuthenticated(true)
      else forgetApiKey()
      setCheckingStored(false)
    })
    return () => {
      active = false
    }
  }, [configData])

  function handleAuthenticated() {
    setAuthenticated(true)
    // The data queries failed while unauthenticated; refetch them now.
    queryClient.invalidateQueries()
  }

  // Any 401 from anywhere brings the user back to the key prompt. Without this
  // the key was only checked once at boot, so a cleared or rotated key left
  // every panel failing silently.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthenticated(false)
      setCheckingStored(false)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const [page, setPage] = usePageRoute()

  const developer = configData?.developer ?? false

  const handleActionDone = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['trace'] })
    queryClient.invalidateQueries({ queryKey: ['status'] })
  }, [queryClient])

  // Pages that cannot work without an arr service: they all read from Radarr or
  // Sonarr. The local pages (disk, files, mixer, config) always work.
  const hiddenPages = useMemo<Page[]>(() => {
    if (!servicesReady || hasAnyArr) return []
    return ['trace', 'wanted', 'calendar'] as Page[]
  }, [servicesReady, hasAnyArr])

  useEffect(() => {
    if (hiddenPages.includes(page)) setPage('dashboard')
  }, [hiddenPages, page, setPage])

  const services: ServiceStatus[] = useMemo(
    () =>
      SERVICES
        // A service the user never configured is not part of the pipeline.
        // Until the answer is known everything is shown, so nothing flashes in
        // and out on first paint.
        .filter(({ key }) => !servicesReady || isConfigured(key))
        .map(({ key, label }) => {
          const { state, reason } = parseStatus(data?.[key])
          const meta = key === 'amutorrent' ? data?.amutorrent_meta : undefined
          return { key, label, state, reason, meta }
        }),
    [data, servicesReady, isConfigured],
  )

  // `every` on an empty list is true, which would report an empty pipeline as
  // healthy. Nothing configured is not the same as everything working.
  const nothingConfigured = servicesReady && services.length === 0
  const allOnline = services.length > 0 && services.every((s) => s.state === 'online')
  const anyOffline = services.some((s) => s.state === 'offline')
  const broken = services.find((s) => s.state === 'offline')

  const downloading = traceData?.summary?.downloading ?? 0
  const importBlocked = traceData?.summary?.import_blocked ?? 0
  const failed = traceData?.summary?.failed ?? 0
  const completed = traceData?.summary?.downloaded ?? 0

  // Waiting on /api/config, or validating a remembered key.
  if (checkingStored) {
    return <div className="app-loading">Cargando…</div>
  }

  if (configData?.auth_required && !authenticated) {
    return <AuthGate onAuthenticated={handleAuthenticated} />
  }

  return (
    <div className="layout">
      <Sidebar active={page} onNavigate={setPage} developer={developer} hidden={hiddenPages} />

      <div className="main">
        <Topbar
          title={PAGE_TITLES[page]}
          loading={isPending}
          lastUpdated={data ? Date.now() : null}
        />

        <div className="content-and-queue">
          <div className="content">
            {/* Loud on purpose: unreadable credentials otherwise look like every
                service being misconfigured, with no hint at the real cause. */}
            {configData?.encryption_ok === false && (
              <div className="wanted-error" role="alert">
                <strong>No se pudieron leer las credenciales guardadas</strong>
                <span>{configData.encryption_error}</span>
              </div>
            )}
            {page === 'dashboard' && (
              <>
                <div className="content-header">
                  <h1>Resumen del sistema</h1>
                  <p>Estado actual del pipeline de media y actividad reciente</p>
                </div>

                {nothingConfigured ? (
                  <div className="wanted-empty" role="alert">
                    No hay ningún servicio configurado todavía. Ve a <strong>Configuración</strong> para
                    añadir la URL y la API key de Radarr, Sonarr o aMuTorrent.
                  </div>
                ) : (
                  <PipelineVisual services={services} />
                )}

                {error && <div className="error-box">Error de conexión con el backend: {error.message}</div>}

                {!nothingConfigured && (
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
                        ? 'Los servicios configurados responden correctamente.'
                        : anyOffline
                          ? broken?.reason
                          : 'Esperando la primera comprobación.'}
                    </div>
                  </div>
                </div>
                )}

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
              data={traceData ?? null}
              loading={traceLoading}
              actions={actionsData ?? null}
              onActionDone={handleActionDone}
            />
          )}

          {page === 'wanted' && (
            <MissingContent />
          )}

          {page === 'calendar' && <Calendar />}

          {page === 'disk' && <DiskSpace />}

          {page === 'files' && (
            <FileManager />
          )}

          {page === 'mixer' && <MediaMixer />}

          {page === 'config' && <Settings />}

          {page === 'prototypes' && <Prototypes />}
          </div>

          <QueueSidebar />
        </div>
      </div>
    </div>
  )
}

export default App

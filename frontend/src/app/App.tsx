import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AuthGate } from './AuthGate.tsx'
import { SetupPage } from '../pages/SetupPage.tsx'
import { Sidebar } from './Sidebar.tsx'
import { Topbar } from './Topbar.tsx'
import { FileManager } from '../features/file-manager/FileManager.tsx'
import './Dashboard.css'
import { Prototypes } from '../pages/Prototypes.tsx'
import { Settings } from '../features/settings/Settings.tsx'
import { DiskSpace } from '../pages/DiskSpace.tsx'
import { ServiceChips } from './ServiceChips.tsx'
import { DashboardCards } from './DashboardCards.tsx'
import { IncidentsBand } from './IncidentsBand.tsx'
import { ActivityTable } from './ActivityTable.tsx'
import { MediaMixer } from '../pages/MediaMixer.tsx'
import { Peliculas } from '../pages/Peliculas.tsx'
import { Series } from '../pages/Series.tsx'
import { Seguimiento } from '../pages/Seguimiento.tsx'
import { ToastViewport } from './ToastViewport.tsx'
import {
  apiFetch,
  forgetApiKey,
  getApiKey,
  hasStoredApiKey,
  setUnauthorizedHandler,
  verifyApiKey,
} from '../shared/api/auth.ts'
import { usePageRoute } from '../shared/hooks/usePageRoute.ts'
import { useConfiguredServices } from '../shared/hooks/useConfiguredServices.ts'
import { useEventStream, EventStreamContext } from '../shared/hooks/useEventStream.ts'
import { fetchSetupStatus } from '../shared/api/setup.ts'
import {
  parseStatus,
  type ActionsResponse,
  type ServiceStatus,
  type StatusResponse,
  type ServiceKey,
  type TraceResponse,
  type ConfigResponse,
  type DownloadsResponse,
  type DiskResponse,
  type ActivityResponse,
} from '../shared/types.ts'
import type { Page } from './Sidebar.tsx'

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
  peliculas: 'Películas',
  series: 'Series',
  seguimiento: 'Seguimiento',
  disk: 'Espacio en Disco',
  files: 'Archivos',
  mixer: 'Media Mixer',
  config: 'Configuración',
  prototypes: 'Prototipos',
}

/** Subtitle copy straight from the design screens whose HTML this repo has
 *  read (01 Dashboard, 03 Películas). A page outside this map shows NO
 *  subtitle: inventing copy the design never wrote would be a lie too. */
const PAGE_SUBTITLES: Partial<Record<Page, string>> = {
  dashboard: 'Vista general del servidor multimedia',
  peliculas: 'Catálogo cinematográfico y gestión de indexación',
}

function App() {
  const queryClient = useQueryClient()
  const { ready: servicesReady, isConfigured, hasAnyArr } = useConfiguredServices()

  // Declared before the queries: they are gated on it.
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingStored, setCheckingStored] = useState(true)

  const { data: configData } = useQuery<ConfigResponse>({
    queryKey: ['config'],
    queryFn: () => fetchJson('/api/config'),
    staleTime: Infinity,
  })

  // Mounted ONCE, shell-wide: server events invalidate queries the moment
  // they happen; every refetchInterval stays as the fallback (sse-events T3).
  // The stream is gated on auth being satisfied (key stored OR auth
  // disabled): while /api/config is still loading, treat auth as required
  // and fail closed — a keyless EventSource would 401-retry into C-05's
  // auth-failure budget before the user ever reaches the key prompt.
  // B1: the returned status is what the provider below feeds to the task
  // polls — connected, they sleep; disconnected (the default), they stand.
  // B2: it also feeds the status/trace queries below — the backend
  // announces both surfaces (check_all publishes after every check; the
  // trace refresher on the TTL), so connected they sleep too. Declared
  // above them because they gate on `connected`.
  const eventStream = useEventStream(configData?.auth_required ?? true)

  // Hoisted with the queries: the dashboard-only readers below gate on it.
  const [page, setPage] = usePageRoute()

  const { data, error, isPending } = useQuery<StatusResponse>({
    queryKey: ['status'],
    queryFn: () => fetchJson('/api/status'),
    // B2: on the stream `kind:"status"` invalidates this query after every
    // backend check — the 5 s poll is the fallback, not the cadence.
    refetchInterval: eventStream.connected ? false : 5000,
    enabled: authenticated,
  })

  const { data: traceData, isPending: traceLoading } = useQuery<TraceResponse>({
    queryKey: ['trace'],
    queryFn: () => fetchJson('/api/trace'),
    // B2: `kind:"trace"` keeps flowing from the backend refresher even with
    // no reader polling — the 15 s poll sleeps on the stream and stands off it.
    refetchInterval: eventStream.connected ? false : 15000,
    enabled: authenticated,
  })

  const { data: actionsData } = useQuery<ActionsResponse>({
    queryKey: ['actions'],
    queryFn: () => fetchJson('/api/actions'),
    refetchInterval: 60000,
    enabled: authenticated,
  })

  // Dashboard-only readers (Stitch 01): the downloads snapshot feeds the
  // "Descargas atascadas" card (the `kind:"downloads"` event invalidates this
  // key; the 10 s poll is the fallback), the disk volumes feed "Espacio en
  // disco" — the DiskSpace page shares the ['disk'] key when you open it.
  const { data: downloadsData } = useQuery<DownloadsResponse>({
    queryKey: ['downloads'],
    queryFn: () => fetchJson('/api/downloads'),
    refetchInterval: eventStream.connected ? false : 10000,
    enabled: authenticated && page === 'dashboard',
  })

  const { data: diskData } = useQuery<DiskResponse>({
    queryKey: ['disk'],
    queryFn: () => fetchJson('/api/disk'),
    refetchInterval: 30000,
    enabled: authenticated && page === 'dashboard',
  })

  // Dashboard-only: the recent-activity table (Stitch 01 §3). The backend's
  // downloads and task events invalidate this key (S6); the 10 s poll sleeps
  // on the stream like every other covered query.
  const { data: activityData } = useQuery<ActivityResponse>({
    queryKey: ['activity'],
    queryFn: () => fetchJson('/api/activity'),
    refetchInterval: eventStream.connected ? false : 10000,
    enabled: authenticated && page === 'dashboard',
  })

  // A fresh install has no key to authenticate with, so it gets the setup page
  // instead of the key prompt.
  const { data: setupData } = useQuery({
    queryKey: ['setup'],
    queryFn: fetchSetupStatus,
    staleTime: Infinity,
    enabled: configData !== undefined && !configData.auth_required,
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

  const developer = configData?.developer ?? false

  const handleActionDone = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['trace'] })
    queryClient.invalidateQueries({ queryKey: ['status'] })
  }, [queryClient])

  // Pages that cannot work without an arr service: they all read from Radarr or
  // Sonarr. The local pages (disk, files, mixer, config) always work.
  const hiddenPages = useMemo<Page[]>(() => {
    if (!servicesReady || hasAnyArr) return []
    return ['peliculas', 'series', 'seguimiento'] as Page[]
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

  // Waiting on /api/config, or validating a remembered key.
  if (checkingStored) {
    return <div className="app-loading">Cargando…</div>
  }

  if (configData?.auth_required && !authenticated) {
    return <AuthGate onAuthenticated={handleAuthenticated} />
  }

  if (!configData?.auth_required && setupData?.needs_setup) {
    return (
      <SetupPage
        onDone={() => {
          // The new config needs a refetch, and setting a key takes effect at
          // once, so the browser must already hold it.
          queryClient.invalidateQueries()
          setAuthenticated(true)
        }}
      />
    )
  }

  return (
    <EventStreamContext.Provider value={eventStream}>
      <div className="layout">
        <Sidebar active={page} onNavigate={setPage} developer={developer} hidden={hiddenPages} />

        <div className="main">
          <Topbar
            title={PAGE_TITLES[page]}
            loading={isPending}
            lastUpdated={data ? Date.now() : null}
            right={<ServiceChips services={services} />}
            subtitle={PAGE_SUBTITLES[page]}
          />

          <div className="content-and-queue">
            <div className="content">
              {/* Loud on purpose: unreadable credentials otherwise look like every
                  service being misconfigured, with no hint at the real cause. */}
              {configData?.encryption_ok === false && (
                <div className="wanted-error" role="alert">
                  <strong>No se pudieron leer las credenciales guardadas</strong>
                  {/* Coerced to text on purpose. A non-string here once arrived as
                      `encryption_error: {}` and React error #31 — objects are not
                      valid as a React child — took the whole dashboard down behind
                      ErrorBoundary while every request stayed green. No shape of
                      data should be able to unmount the app. */}
                  <span>{String(configData.encryption_error ?? '')}</span>
                </div>
              )}
              {page === 'dashboard' && (
                <>
                  {nothingConfigured ? (
                    <div className="wanted-empty" role="alert">
                      No hay ningún servicio configurado todavía. Ve a <strong>Configuración</strong> para
                      añadir la URL y la API key de Radarr, Sonarr o aMuTorrent.
                    </div>
                  ) : null}

                  {error && <div className="error-box">Error de conexión con el backend: {error.message}</div>}

                  <DashboardCards
                    downloads={downloadsData?.downloads ?? []}
                    disk={diskData}
                    summary={traceData?.summary}
                    traces={traceData?.traces ?? []}
                    services={services}
                    onOpenSeguimiento={() => setPage('seguimiento')}
                  />

                  <IncidentsBand
                    summary={traceData?.summary}
                    onOpenSeguimiento={() => setPage('seguimiento')}
                  />

                  <ActivityTable
                    items={activityData?.items ?? []}
                    updatedAt={activityData?.updated_at ?? Date.now() / 1000}
                    onRefresh={() =>
                      queryClient.invalidateQueries({ queryKey: ['activity'] })
                    }
                    onOpenSeguimiento={() => setPage('seguimiento')}
                  />
              </>
            )}

            {page === 'peliculas' && <Peliculas />}

            {page === 'series' && <Series />}

            {page === 'seguimiento' && (
              <Seguimiento
                data={traceData ?? null}
                loading={traceLoading}
                actions={actionsData ?? null}
                onActionDone={handleActionDone}
              />
            )}

            {page === 'disk' && <DiskSpace />}

            {page === 'files' && (
              <FileManager />
            )}

            {page === 'mixer' && <MediaMixer />}

            {page === 'config' && <Settings />}

            {page === 'prototypes' && <Prototypes />}
            </div>

            {/* Ambient messages: one viewport for every surface that needs to say something. */}
            <ToastViewport />
          </div>
        </div>
      </div>
    </EventStreamContext.Provider>
  )
}

export default App

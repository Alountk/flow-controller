import '../shared/ui/atoms.css'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AuthGate } from './AuthGate.tsx'
import { SetupPage } from '../pages/SetupPage.tsx'
import { Sidebar } from './Sidebar.tsx'
import { Topbar } from './Topbar.tsx'
import './Dashboard.css'
import { ServiceChips } from './ServiceChips.tsx'
import { DashboardCards } from './DashboardCards.tsx'
import { IncidentsBand } from './IncidentsBand.tsx'
import { ActivityTable } from './ActivityTable.tsx'
import { ToastViewport } from './ToastViewport.tsx'

/**
 * One chunk per page (`carga-por-vista` S1): the shell and the dashboard stay
 * in the first chunk, because the dashboard is where the app lands, and every
 * other screen brings its own JS and its own CSS the first time it opens.
 *
 * The named exports become `default` here, which is the only shape `lazy`
 * accepts — the components themselves keep their names.
 */
const Peliculas = lazy(() =>
  import('../pages/Peliculas.tsx').then((m) => ({ default: m.Peliculas })),
)
const Series = lazy(() => import('../pages/Series.tsx').then((m) => ({ default: m.Series })))
const Estrenos = lazy(() =>
  import('../pages/Estrenos.tsx').then((m) => ({ default: m.Estrenos })),
)
const Seguimiento = lazy(() =>
  import('../pages/Seguimiento.tsx').then((m) => ({ default: m.Seguimiento })),
)
const DiskSpace = lazy(() =>
  import('../pages/DiskSpace.tsx').then((m) => ({ default: m.DiskSpace })),
)
const MediaMixer = lazy(() =>
  import('../pages/MediaMixer.tsx').then((m) => ({ default: m.MediaMixer })),
)
const Prototypes = lazy(() =>
  import('../pages/Prototypes.tsx').then((m) => ({ default: m.Prototypes })),
)
const FileManager = lazy(() =>
  import('../features/file-manager/FileManager.tsx').then((m) => ({ default: m.FileManager })),
)
const Renombrar = lazy(() =>
  import('../pages/Renombrar.tsx').then((m) => ({ default: m.Renombrar })),
)
const Duplicados = lazy(() => import('../pages/Duplicados.tsx'))
const Descargas = lazy(() => import('../pages/Descargas.tsx'))
const Settings = lazy(() =>
  import('../features/settings/Settings.tsx').then((m) => ({ default: m.Settings })),
)

import {
  apiFetch,
  fetchAuthState,
  logout,
  setUnauthorizedHandler,
  type AuthState,
} from '../shared/api/auth.ts'
import { usePageRoute } from '../shared/hooks/usePageRoute.ts'
import { useHashState } from '../shared/hooks/useHashState.ts'
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
 * It goes through `apiFetch` so a rejected key also re-prompts. `init` rides
 * along so callers can pass an AbortSignal (B-12: the activity query hands
 * React Query's signal to fetch through here). */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init)
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
  peliculasV2: 'Películas V2',
  series: 'Series',
  estrenos: 'Estrenos',
  seguimiento: 'Seguimiento',
  descargas: 'Descargas',
  disk: 'Espacio en Disco',
  files: 'Archivos',
  renombrar: 'Renombrar',
  duplicados: 'Duplicados',
  mixer: 'Media Mixer',
  config: 'Configuración',
  prototypes: 'Prototipos',
}

/** Subtitle copy straight from the design screens whose HTML this repo has
 *  read (01 Dashboard, 03 Películas). A page outside this map shows NO
 *  subtitle: inventing copy the design never wrote would be a lie too. */
const PAGE_SUBTITLES: Partial<Record<Page, string>> = {
  dashboard: 'Vista general del servidor multimedia',
  peliculasV2: 'La misma biblioteca, con el detalle a pantalla completa',
  estrenos: 'Calendario de estrenos: películas y series',
}

function App() {
  const queryClient = useQueryClient()

  // Declared before the queries: they are gated on it. `null` while /api/auth/me
  // is in flight. A missing field never gates anything: only an explicit
  // `false` from the backend does.
  const [authState, setAuthState] = useState<AuthState | null>(null)
  const authenticated =
    authState !== null && authState.has_user !== false && authState.authenticated !== false

  const { ready: servicesReady, isConfigured, hasAnyArr } = useConfiguredServices(authenticated)

  const { data: configData } = useQuery<ConfigResponse>({
    queryKey: ['config'],
    queryFn: () => fetchJson('/api/config'),
    staleTime: Infinity,
  })

  // Mounted ONCE, shell-wide: server events invalidate queries the moment
  // they happen; every refetchInterval stays as the fallback (sse-events T3).
  // The stream is gated on being signed in: a cookieless EventSource would
  // 401-retry into C-05's auth-failure budget before the user ever reaches the
  // login.
  // B1: the returned status is what the provider below feeds to the task
  // polls — connected, they sleep; disconnected (the default), they stand.
  // B2: it also feeds the status/trace queries below — the backend
  // announces both surfaces (check_all publishes after every check; the
  // trace refresher on the TTL), so connected they sleep too. Declared
  // above them because they gate on `connected`.
  const eventStream = useEventStream(authenticated)

  // Hoisted with the queries: the dashboard-only readers below gate on it.
  const [page, setPage] = usePageRoute()

  // T3/S1 — the hash carries the just-submitted mix's task id to Seguimiento
  // (`#/seguimiento?highlight=<task id>`, the same hash contract useHashState
  // serves for the media panes' `q`). This instance is the WRITER only — the
  // read side lives in Seguimiento, which also documents the highlight's
  // lifetime.
  const [, setHighlightTask] = useHashState<string>('seguimiento', 'highlight', '')

  // T3/S1 — an accepted «Mezclar» lands the user on Seguimiento with the new
  // mix hoisted and accented (decision L4), instead of losing the task in the
  // queue. ORDER MATTERS: setPage's pushState resolves to the bare path and
  // drops the hash, so the highlight is written AFTER the route change. The
  // same drop is what clears the highlight when the user later leaves the
  // page — the param lives until the user changes tab on Seguimiento or
  // leaves it.
  const handleMixSubmitted = useCallback(
    (taskId: string) => {
      setPage('seguimiento')
      setHighlightTask(taskId)
    },
    [setPage, setHighlightTask],
  )

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
  const { data: activityData, isFetching: activityFetching } = useQuery<ActivityResponse>({
    queryKey: ['activity'],
    // B-12: hand React Query's abort signal to the request, so cancelling a
    // refetch aborts the stale GET instead of letting it run to completion.
    queryFn: ({ signal }) => fetchJson('/api/activity', { signal }),
    refetchInterval: eventStream.connected ? false : 10000,
    enabled: authenticated && page === 'dashboard',
  })

  // The first-run wizard follows the account: the administrator is created
  // first, so by the time the wizard shows the page is already signed in.
  const { data: setupData } = useQuery({
    queryKey: ['setup'],
    queryFn: fetchSetupStatus,
    staleTime: Infinity,
    enabled: authenticated,
  })

  // Who is this browser? Asked once the backend is reachable; the answer picks
  // between creating the administrator, the login, or the app.
  useEffect(() => {
    if (!configData) return
    let active = true
    fetchAuthState()
      .then((state) => active && setAuthState(state))
      .catch(() => active && setAuthState({ authenticated: false, auth_required: true, has_user: true }))
    return () => {
      active = false
    }
  }, [configData])

  async function handleLogout() {
    await logout()
    queryClient.clear()
    setAuthState({ authenticated: false, auth_required: true, has_user: true })
  }

  function handleAuthenticated() {
    setAuthState({ authenticated: true, auth_required: true, has_user: true })
    // The data queries failed while unauthenticated; refetch them now.
    queryClient.invalidateQueries()
  }

  // Any 401 on a page that held a session brings the user back to the login.
  useEffect(() => {
    setUnauthorizedHandler(() =>
      setAuthState({ authenticated: false, auth_required: true, has_user: true }),
    )
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
    // «Películas V2» reads Radarr too, so it hides with the rest when no arr is configured.
    return ['peliculasV2', 'series', 'estrenos', 'seguimiento'] as Page[]
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

  // Waiting on /api/config and /api/auth/me.
  if (authState === null) {
    return <div className="app-loading">Cargando…</div>
  }

  // The first thing anyone sees: create the administrator, or sign in.
  if (!authenticated) {
    return (
      <AuthGate
        mode={authState.has_user === false ? 'create' : 'login'}
        needsApiKey={authState.has_user === false && authState.auth_required}
        onAuthenticated={handleAuthenticated}
      />
    )
  }

  if (setupData?.needs_setup) {
    return <SetupPage onDone={() => queryClient.invalidateQueries()} />
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
            onLogout={authState.has_user ? handleLogout : undefined}
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
              {/* One Suspense for every page: the dashboard never suspends,
                  so it paints without waiting for anything. */}
              <Suspense
                fallback={
                  <p className="page-loading" role="status">
                    Cargando…
                  </p>
                }
              >
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
                    isFetching={activityFetching}
                    onRefresh={() =>
                      queryClient.invalidateQueries({ queryKey: ['activity'] })
                    }
                    onOpenSeguimiento={() => setPage('seguimiento')}
                  />
              </>
            )}

            {page === 'peliculasV2' && <Peliculas layout="page" />}

            {page === 'series' && <Series />}

            {page === 'estrenos' && <Estrenos />}

            {page === 'seguimiento' && (
              <Seguimiento
                data={traceData ?? null}
                loading={traceLoading}
                actions={actionsData ?? null}
                onActionDone={handleActionDone}
              />
            )}

            {page === 'descargas' && <Descargas />}

            {page === 'disk' && <DiskSpace />}

            {page === 'files' && (
              <FileManager />
            )}

            {page === 'renombrar' && <Renombrar />}
            {page === 'duplicados' && <Duplicados />}

            {page === 'mixer' && <MediaMixer onSubmitted={handleMixSubmitted} />}

            {page === 'config' && <Settings />}

            {page === 'prototypes' && <Prototypes />}
              </Suspense>
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

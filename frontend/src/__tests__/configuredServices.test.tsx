import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../App'
import { Sidebar } from '../components/Sidebar'
import { rememberApiKey, forgetApiKey, setUnauthorizedHandler } from '../api/auth'
import type { ServiceKey } from '../types'

/**
 * A service the user has not configured must be invisible, not broken.
 *
 * Without this the app calls it, gets an auth error and reports a failure — for
 * something the user never set up, indistinguishable from a real outage.
 */

function mockFetch(configured: ServiceKey[]) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)

    if (url.includes('/api/config')) return json({ developer: false, auth_required: true })
    if (url.includes('/api/auth/check')) return json({ ok: true })
    if (url.includes('/api/services')) {
      return json({ services: [], configured })
    }
    if (url.includes('/api/status')) {
      return json({ radarr: 'online:ok', sonarr: 'online:ok', amutorrent: 'online:ok', flow: 'running' })
    }
    if (url.includes('/api/trace')) return json({ items: [], summary: {} })
    if (url.includes('/api/actions')) return json({ actions: {} })
    if (url.includes('/api/downloads')) return json({ downloads: [], errors: [] })
    return json({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

describe('sidebar with unconfigured services', () => {
  it('hides the pages that need an arr service', () => {
    render(
      <Sidebar
        active="dashboard"
        onNavigate={() => {}}
        developer={false}
        hidden={['trace', 'wanted', 'calendar']}
      />,
    )

    expect(screen.queryByText('Trazabilidad')).not.toBeInTheDocument()
    expect(screen.queryByText('Faltantes')).not.toBeInTheDocument()
    expect(screen.queryByText('Calendario')).not.toBeInTheDocument()
  })

  it('keeps the local pages, which need no service', () => {
    render(
      <Sidebar
        active="dashboard"
        onNavigate={() => {}}
        developer={false}
        hidden={['trace', 'wanted', 'calendar']}
      />,
    )

    expect(screen.getByText('Disco')).toBeInTheDocument()
    expect(screen.getByText('Archivos')).toBeInTheDocument()
    expect(screen.getByText('Media Mixer')).toBeInTheDocument()
    expect(screen.getByText('Configuración')).toBeInTheDocument()
  })

  it('shows everything when nothing is hidden', () => {
    render(<Sidebar active="dashboard" onNavigate={() => {}} developer={false} />)

    expect(screen.getByText('Trazabilidad')).toBeInTheDocument()
    expect(screen.getByText('Calendario')).toBeInTheDocument()
  })
})

describe('the app reflects what is configured', () => {
  beforeEach(() => {
    forgetApiKey()
    rememberApiKey('clave')
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
    forgetApiKey()
  })

  it('hides the arr-dependent pages when no arr is configured', async () => {
    mockFetch(['amutorrent'])
    renderApp()

    // Wait for PRESENCE first: asserting absence passes while the app is still
    // on its loading screen, proving nothing.
    await waitFor(() => expect(screen.getByText('Archivos')).toBeInTheDocument())
    expect(screen.queryByText('Trazabilidad')).not.toBeInTheDocument()
    expect(screen.queryByText('Faltantes')).not.toBeInTheDocument()
  })

  it('keeps the arr-dependent pages when at least one arr exists', async () => {
    mockFetch(['radarr'])
    renderApp()

    await waitFor(() => expect(screen.getByText('Trazabilidad')).toBeInTheDocument())
    expect(screen.getByText('Faltantes')).toBeInTheDocument()
  })

  it('does not report an empty pipeline as healthy', async () => {
    // `every` on an empty list is true, which would have shown "flujo operativo"
    // with nothing configured at all.
    mockFetch([])
    renderApp()

    await waitFor(() =>
      expect(screen.getByText(/No hay ningún servicio configurado/)).toBeInTheDocument(),
    )
    expect(screen.queryByText('Flujo operativo')).not.toBeInTheDocument()
  })

  it('shows the pipeline when services are configured', async () => {
    mockFetch(['radarr', 'sonarr'])
    renderApp()

    await waitFor(() => expect(screen.getByText(/Flujo operativo/)).toBeInTheDocument())
    expect(screen.queryByText(/No hay ningún servicio configurado/)).not.toBeInTheDocument()
  })

  it('only lists configured services in the pipeline', async () => {
    mockFetch(['radarr'])
    renderApp()

    await waitFor(() => expect(screen.getByText('Radarr')).toBeInTheDocument())
    expect(screen.queryByText('AmuTorrent')).not.toBeInTheDocument()
  })

  it('moves off a page whose service disappeared', async () => {
    mockFetch([])
    window.location.hash = '#/trazabilidad'

    renderApp()

    // Hidden pages cannot be displayed, so the app falls back to the dashboard.
    await waitFor(() => expect(screen.getByText('Resumen del sistema')).toBeInTheDocument())
  })
})

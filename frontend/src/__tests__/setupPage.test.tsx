import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../App'
import { forgetApiKey, hasStoredApiKey, setUnauthorizedHandler } from '../api/auth'

/**
 * A fresh install must be configurable from the UI.
 *
 * Without this the only way in is editing files on the volume, and the settings
 * page that would do it sits behind a key that does not exist yet.
 */

function mockFetch(opts: { needsSetup: boolean; authRequired: boolean }) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)

    if (url.includes('/api/setup')) {
      if (init?.method === 'POST') return json({ ok: true, restart_required: [] })
      return json({ needs_setup: opts.needsSetup, auth_required: opts.authRequired })
    }
    if (url.includes('/api/config')) {
      return json({ developer: false, auth_required: opts.authRequired, encryption_ok: true })
    }
    if (url.includes('/api/auth/check')) return json({ ok: true })
    if (url.includes('/api/services')) return json({ services: [], configured: [] })
    if (url.includes('/api/status')) return json({ flow: 'unconfigured', checking: false, updated_at: 0 })
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

describe('first-run setup page', () => {
  beforeEach(() => {
    forgetApiKey()
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
    forgetApiKey()
  })

  it('replaces the key prompt on an install with nothing configured', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    renderApp()

    expect(await screen.findByText(/Bienvenido a Flow Controller/)).toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
  })

  it('offers a field for each service', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    renderApp()

    await screen.findByText(/Bienvenido/)
    for (const label of ['URL de Radarr', 'API Key de Radarr', 'URL de Sonarr', 'API Key de Sonarr']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    }
    // aMuTorrent additionally needs its credentials.
    expect(screen.getByLabelText('Usuario de aMuTorrent')).toBeInTheDocument()
    expect(screen.getByLabelText('Contraseña de aMuTorrent')).toBeInTheDocument()
  })

  it('lets the user leave the app unprotected', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    renderApp()

    await screen.findByText(/Bienvenido/)
    expect(screen.getByLabelText('API key de la app')).toBeInTheDocument()
    expect(screen.getByText(/Sin clave, cualquiera que alcance el puerto/)).toBeInTheDocument()
  })

  it('does not appear when the install is already configured', async () => {
    mockFetch({ needsSetup: false, authRequired: true })
    renderApp()

    // With a key configured and none stored, the gate is what shows.
    await waitFor(() => expect(screen.getByLabelText('API key')).toBeInTheDocument())
    expect(screen.queryByText(/Bienvenido/)).not.toBeInTheDocument()
  })

  it('saves and remembers the key so the session continues', async () => {
    const fn = mockFetch({ needsSetup: true, authRequired: false })
    renderApp()

    await screen.findByText(/Bienvenido/)
    fireEvent.change(screen.getByLabelText('API Key de Radarr'), { target: { value: 'r-key' } })
    fireEvent.change(screen.getByLabelText('API key de la app'), { target: { value: 'app-key' } })
    fireEvent.click(screen.getByRole('button', { name: /Guardar y entrar/ }))

    await waitFor(() => expect(hasStoredApiKey()).toBe(true))

    const post = fn.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      services: { radarr: { api_key: 'r-key' } },
      api_key: 'app-key',
    })
  })
})

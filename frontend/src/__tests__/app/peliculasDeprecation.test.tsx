import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../app/App.tsx'
import { setUnauthorizedHandler } from '../../shared/api/auth.ts'

/**
 * «hay que deprecar Películas y quedarnos con Películas V2 como fuente de
 * verdad»: the V1 entry points are gone, and the old /peliculas URL must land
 * on the V2 view instead of breaking. The URL itself is allowed to stay put —
 * resolution, not rewriting, is the contract.
 */

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch() {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/config')) {
      return ok({ developer: false, auth_required: false, encryption_ok: true })
    }
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/status')) {
      return ok({ radarr: 'online:ok', sonarr: 'online:ok', amutorrent: 'online:ok' })
    }
    if (url.includes('/api/trace')) {
      return ok({ traces: [], summary: {}, indexer: '', updated_at: 0 })
    }
    return ok({})
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

function at(path: string) {
  window.history.pushState(null, '', path)
}

/** The router's own popstate: pushState alone fires nothing (navigateTo). */
function navigate(path: string) {
  at(path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** The V2 shape: the L2 list owns the page — no sub-view tabs, no split. */
async function expectV2View() {
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1, name: 'Películas V2' })).toBeInTheDocument(),
  )
  // The page travels in its own chunk («carga-por-vista»): the L2 search box
  // is the V2 list's own, so its arrival IS the view's arrival.
  await screen.findByLabelText('Buscar película', {}, { timeout: 5000 })
  expect(document.querySelector('.sec-page')).not.toBeNull()
  expect(document.querySelector('.sec-subtabs')).toBeNull()
  expect(document.querySelector('.sec-split')).toBeNull()
}

beforeEach(() => {
  at('/dashboard')
  stubFetch()
  setUnauthorizedHandler(vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.pushState(null, '', '/dashboard')
})

describe('Películas V2 is the single source of truth', () => {
  it('renders the V2 view at /peliculas-v2', async () => {
    at('/peliculas-v2')
    renderApp()

    await expectV2View()
  })

  it('resolves the deprecated /peliculas URL to the V2 view (popstate navigation)', async () => {
    renderApp()
    await waitFor(() => expect(document.querySelector('.topbar-dot')).not.toBeNull())

    navigate('/peliculas')

    await expectV2View()
    // The alias resolves, it does not rewrite: the URL the user typed stays.
    expect(window.location.pathname).toBe('/peliculas')
  })

  it('resolves a direct load of /peliculas to the V2 view', async () => {
    at('/peliculas')
    renderApp()

    await expectV2View()
    expect(window.location.pathname).toBe('/peliculas')
  })

  it('shows no sidebar link to the retired /peliculas entry', async () => {
    renderApp()
    await waitFor(() => expect(document.querySelector('.topbar-dot')).not.toBeNull())

    expect(document.querySelector('a[href="/peliculas"]')).toBeNull()
    expect(screen.getByRole('link', { name: /Películas V2/ })).toHaveAttribute(
      'href',
      '/peliculas-v2',
    )
  })
})

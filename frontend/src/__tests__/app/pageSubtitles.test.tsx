import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../app/App.tsx'
import { setUnauthorizedHandler } from '../../shared/api/auth.ts'

/**
 * Topbar shell per design (stitch-peliculas-03 T3): the subtitle is a
 * per-page copy from the design screens (dashboard + Películas are the only
 * screens whose HTML this repo has read — a page the design never gave a
 * subtitle renders NONE), and the service chips ride EVERY page, not just
 * the dashboard (the design's app shell repeats them in each topbar).
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

beforeEach(() => {
  at('/dashboard')
  stubFetch()
  setUnauthorizedHandler(vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('topbar shell (design 01 + 03)', () => {
  it('shows the dashboard subtitle on the dashboard', async () => {
    renderApp()

    await waitFor(() =>
      expect(
        document.querySelector('.topbar-subtitle')?.textContent,
      ).toBe('Vista general del servidor multimedia'),
    )
  })

  it('shows the Peliculas design subtitle and the chips on Peliculas', async () => {
    at('/peliculas')
    renderApp()

    await waitFor(() =>
      expect(
        document.querySelector('.topbar-subtitle')?.textContent,
      ).toBe('Catálogo cinematográfico y gestión de indexación'),
    )
    expect(document.querySelector('.service-chips')).not.toBeNull()
  })

  it('renders no subtitle where the design never gave one — but keeps the chips', async () => {
    at('/series')
    renderApp()

    // The topbar itself is the render anchor.
    await waitFor(() => expect(document.querySelector('.topbar-dot')).not.toBeNull())
    expect(document.querySelector('.topbar-subtitle')).toBeNull()
    expect(document.querySelector('.service-chips')).not.toBeNull()
  })
})

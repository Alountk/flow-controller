import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'

/**
 * A failed fetch must never read as "nothing missing".
 *
 * The backend used to return an empty list for a timeout, a rejected API key or
 * an unreachable host, so the UI stated "No hay películas faltantes" with
 * confidence. Now the backend reports WHY, and the UI must show that instead.
 *
 * Driven through Películas · Faltantes — the sub-view the retired Faltantes
 * page became (PR 7 of F-08).
 */

interface WantedPayload {
  items?: unknown[]
  total?: number
  error?: string
  error_kind?: string
}

function mockFetch(radarr: WantedPayload) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    // The section opens on Biblioteca, which asks for the catalogue; these
    // tests drive Faltantes, so the catalogue answers empty. It must be a
    // listing shape: a wanted-shaped body here would crash the pane.
    if (url.includes('/api/wanted/all')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, page_size: 50 }),
      } as Response)
    }
    if (url.includes('/api/wanted')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          wanted: {
            radarr: { items: [], total: 0, ...radarr },
            sonarr: { items: [], total: 0 },
          },
          updated_at: 0,
        }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Películas · Faltantes: where the missing listing lives since PR 7. */
function renderFaltantes() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Peliculas />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
}

describe('wanted failure is reported, not disguised', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the reason when Radarr could not be reached', async () => {
    mockFetch({
      error: 'radarr: no respondió a tiempo',
      error_kind: 'timeout',
    })

    renderFaltantes()

    await waitFor(() =>
      expect(screen.getByText('No se pudo consultar Radarr')).toBeInTheDocument(),
    )
    expect(screen.getByText('radarr: no respondió a tiempo')).toBeInTheDocument()
  })

  it('does NOT claim there is nothing missing when the call failed', async () => {
    mockFetch({ error: 'radarr: API key rechazada (HTTP 401)', error_kind: 'auth' })

    renderFaltantes()

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.queryByText('No hay películas faltantes')).not.toBeInTheDocument()
  })

  it('still says nothing is missing when Radarr genuinely answered empty', async () => {
    mockFetch({ items: [], total: 0 })

    renderFaltantes()

    await waitFor(() =>
      expect(screen.getByText('No hay películas faltantes')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces the failure as an alert for assistive tech', async () => {
    mockFetch({ error: 'radarr: no se pudo conectar (ClientError)', error_kind: 'unreachable' })

    renderFaltantes()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo consultar Radarr')
  })

  it('shows items normally when the call succeeds', async () => {
    mockFetch({
      items: [
        { id: 1, title: 'Una Pelicula', year: 2020, overview: '', remotePoster: '', has_file: false, altTitles: [] },
      ],
      total: 1,
    })

    renderFaltantes()

    await waitFor(() => expect(screen.getByText(/Una Pelicula/)).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

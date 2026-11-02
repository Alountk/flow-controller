import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'

/**
 * V2 («detalle-pantalla» S1/S2/S3/S4): the same page with the detail as a
 * FULL-PAGE view — no sub-view tabs, the list owns the screen, a row opens the
 * detail and the ✕ comes back. The shipped V1 (`layout` default) keeps its
 * side panel and its tabs; these tests pin only the V2 shape.
 */

const movie = {
  id: 7,
  title: 'ParaNorman',
  year: 2012,
  remotePoster: '',
  has_file: true,
  path: '/movies/ParaNorman (2012)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-1080p',
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [movie], total: 1, page: 1, page_size: 0 })
    }
    if (url.includes('/api/mixer/quality/below')) {
      return ok({
        threshold: { min_class: '1080p', min_width: 0 },
        items: [],
        analyzed: 0,
        unanalyzed: 0,
      })
    }
    if (url.includes('/api/settings')) return ok({ paths: { path_4k: '', path_3d: '' } })
    return ok({})
  }))
}

function renderV2() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Peliculas layout="page" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.location.hash = ''
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('V2 · el detalle sustituye la vista', () => {
  it('shows no sub-view tabs — Biblioteca / Estrenos / Calidad are gone (S2)', async () => {
    renderV2()

    await screen.findByText('ParaNorman')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('opens the detail from the row arrow, replacing the list (S3)', async () => {
    renderV2()

    await screen.findByText('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ParaNorman' }))

    const panel = await screen.findByRole('region', { name: 'Panel de detalle' })
    expect(within(panel).getByRole('button', { name: 'Cerrar detalle' })).toBeInTheDocument()
    // The list is gone: the detail took the screen.
    expect(document.querySelector('.sec-movie-list')).toBeNull()
  })

  it('comes back to the list with the ✕ (S4)', async () => {
    renderV2()

    await screen.findByText('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ParaNorman' }))
    await screen.findByRole('region', { name: 'Panel de detalle' })

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalle' }))

    expect(await screen.findByText('ParaNorman')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Panel de detalle' })).toBeNull()
  })

  it('keeps V1 untouched: the default layout still has its tabs and side panel', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <Peliculas />
      </QueryClientProvider>,
    )

    const tabs = await screen.findAllByRole('tab')
    expect(tabs.length).toBeGreaterThanOrEqual(3)
    expect(screen.getByRole('region', { name: 'Panel de detalle' })).toBeInTheDocument()
  })
})

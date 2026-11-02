import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Estrenos } from '../../pages/Estrenos.tsx'

/**
 * Estrenos («detalle-pantalla» T4): the calendar as its own page, showing
 * movies AND series episodes — the reason it can survive the sub-view tabs
 * going away.
 */

const calendar = {
  items: [
    {
      id: 11,
      type: 'movie',
      title: 'Dune: Parte Dos',
      release_date: '2026-11-05',
      year: 2024,
      has_file: false,
    },
    {
      id: 12,
      type: 'episode',
      title: 'Andor — S02E03',
      release_date: '2026-11-06',
      year: 2025,
      has_file: false,
    },
  ],
  updated_at: 0,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/calendar')) return ok(calendar)
    return ok({})
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Estrenos />
    </QueryClientProvider>,
  )
}

describe('Estrenos · una página con las dos agendas', () => {
  it('shows the movie release and the series episode from one calendar', async () => {
    renderPage()

    expect(await screen.findByText(/Dune: Parte Dos/)).toBeInTheDocument()
    expect(screen.getByText(/Andor — S02E03/)).toBeInTheDocument()
  })

  it('asks for the calendar range without filtering by type', async () => {
    const fn = vi.mocked(fetch)
    renderPage()

    await screen.findByText(/Dune: Parte Dos/)
    const urls = fn.mock.calls.map((call) => String(call[0]))
    const calendarCall = urls.find((url) => url.includes('/api/calendar')) ?? ''
    // No `type=movie` / `type=episode`: the page shows both, on purpose.
    expect(calendarCall).not.toMatch(/type=/)
  })
})

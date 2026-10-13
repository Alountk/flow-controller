import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'

/**
 * Design-03 inspector header (stitch-peliculas-03 T4): the monitored pill,
 * the `year • runtime min` line, the mono IMDb chip and the Radarr ID. Every
 * element is backed by the T1 enrichment — a movie the mapper enriched with
 * nothing shows the ID (its own primary key) and NOTHING else: no pill-less
 * dot, no empty chip, no runtime line.
 */

const enrichedMovie = {
  id: 411,
  title: 'Dune: Part Two',
  year: 2024,
  remotePoster: '',
  has_file: true,
  path: '/peliculas/Dune Part Two (2024)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-2160p',
  grabbed_at: null,
  grabbed_destination: null,
  imdb_id: 'tt15239678',
  runtime: 166,
}

const plainMovie = {
  id: 412,
  title: 'El Verdugo',
  year: 1963,
  remotePoster: '',
  has_file: false,
  path: '/peliculas/El Verdugo (1963)',
  path_exists: true,
  monitored: false,
  quality: '',
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch() {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr'] })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [enrichedMovie, plainMovie], total: 2, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({ wanted: { radarr: { items: [], total: 0 } }, updated_at: 0 })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Peliculas />
    </QueryClientProvider>,
  )
}

const panel = () => document.querySelector('.sec-detail') as HTMLElement
const rows = () => Array.from(document.querySelectorAll('.sec-row')) as HTMLElement[]

beforeEach(() => {
  window.location.hash = ''
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inspector header · monitored pill', () => {
  it('shows the design pill for the selected monitored movie', async () => {
    renderSection()
    await screen.findByText('Dune: Part Two')
    fireEvent.click(rows().find((r) => r.textContent?.includes('Dune: Part Two')) as HTMLElement)

    const pill = within(panel()).getByText('Monitoreada')
    expect(pill.className).toContain('sec-detail-mon')
    expect(pill.className).toContain('on')
  })

  it('states the real flag when the movie is not monitored', async () => {
    renderSection()
    await screen.findByText('Dune: Part Two')

    fireEvent.click(rows().find((r) => r.textContent?.includes('El Verdugo')) as HTMLElement)

    expect(within(panel()).getByText('Sin monitorear').className).toContain('sec-detail-mon')
  })
})

describe('inspector header · year and runtime line', () => {
  it('shows the design line when the mapper sent a runtime', async () => {
    renderSection()
    await screen.findByText('Dune: Part Two')
    fireEvent.click(rows().find((r) => r.textContent?.includes('Dune: Part Two')) as HTMLElement)

    expect(within(panel()).getByText('2024 • 166 min').className).toContain('sec-detail-sub')
  })

  it('shows no line at all without a runtime', async () => {
    renderSection()
    await screen.findByText('Dune: Part Two')

    fireEvent.click(rows().find((r) => r.textContent?.includes('El Verdugo')) as HTMLElement)

    expect(within(panel()).queryByText(/\d+ min/)).toBeNull()
  })
})

describe('inspector header · IMDb and Radarr ID chips', () => {
  it('shows the mono IMDb chip and the Radarr ID', async () => {
    renderSection()
    await screen.findByText('Dune: Part Two')
    fireEvent.click(rows().find((r) => r.textContent?.includes('Dune: Part Two')) as HTMLElement)

    expect(within(panel()).getByText('tt15239678').className).toContain('sec-detail-chip')
    expect(within(panel()).getByText('Radarr ID: #411')).toBeInTheDocument()
  })

  it('keeps the ID but drops the IMDb chip when Radarr never sent one', async () => {
    renderSection()
    await screen.findByText('Dune: Part Two')

    fireEvent.click(rows().find((r) => r.textContent?.includes('El Verdugo')) as HTMLElement)

    expect(within(panel()).queryByText(/^tt/)).toBeNull()
    expect(within(panel()).getByText('Radarr ID: #412')).toBeInTheDocument()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'
import { Series } from '../../pages/Series.tsx'

/**
 * Design-03 counter row (stitch-peliculas-03 T5, user decision): the totals
 * move out of the mirror buttons — `Faltantes`/`Todas` keep their job as the
 * sub-view switch (PR #150 made them the ONLY way to reach the missing view)
 * but stop carrying the numbers, and the design's counter line states each
 * figure exactly once: `N películas catalogadas • M pendientes`.
 */

const catalogMovie = {
  id: 1,
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
}

const wantedMovie = {
  id: 813,
  title: 'Todo a la vez en todas partes',
  year: 2022,
  overview: '',
  remotePoster: '',
  has_file: false,
  altTitles: [],
  grabbed_at: null,
  grabbed_destination: null,
}

const series = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: true,
  path: '/series/Some Show',
  path_exists: true,
  monitored: false,
  episode_count: 10,
  episode_file_count: 4,
  grabbed_at: null,
  grabbed_destination: null,
}

const episode = {
  id: 7,
  title: 'Of Ice Men',
  series_title: 'Some Show',
  series_id: 3,
  season_number: 3,
  episode_number: 7,
  air_date: '2006-11-27T00:00:00Z',
  overview: '',
  has_file: false,
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
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [series], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [catalogMovie, wantedMovie], total: 2, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: {
          radarr: { items: [wantedMovie], total: 1 },
          sonarr: { items: [episode], total: 1 },
        },
        updated_at: 0,
      })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderPage(Component: typeof Peliculas | typeof Series) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

const counter = () => document.querySelector('.wanted-counter')

beforeEach(() => {
  window.location.hash = ''
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('design counter row', () => {
  it('states the movies totals once, in the design copy', async () => {
    renderPage(Peliculas)

    await screen.findByText('Dune: Part Two')
    await waitFor(() =>
      expect(counter()?.textContent).toBe('2 películas catalogadas • 1 pendientes'),
    )
  })

  it('states the series totals with the series wording', async () => {
    renderPage(Series)

    await screen.findByText('Some Show')
    await waitFor(() =>
      expect(counter()?.textContent).toBe('1 series catalogadas • 1 pendientes'),
    )
  })

  it('keeps the mirror buttons as the view switch — without their counts', async () => {
    renderPage(Peliculas)
    await screen.findByText('Dune: Part Two')

    expect(screen.getByRole('button', { name: 'Faltantes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Todas' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Faltantes \(/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Todas \(/ })).toBeNull()
  })
})

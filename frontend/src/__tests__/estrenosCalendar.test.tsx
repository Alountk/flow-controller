import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../components/Peliculas'
import { Series } from '../components/Series'
import { Calendar } from '../components/Calendar'

/**
 * PR 3 of F-08: the Estrenos sub-view re-homes the calendar.
 *
 * What these guard is the wiring that is NOT covered elsewhere: each section
 * filters the calendar to ITS type (Películas → movies, Series → episodes),
 * the unfiltered calendar still shows both types on the Calendario page, and
 * the release search still opens as a MODAL from inside the section — it only
 * moves into the detail panel in PR 5.
 */

const movie = {
  type: 'movie',
  id: 855,
  title: 'Estreno de Película',
  date: '2026-10-05',
  year: 2026,
  has_file: false,
  remotePoster: '',
  series_title: null,
  season_number: null,
  episode_number: null,
  source: 'radarr',
  grabbed_at: null,
  grabbed_destination: null,
}

const episode = {
  type: 'episode',
  id: 42,
  title: 'Estreno de Episodio',
  date: '2026-10-06',
  year: null,
  has_file: false,
  remotePoster: '',
  series_title: 'Serie de Estreno',
  season_number: 1,
  episode_number: 2,
  source: 'sonarr',
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** The calendar answers with both types; the panes answer with empty listings. */
function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/calendar?')) {
        return ok({ items: [movie, episode], start: '2026-10-01', end: '2026-11-01' })
      }
      if (url.includes('/api/wanted/series/all')) {
        return ok({ items: [], total: 0, page: 1, page_size: 50 })
      }
      if (url.includes('/api/wanted/all')) {
        return ok({ items: [], total: 0, page: 1, page_size: 50 })
      }
      if (url.includes('/api/wanted?')) {
        return ok({
          wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [], total: 0 } },
          updated_at: 0,
        })
      }
      return ok({})
    }),
  )
}

function renderWith(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

const countLabel = () => document.querySelector('.calendar-count')?.textContent ?? ''

describe('Películas · Estrenos shows only movie releases', () => {
  beforeEach(() => mockFetch())

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the movie from the calendar and hides the episode', async () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))

    expect(await screen.findByText('Estreno de Película')).toBeInTheDocument()
    expect(screen.queryByText('Estreno de Episodio')).not.toBeInTheDocument()
    expect(screen.queryByText('Serie de Estreno')).not.toBeInTheDocument()
    // The count strip counts only what the section can show.
    expect(countLabel()).toContain('películas')
    expect(countLabel()).not.toContain('episodios')
  })

  it('still opens the release search as a modal from inside the section', async () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
    fireEvent.click(await screen.findByText('Estreno de Película'))

    // Until PR 5 this is a modal, not the detail panel.
    expect(document.querySelector('.scan-modal-backdrop')).not.toBeNull()
    expect(document.querySelector('.scan-modal')).not.toBeNull()
  })

  it('keeps the honest note: the release search is still a modal until PR 5', () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))

    const note = document.querySelector('.sec-panel-note')
    expect(note?.textContent).toMatch(/modal/)
    expect(note?.textContent).toContain('PR 5')
  })
})

describe('Series · Estrenos shows only episode releases', () => {
  beforeEach(() => mockFetch())

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the episode from the calendar and hides the movie', async () => {
    renderWith(Series)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))

    expect(await screen.findByText('Estreno de Episodio')).toBeInTheDocument()
    expect(screen.queryByText('Estreno de Película')).not.toBeInTheDocument()
    expect(countLabel()).toContain('episodios')
    expect(countLabel()).not.toContain('películas')
  })
})

describe('Calendar without a type filter (the Calendario page)', () => {
  beforeEach(() => mockFetch())

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows both types, the date range and the week navigation, as before', async () => {
    // Computed before rendering, so the range cannot shift mid-assertion.
    const today = new Date()
    const inThirtyDays = new Date()
    inThirtyDays.setDate(inThirtyDays.getDate() + 30)
    const expectedStart = today.toISOString().slice(0, 10)
    const expectedEnd = inThirtyDays.toISOString().slice(0, 10)

    renderWith(Calendar)

    expect(await screen.findByText('Estreno de Película')).toBeInTheDocument()
    expect(screen.getByText('Estreno de Episodio')).toBeInTheDocument()

    const range = document.querySelector('.calendar-range')
    expect(range?.textContent).toContain(expectedStart)
    expect(range?.textContent).toContain(expectedEnd)
    expect(countLabel()).toContain('películas')
    expect(countLabel()).toContain('episodios')

    expect(screen.getByRole('button', { name: '← Semana' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Semana →' })).toBeInTheDocument()
  })
})

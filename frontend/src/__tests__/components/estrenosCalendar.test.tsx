import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../components/Peliculas'
import { Series } from '../../components/Series'
import { Calendar } from '../../components/Calendar'

/**
 * PR 3 of F-08: the Estrenos sub-view re-homes the calendar.
 *
 * What these guard is the wiring that is NOT covered elsewhere: each section
 * filters the calendar to ITS type (Películas → movies, Series → episodes),
 * the unfiltered calendar still shows both types when no section applies a
 * filter (PR 7 retired the Calendario page; the component's own default is
 * what that third describe pins), and
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

  it('selects the missing item into the detail panel instead of a modal', async () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
    fireEvent.click(await screen.findByText('Estreno de Película'))

    // The click is a SELECTION: the panel shows the item — its own heading,
    // inside the panel's own column —
    const detail = document.querySelector('.sec-detail')
    expect(detail?.querySelector('h3')?.textContent).toBe('Estreno de Película')
    // — and the release search for it renders INLINE in that panel,
    expect(document.querySelector('.release-inline')).not.toBeNull()
    expect(detail?.contains(document.querySelector('.release-inline') as Node)).toBe(true)
    // never as an overlay: no backdrop, no modal chrome.
    expect(document.querySelector('.scan-modal-backdrop')).toBeNull()
    expect(document.querySelector('.scan-modal')).toBeNull()
  })

  it('keeps the honest note: the release search lives in the panel, not as a modal', () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))

    const note = document.querySelector('.sec-panel-note')
    expect(note?.textContent).toContain('PR 5')
    expect(note?.textContent).toMatch(/Releases/)
    // The calendar selects since this change, so the note must no longer
    // promise a modal from Estrenos.
    expect(note?.textContent).not.toMatch(/modal/)
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

describe('Calendar without a type filter (the component\u2019s own default)', () => {
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

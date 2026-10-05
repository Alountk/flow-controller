import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../components/Peliculas'
import { Series } from '../../components/Series'

/**
 * The section rows' mini-poster, the behaviour sectionsPanel pins the shape
 * of and this file pins the lifecycle of:
 *
 * - a row whose data carries a poster layers the real <img> over the
 *   CSS-drawn initials (alt="" — the title beside the box already names it,
 *   lazy — these lists paginate),
 * - a row whose data carries none (a series with "", an episode payload with
 *   no field at all) keeps the initials: no data, no image, never a guess,
 * - a URL that fails to load drops the image and leaves the gradient +
 *   initials underneath: no poster ever degrades to a blank box.
 */

const catalogMovie = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: 'https://img.example/your-name.jpg',
  has_file: true,
  path: '/peliculas/Your Name. (2016)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-2160p',
  grabbed_at: null,
  grabbed_destination: null,
}

/** Same shape, no poster: the initials path on a catalogue row. */
const posterlessSeries = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: true,
  path: '/series/Some Show',
  path_exists: true,
  monitored: true,
  episode_count: 10,
  episode_file_count: 4,
  grabbed_at: null,
  grabbed_destination: null,
}

/** The wanted-episode payload: no poster field exists on it at all. */
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
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [posterlessSeries], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [catalogMovie], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [episode], total: 1 } },
        updated_at: 0,
      })
    }
    void init
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

/** The first row the pane rendered in the master column. */
const firstRow = () => document.querySelector('.sec-row') as HTMLElement

const posterBox = () => firstRow().querySelector('.sec-row-poster') as HTMLElement

describe('section rows · the mini-poster', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('layers the row’s poster over the initials, decorative and lazy', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    const poster = posterBox()
    // The initials stay in the DOM (and as the box's text content): they are
    // the load/error fallback under the image.
    expect(poster.textContent).toBe('YN')
    const img = poster.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'https://img.example/your-name.jpg')
    // Decorative: the title sits right beside the box.
    expect(img).toHaveAttribute('alt', '')
    // These lists paginate: a page of 50 posters is 50 requests.
    expect(img).toHaveAttribute('loading', 'lazy')
  })

  it('keeps the initials on a row whose data carries no poster', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    const poster = posterBox()
    expect(poster.querySelector('img')).toBeNull()
    expect(poster.textContent).toBe('SS')
  })

  it('renders no image on an episode row: the payload carries none', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Of Ice Men')

    const row = firstRow()
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('.sec-row-poster')?.textContent).toBe('SS')
  })

  it('falls back to the gradient and initials when the poster fails to load', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    const poster = posterBox()
    const img = poster.querySelector('img') as HTMLImageElement
    fireEvent.error(img)

    // The image is gone for good on this row — and what is left is exactly
    // what a poster-less row shows: initials, never a blank box.
    expect(poster.querySelector('img')).toBeNull()
    expect(poster.textContent).toBe('YN')
    expect(firstRow().querySelector('.sec-row-name')?.textContent).toBe('Your Name.')
  })
})

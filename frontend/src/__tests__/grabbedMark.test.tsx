import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MissingContent } from '../components/MissingContent'

/**
 * Tests for the "descarga pedida" mark in Faltantes.
 *
 * A title the app grabbed and that is still missing is orange with "Pedida el
 * <fecha>". A title with no mark shows NOTHING — not a dash, not an empty slot.
 * The date is Spanish and short ("19 sep 2026").
 */

// Noon UTC on 19 September 2026, so the local date is the same in any timezone.
const GRABBED_AT = Date.UTC(2026, 8, 19, 12, 0, 0) / 1000

function movie(grabbedAt: number | null, destination: string | null = null) {
  return {
    id: 411,
    title: 'Your Name.',
    year: 2016,
    overview: '',
    remotePoster: '',
    has_file: false,
    altTitles: [],
    grabbed_at: grabbedAt,
    grabbed_destination: destination,
  }
}

function episode(grabbedAt: number | null, destination: string | null = null) {
  return {
    id: 7,
    title: 'Of Ice Men',
    series_title: 'Some Show',
    series_id: 3,
    season_number: 3,
    episode_number: 7,
    air_date: '2006-11-27T00:00:00Z',
    overview: '',
    has_file: false,
    grabbed_at: grabbedAt,
    grabbed_destination: destination,
  }
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function mockFetch(movieItem: unknown, episodeItem: unknown) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: {
          radarr: { items: [movieItem], total: 1 },
          sonarr: { items: [episodeItem], total: 1 },
        },
        updated_at: 0,
      })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderWanted() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MissingContent />
    </QueryClientProvider>,
  )
}

/** The exact label the component must render, computed the same local way. */
function expectedLabel(ts: number): string {
  const d = new Date(ts * 1000)
  return `Pedida el ${d.getDate()} sep ${d.getFullYear()}`
}

describe('Faltantes "descarga pedida" mark', () => {
  beforeEach(() => {
    // Tab and filters live in the URL hash, so each test starts clean.
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the mark and the date on a grabbed movie card', async () => {
    mockFetch(movie(GRABBED_AT), episode(GRABBED_AT))
    renderWanted()

    await screen.findByText('Your Name.')
    expect(await screen.findByText(expectedLabel(GRABBED_AT))).toBeInTheDocument()
    expect(document.querySelector('.wanted-card.status-grabbed')).not.toBeNull()
  })

  it('shows the mark and the date on a grabbed episode row', async () => {
    mockFetch(movie(GRABBED_AT), episode(GRABBED_AT))
    renderWanted()

    await screen.findByText('Your Name.')
    fireEvent.click(screen.getByText(/Episodios/))
    await screen.findByText('Of Ice Men')

    expect(await screen.findByText(expectedLabel(GRABBED_AT))).toBeInTheDocument()
    expect(document.querySelector('.wanted-row.status-grabbed')).not.toBeNull()
  })

  it('shows where the download was sent on a grabbed movie card', async () => {
    mockFetch(movie(GRABBED_AT, '/mnt/storage/movies/_manual'), episode(null))
    renderWanted()

    await screen.findByText('Your Name.')
    const mark = document.querySelector('.wanted-card.status-grabbed .wanted-grabbed')

    expect(mark?.textContent).toContain(expectedLabel(GRABBED_AT))
    expect(mark?.textContent).toContain('→ _manual')
    expect(mark?.getAttribute('title')).toBe('/mnt/storage/movies/_manual')
  })

  it('shows where the download was sent on a grabbed episode row', async () => {
    mockFetch(movie(null), episode(GRABBED_AT, '/mnt/storage/series/_manual'))
    renderWanted()

    await screen.findByText('Your Name.')
    fireEvent.click(screen.getByText(/Episodios/))
    await screen.findByText('Of Ice Men')

    const mark = document.querySelector('.wanted-row.status-grabbed .wanted-grabbed')

    expect(mark?.textContent).toContain('→ _manual')
    expect(mark?.getAttribute('title')).toBe('/mnt/storage/series/_manual')
  })

  it('keeps the mark unchanged when the grab went to the library', async () => {
    mockFetch(movie(GRABBED_AT, null), episode(null))
    renderWanted()

    await screen.findByText('Your Name.')
    const mark = document.querySelector('.wanted-card.status-grabbed .wanted-grabbed')

    expect(mark?.textContent).toBe(expectedLabel(GRABBED_AT))
    expect(mark?.getAttribute('title')).toBeNull()
  })

  it('shows nothing for an unmarked movie', async () => {
    mockFetch(movie(null), episode(null))
    renderWanted()

    await screen.findByText('Your Name.')
    await waitFor(() => expect(document.querySelectorAll('.wanted-card').length).toBe(1))

    expect(screen.queryByText(/Pedida el/)).not.toBeInTheDocument()
    expect(document.querySelectorAll('.wanted-grabbed')).toHaveLength(0)
    expect(document.querySelector('.wanted-card.status-grabbed')).toBeNull()
  })

  it('shows nothing for an unmarked episode', async () => {
    mockFetch(movie(null), episode(null))
    renderWanted()

    await screen.findByText('Your Name.')
    fireEvent.click(screen.getByText(/Episodios/))
    await screen.findByText('Of Ice Men')

    expect(screen.queryByText(/Pedida el/)).not.toBeInTheDocument()
    expect(document.querySelectorAll('.wanted-grabbed')).toHaveLength(0)
    expect(document.querySelector('.wanted-row.status-grabbed')).toBeNull()
  })
})

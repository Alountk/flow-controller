import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MissingContent } from '../components/MissingContent'

/**
 * The "descarga pedida" mark on the "Todas" cards.
 *
 * These cards come from `/api/wanted/all` and `/api/wanted/series/all`, a
 * different surface from Faltantes: a title with a file can still carry the
 * mark, because the question is "did I ask for this?". A series card is marked
 * by a grab of ANY of its episodes. With no mark the card shows NOTHING.
 */

// Noon UTC on 19 September 2026, so the local date is the same in any timezone.
const GRABBED_AT = Date.UTC(2026, 8, 19, 12, 0, 0) / 1000

function allMovie(grabbedAt: number | null) {
  return {
    id: 411,
    title: 'Your Name.',
    year: 2016,
    remotePoster: '',
    has_file: true,
    path_exists: true,
    monitored: true,
    grabbed_at: grabbedAt,
  }
}

function allSeries(grabbedAt: number | null) {
  return {
    id: 3,
    title: 'Some Show',
    year: 2006,
    remotePoster: '',
    has_file: false,
    path_exists: true,
    monitored: true,
    episode_count: 10,
    episode_file_count: 4,
    grabbed_at: grabbedAt,
  }
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function mockFetch(movieItem: unknown, seriesItem: unknown) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [seriesItem], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [movieItem], total: 1, page: 1, page_size: 50 })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Render directly on a "Todas" state; the filter lives in the URL hash. */
function renderTodas(hash: string) {
  window.location.hash = hash
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

describe('"Todas" "descarga pedida" mark', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the mark and the date on a grabbed movie card', async () => {
    mockFetch(allMovie(GRABBED_AT), allSeries(null))
    renderTodas('#/wanted?filter=all')

    await screen.findByText('Your Name.')
    expect(await screen.findByText(expectedLabel(GRABBED_AT))).toBeInTheDocument()
    expect(document.querySelector('.wanted-card.status-grabbed')).not.toBeNull()
  })

  it('shows nothing for an unmarked movie', async () => {
    mockFetch(allMovie(null), allSeries(null))
    renderTodas('#/wanted?filter=all')

    await screen.findByText('Your Name.')
    await waitFor(() => expect(document.querySelectorAll('.wanted-card').length).toBe(1))

    expect(screen.queryByText(/Pedida el/)).not.toBeInTheDocument()
    expect(document.querySelectorAll('.wanted-grabbed')).toHaveLength(0)
    expect(document.querySelector('.wanted-card.status-grabbed')).toBeNull()
  })

  it('shows the mark on a series card when one of its episodes was grabbed', async () => {
    mockFetch(allMovie(null), allSeries(GRABBED_AT))
    renderTodas('#/wanted?tab=episodes&seriesFilter=all')

    await screen.findByText('Some Show')
    expect(await screen.findByText(expectedLabel(GRABBED_AT))).toBeInTheDocument()
    expect(document.querySelector('.wanted-card.status-grabbed')).not.toBeNull()
  })

  it('shows nothing for an unmarked series', async () => {
    mockFetch(allMovie(null), allSeries(null))
    renderTodas('#/wanted?tab=episodes&seriesFilter=all')

    await screen.findByText('Some Show')
    await waitFor(() => expect(document.querySelectorAll('.wanted-card').length).toBe(1))

    expect(screen.queryByText(/Pedida el/)).not.toBeInTheDocument()
    expect(document.querySelectorAll('.wanted-grabbed')).toHaveLength(0)
    expect(document.querySelector('.wanted-card.status-grabbed')).toBeNull()
  })
})

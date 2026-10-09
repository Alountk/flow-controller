import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'
import { Series } from '../../pages/Series.tsx'

/**
 * Tests for the "En carpeta" folder navigator.
 *
 * The navigator mirrors what is on disk: a fresh download must be visible
 * without a manual reload, and directories and files alike belong in the
 * listing. These tests drive the real modal through the real queries, with
 * fetch stubbed at the network boundary, from the sections' Faltantes
 * sub-views — where the retired Faltantes page's rows live now (PR 7).
 */

const movie = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  overview: '',
  remotePoster: '',
  has_file: false,
  altTitles: [],
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
}

// The series list is what the navigator resolves each file's S##E## against.
const seriesEpisodes = [
  { id: 70, season_number: 3, episode_number: 7, title: 'Of Ice Men', air_date: '2006-11-27T00:00:00Z' },
  { id: 12, season_number: 1, episode_number: 2, title: 'Pilot', air_date: '2006-01-02T00:00:00Z' },
]

interface BrowseItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
}

const dir = (name: string): BrowseItem => ({
  name,
  path: `/mnt/storage/${name}`,
  is_dir: true,
  size: 0,
  modified: 0,
})

const file = (name: string, size = 1_500_000_000): BrowseItem => ({
  name,
  path: `/mnt/storage/${name}`,
  is_dir: false,
  size,
  modified: 0,
})

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/**
 * Stubs fetch for the endpoints the wanted listing and the modal need.
 *
 * `browse` may be a single listing or a sequence of listings; each call to
 * /api/files/browse serves the next one (the last repeats), so a test can
 * change what the folder reports between calls. `scan` is what
 * /api/wanted/scan answers, and the queue endpoint always accepts.
 */
function mockFetch(
  browse: BrowseItem[] | BrowseItem[][] = [],
  episodes: typeof seriesEpisodes = seriesEpisodes,
  scan: Record<string, unknown> = {},
) {
  const sequence: BrowseItem[][] = Array.isArray(browse[0])
    ? (browse as BrowseItem[][])
    : [browse as BrowseItem[]]
  let browseCalls = 0

  const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (/\/api\/wanted\/series\/\d+\/episodes/.test(url)) {
      return ok({ episodes })
    }
    // Each section opens on Biblioteca, which asks for the catalogue; these
    // tests drive Faltantes, so the catalogue answers empty.
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [], total: 0, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [], total: 0, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: {
          radarr: { items: [movie], total: 1 },
          sonarr: { items: [episode], total: 1 },
        },
        updated_at: 0,
      })
    }
    if (url.includes('/api/files/roots')) {
      return ok({ roots: [{ path: '/mnt/storage', name: 'storage' }] })
    }
    if (url.includes('/api/files/browse?')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      const items = sequence[Math.min(browseCalls, sequence.length - 1)]
      browseCalls += 1
      return ok({ ok: true, path, items })
    }
    if (url.includes('/api/wanted/scan')) {
      return ok(scan)
    }
    if (url.includes('/api/files/queue/add')) {
      return ok({ ok: true, detail: 'Agregado a la cola' })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** The section's Faltantes sub-view: where the missing listing lives now. */
function renderFaltantes(Component: typeof Peliculas | typeof Series) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
}

/** Opens the modal and points the volume selector at /mnt/storage. */
async function openScanModal() {
  renderFaltantes(Peliculas)
  await screen.findByText('Your Name.')
  fireEvent.click(screen.getByText('📁 En carpeta'))
  // The volume options come from /api/files/roots; selecting a root that is not
  // in the list yet would be a no-op, leaving the modal with no current path.
  await screen.findByRole('option', { name: 'storage' })
  const select = document.querySelector('.fm-volume-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: '/mnt/storage' } })
  await screen.findByText('/mnt/storage')
}

/** Opens the modal from the Series · Faltantes episode row (a specific episode). */
async function openScanModalForSeries() {
  renderFaltantes(Series)
  await screen.findByText('Of Ice Men')
  fireEvent.click(screen.getByTitle('Buscar en carpeta'))
  await screen.findByRole('option', { name: 'storage' })
  const select = document.querySelector('.fm-volume-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: '/mnt/storage' } })
  await screen.findByText('/mnt/storage')
}

/** How many browse listings the backend has been asked for. */
function browseCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes('/api/files/browse?'),
  ).length
}

describe('"En carpeta" navigator', () => {
  beforeEach(() => {
    // Tab and filters live in the URL hash, so each test starts clean.
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows files alongside folders in the navigator', async () => {
    mockFetch([
      dir('Some Folder'),
      file('Movie.2026.1080p.mkv'),
    ])
    await openScanModal()

    // The folder row carries the "📁 " icon, so match it as a substring; the
    // file name is its own text node and can be matched exactly.
    expect(await screen.findByText(/Some Folder/)).toBeInTheDocument()
    expect(screen.getByText('Movie.2026.1080p.mkv')).toBeInTheDocument()
  })

  it('shows a file size next to each file', async () => {
    mockFetch([file('Movie.2026.1080p.mkv', 1_500_000_000)])
    await openScanModal()

    expect(await screen.findByText('Movie.2026.1080p.mkv')).toBeInTheDocument()
    expect(screen.getByText('1.4 GB')).toBeInTheDocument()
  })

  it('asks the backend again when the refresh button is clicked', async () => {
    const fetchMock = mockFetch([
      [file('Before.2026.mkv')],
      [file('After.2026.mkv')],
    ])
    await openScanModal()
    expect(await screen.findByText('Before.2026.mkv')).toBeInTheDocument()

    const callsBefore = browseCallCount(fetchMock)
    fireEvent.click(screen.getByTitle('Refrescar listado'))

    expect(await screen.findByText('After.2026.mkv')).toBeInTheDocument()
    expect(browseCallCount(fetchMock)).toBeGreaterThan(callsBefore)
  })

  it('reports an empty folder', async () => {
    mockFetch([])
    await openScanModal()

    expect(await screen.findByText('Carpeta vacía')).toBeInTheDocument()
  })

  it('shows the episode a file name resolves to', async () => {
    mockFetch([file('Some.Show.S01E02.1080p.mkv')])
    await openScanModalForSeries()

    expect(await screen.findByText('Some.Show.S01E02.1080p.mkv')).toBeInTheDocument()
    // S01E02 is resolved against the series map, not guessed from the name.
    expect(await screen.findByText('S01E02 · Pilot · 2006-01-02')).toBeInTheDocument()
  })

  it('adds no episode line when the file name has no tag', async () => {
    mockFetch([file('Some.Show.1080p.mkv')])
    await openScanModalForSeries()

    expect(await screen.findByText('Some.Show.1080p.mkv')).toBeInTheDocument()
    expect(document.querySelectorAll('.scan-file-row-episode')).toHaveLength(0)
  })

  it('identifies the scanned episode in the modal header', async () => {
    mockFetch([file('Some.Show.1080p.mkv')])
    await openScanModalForSeries()

    // The header names the episode, not only the series.
    expect(document.querySelector('.scan-selected-info strong')).toHaveTextContent(
      'S03E07 · Of Ice Men · 2006-11-27',
    )
    // The series title stays visible alongside it.
    expect(document.querySelector('.scan-selected-series')).toHaveTextContent('Some Show')
  })

  it('queues a copy, not a move, so the download keeps seeding', async () => {
    const fetchMock = mockFetch([file('Your.Name.2016.1080p.mkv')], seriesEpisodes, {
      ok: true,
      detail: '1 coincidencia',
      scanned_files: 1,
      matches: [
        {
          file_path: '/mnt/storage/seed/Your.Name.2016.1080p.mkv',
          file_name: 'Your.Name.2016.1080p.mkv',
          movie_id: 411,
          movie_title: 'Your Name.',
          movie_year: 2016,
          target_path: '/mnt/storage/movies',
          score: 0.95,
          matched_title: 'Your Name.',
        },
      ],
    })
    await openScanModal()

    fireEvent.click(screen.getByText(/Buscar "Your Name\." en esta carpeta/))
    await screen.findByText(/coincidencia/i)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /Colocar 1 archivos en la cola/ }))

    // The whole point: `move` renames the download away and the hardlink the
    // seeder is sharing disappears with it, so the queue must get a copy.
    await screen.findByText(/archivos encolados/)
    const queued = fetchMock.mock.calls
      .filter(([input]) => String(input).includes('/api/files/queue/add'))
      .map(([, init]) => JSON.parse(String((init as RequestInit)?.body)))
    expect(queued).toHaveLength(1)
    expect(queued[0].source).toBe('copy')
    expect(queued[0].remote_path).toBe('/mnt/storage/seed/Your.Name.2016.1080p.mkv')
  })
})


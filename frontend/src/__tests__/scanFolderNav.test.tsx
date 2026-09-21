import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MissingContent } from '../components/MissingContent'

/**
 * Tests for the "En carpeta" folder navigator.
 *
 * The navigator mirrors what is on disk: a fresh download must be visible
 * without a manual reload, and directories and files alike belong in the
 * listing. These tests drive the real modal through the real queries, with
 * fetch stubbed at the network boundary.
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
 * change what the folder reports between calls.
 */
function mockFetch(
  browse: BrowseItem[] | BrowseItem[][] = [],
  episodes: typeof seriesEpisodes = seriesEpisodes,
) {
  const sequence: BrowseItem[][] = Array.isArray(browse[0])
    ? (browse as BrowseItem[][])
    : [browse as BrowseItem[]]
  let browseCalls = 0

  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (/\/api\/wanted\/series\/\d+\/episodes/.test(url)) {
      return ok({ episodes })
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

/** Opens the modal and points the volume selector at /mnt/storage. */
async function openScanModal() {
  renderWanted()
  await screen.findByText('Your Name.')
  fireEvent.click(screen.getByText('📁 En carpeta'))
  // The volume options come from /api/files/roots; selecting a root that is not
  // in the list yet would be a no-op, leaving the modal with no current path.
  await screen.findByRole('option', { name: 'storage' })
  const select = document.querySelector('.fm-volume-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: '/mnt/storage' } })
  await screen.findByText('/mnt/storage')
}

/** Opens the modal from the Faltantes episode row (a specific episode). */
async function openScanModalForSeries() {
  renderWanted()
  await screen.findByText('Your Name.')
  fireEvent.click(screen.getByText(/Episodios/))
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
})

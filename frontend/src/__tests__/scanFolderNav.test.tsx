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
function mockFetch(browse: BrowseItem[] | BrowseItem[][] = []) {
  const sequence: BrowseItem[][] = Array.isArray(browse[0])
    ? (browse as BrowseItem[][])
    : [browse as BrowseItem[]]
  let browseCalls = 0

  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr'] })
    }
    if (url.includes('/api/wanted?')) {
      return ok({ wanted: { radarr: { items: [movie], total: 1 } }, updated_at: 0 })
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

  it('asks the backend again when the refresh button is clicked', async () => {
    const fetchMock = mockFetch([[dir('Before Folder')], [dir('After Folder')]])
    await openScanModal()
    expect(await screen.findByText(/Before Folder/)).toBeInTheDocument()

    const callsBefore = browseCallCount(fetchMock)
    fireEvent.click(screen.getByTitle('Refrescar listado'))

    expect(await screen.findByText(/After Folder/)).toBeInTheDocument()
    expect(browseCallCount(fetchMock)).toBeGreaterThan(callsBefore)
  })
})

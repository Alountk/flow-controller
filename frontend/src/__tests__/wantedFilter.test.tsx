import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../components/Peliculas'
import { useDebouncedValue } from '../hooks/useDebouncedValue'

/**
 * Tests for the wanted-listing text filter, driven through Películas ·
 * Faltantes — the sub-view the retired Faltantes page became (PR 7 of F-08).
 *
 * This filter is SERVER-side on purpose. The listing is paginated (50 per page,
 * 1981 episodes), so filtering in the browser would only ever see the loaded
 * pages and would report "no results" while matches sat unloaded. The backend
 * pulls the whole list, filters, and paginates the matches.
 */

const movies = [
  { id: 411, title: 'Todo a la vez en todas partes', year: 2022, overview: '', remotePoster: '', has_file: false, altTitles: [] },
  { id: 813, title: 'Your Name.', year: 2016, overview: '', remotePoster: '', has_file: false, altTitles: [] },
]

function mockFetch() {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    // The section opens on Biblioteca, which asks for the catalogue; these
    // tests drive Faltantes, so the catalogue answers empty.
    if (url.includes('/api/wanted/all')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, page_size: 50 }),
      } as Response)
    }
    if (url.includes('/api/wanted?')) {
      const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
      const items = q
        ? movies.filter((m) => m.title.toLowerCase().includes(q.toLowerCase()))
        : movies
      return Promise.resolve({
        ok: true,
        json: async () => ({ wanted: { radarr: { items, total: items.length } }, updated_at: 0 }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
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

/** The section's Faltantes sub-view: where the missing listing lives now. */
function openFaltantes() {
  fireEvent.click(screen.getByRole('tab', { name: 'Faltantes' }))
}

const filterInput = () => screen.getByLabelText('Filtrar películas')

/** Titles currently rendered in the listing, in order — each row's name and
 *  year composed the way the page's title line used to read. */
const renderedTitles = () =>
  [...document.querySelectorAll('.sec-row')].map((row) => {
    const name = row.querySelector('.sec-row-name')?.textContent?.trim() ?? ''
    const year = row.querySelector('.sec-row-year')?.textContent?.trim()
    return year ? `${name} (${year})` : name
  })

/** Every q= value the backend was asked for. */
function requestedQueries(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes('/api/wanted?'))
    .map((url) => new URL(url, 'http://x').searchParams.get('q') ?? '')
}

describe('useDebouncedValue', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 50))

    expect(result.current).toBe('a')
  })

  it('delays updates until the delay elapses', async () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 40), {
      initialProps: { v: 'a' },
    })

    rerender({ v: 'b' })
    expect(result.current).toBe('a')

    await act(() => new Promise((r) => setTimeout(r, 80)))
    expect(result.current).toBe('b')
  })
})

describe('wanted listing text filter', () => {
  beforeEach(() => {
    // The pane's search text is persisted in the URL hash, so each test must
    // start from a clean location.
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the filter input next to the sub-view tabs that switch the list', async () => {
    mockFetch()
    renderSection()

    expect(await screen.findByLabelText('Filtrar películas')).toBeInTheDocument()
    // In the section the sub-view tabs are the filter: Biblioteca is the old
    // "Todas", Faltantes the old "Faltantes" button.
    expect(screen.getByRole('tab', { name: 'Faltantes' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Biblioteca' })).toBeInTheDocument()
  })

  it('starts unfiltered', async () => {
    const fetchMock = mockFetch()
    renderSection()
    openFaltantes()

    await screen.findByText('Your Name.')
    expect(requestedQueries(fetchMock).every((q) => q === '')).toBe(true)
  })

  it('sends the typed term to the backend', async () => {
    const fetchMock = mockFetch()
    renderSection()
    openFaltantes()
    await screen.findByText('Your Name.')

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    await waitFor(() => expect(requestedQueries(fetchMock)).toContain('Todo'))
  })

  it('shows only the matching items', async () => {
    mockFetch()
    renderSection()
    openFaltantes()
    await screen.findByText('Your Name.')

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    // Assert on the whole list: waiting for the expected title alone would pass
    // immediately, since it is already present before filtering.
    await waitFor(() =>
      expect(renderedTitles()).toEqual(['Todo a la vez en todas partes (2022)']),
    )
  })

  it('reports an empty state when nothing matches', async () => {
    mockFetch()
    renderSection()
    openFaltantes()
    await screen.findByText('Your Name.')

    fireEvent.change(filterInput(), { target: { value: 'zzzzz' } })

    // Wait for the empty state itself: asserting the list is empty would pass
    // while the filtered query is still loading.
    await waitFor(() =>
      expect(screen.getByText('No hay películas faltantes')).toBeInTheDocument(),
    )
    expect(renderedTitles()).toEqual([])
  })

  it('debounces so typing does not fire a request per keystroke', async () => {
    const fetchMock = mockFetch()
    renderSection()
    openFaltantes()
    await screen.findByText('Your Name.')

    const before = requestedQueries(fetchMock).length
    for (const value of ['T', 'To', 'Tod', 'Todo']) {
      fireEvent.change(filterInput(), { target: { value } })
    }

    await waitFor(() => expect(requestedQueries(fetchMock)).toContain('Todo'))

    const after = requestedQueries(fetchMock).slice(before)
    expect(after).not.toContain('T')
    expect(after).not.toContain('To')
    expect(after.filter((q) => q === 'Todo')).toHaveLength(1)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * Wiring-level tests for the release filter bar.
 *
 * The pure logic is covered in releaseFilters.test.ts. What these guard is the
 * integration: that the modal actually feeds the FILTERED list to the counter
 * and the rendering. Getting that wrong is exactly how a filter silently acts
 * on rows the user cannot see.
 */

function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    guid: 'en-1',
    title: 'Everything Everywhere All at Once 2022 1080p BluRay',
    size: 10_000_000_000,
    quality: 'Bluray-1080p',
    indexer: 'aMuTorrent',
    indexerId: 1,
    indexerFlags: '',
    seeders: 10,
    leechers: 1,
    protocol: 'torrent',
    releaseGroup: '',
    languages: ['English'],
    ...overrides,
  }
}

const releases: Release[] = [
  makeRelease({ guid: 'en-1' }),
  makeRelease({
    guid: 'es-1',
    title: 'Todo a la vez en todas partes 2022 1080p',
    quality: 'WEBDL-1080p',
    languages: ['Spanish'],
  }),
]

const indexers = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

interface MockOptions {
  /** The routing-folders read (GET /api/settings) fails outright. */
  routingFail?: boolean
  /** Overrides the configured 4K folder; '' means "not configured". */
  path4k?: string
  /** Replace the canned results, for the cases that need a different mix. */
  releases?: Release[]
}

function mockFetch(options: MockOptions = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => indexers } as Response)
    }
    if (url.includes('/api/settings')) {
      if (options.routingFail) {
        return Promise.reject(new Error('settings unavailable'))
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          paths: { path_4k: options.path4k ?? '/mnt/storage-6tb/4k', path_3d: '/mnt/storage/6tb/3d' },
        }),
      } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      const rows = options.releases ?? releases
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases: rows, detail: `${rows.length} releases encontrados` }),
      } as Response)
    }
    if (url.includes('/api/calendar/grab')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, detail: 'Descarga iniciada', downloaded: [], errors: [] }),
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof mockFetch>

/** Every grab request body the modal has sent, in order. */
function grabBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes('/api/calendar/grab'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

/** Press one of the row's three destination buttons (F-12), row 0 by default. */
function pressDest(target: 'Biblioteca' | '4K' | '3D', row = 0) {
  const rowEl = document.querySelectorAll('.release-dest')[row] as HTMLElement
  const name = target === 'Biblioteca' ? /Biblioteca/ : target === '4K' ? /4K/ : /3D/
  fireEvent.click(within(rowEl).getByRole('button', { name }))
}

// The modal reads the indexer list through react-query, so it needs a client.
function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 411, title: 'Everything Everywhere All at Once', source: 'radarr' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

async function openResults() {
  renderModal()

  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

  await waitFor(() => expect(screen.getByPlaceholderText('Filtrar por título...')).toBeInTheDocument())
}

const filterInput = () => screen.getByPlaceholderText('Filtrar por título...')

/**
 * Scope queries to the releases region: the modal header also renders the item
 * title, so a document-wide text query would match the header too.
 */
const releasesRegion = () => document.querySelector('.calendar-releases') as HTMLElement

const releaseTitles = () =>
  [...document.querySelectorAll('.release-title')].map((el) => el.textContent ?? '')

describe('ReleaseSearchModal filter bar', () => {
  beforeEach(() => {
    mockFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows every release and the plain counter before filtering', async () => {
    await openResults()

    expect(screen.getByText('2 releases encontrados')).toBeInTheDocument()
    expect(releaseTitles()).toHaveLength(2)
    expect(within(releasesRegion()).getByText(/Todo a la vez/)).toBeInTheDocument()
  })

  it('shows "visible de total" once a filter narrows the list', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    expect(screen.getByText('1 de 2 releases')).toBeInTheDocument()
  })

  it('hides the non-matching release', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    expect(releaseTitles()).toEqual(['Todo a la vez en todas partes 2022 1080p'])
  })

  it('reports an empty state when nothing matches', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'zzzzz' } })

    expect(screen.getByText('Ningún release coincide con los filtros')).toBeInTheDocument()
    expect(releaseTitles()).toHaveLength(0)
  })

  it('offers a chip per quality and per language present in the results', async () => {
    await openResults()

    expect(screen.getByRole('button', { name: 'Bluray-1080p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'WEBDL-1080p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spanish' })).toBeInTheDocument()
  })

  it('filters by a language chip', async () => {
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: 'Spanish' }))

    expect(screen.getByText('1 de 2 releases')).toBeInTheDocument()
    expect(releaseTitles()).toEqual(['Todo a la vez en todas partes 2022 1080p'])
  })

  it('filters by a quality chip', async () => {
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: 'Bluray-1080p' }))

    expect(releaseTitles()).toEqual(['Everything Everywhere All at Once 2022 1080p BluRay'])
  })

  it('filters by minimum seeders', async () => {
    await openResults()

    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50' } })

    expect(screen.getByText('Ningún release coincide con los filtros')).toBeInTheDocument()
  })

  it('clears every filter at once', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })
    expect(screen.getByText('1 de 2 releases')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Limpiar filtros/ }))

    expect(screen.getByText('2 releases encontrados')).toBeInTheDocument()
    expect((filterInput() as HTMLInputElement).value).toBe('')
  })

  it('does not render empty indexer groups after filtering', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    const groups = document.querySelectorAll('.calendar-indexer-group')
    expect(groups).toHaveLength(1)
    expect(within(groups[0] as HTMLElement).getByText(/Todo a la vez/)).toBeInTheDocument()
  })})

/**
 * The three per-row destination buttons (F-12). The combo is gone: the
 * destination is chosen WHERE you click, so no selection state leaks into the
 * next grab — the bug where "anulación manual" survived its own grab dies
 * with it. "→ Biblioteca" is an explicit flag: without it the backend would
 * DERIVE a 2160p release to path_4k and quietly override the operator.
 */
describe('ReleaseSearchModal per-row destination buttons', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers the three destinations and highlights the one the rules pick', async () => {
    mockFetch({
      releases: [
        makeRelease({ guid: '4k-1', quality: 'Bluray-2160p' }),
        makeRelease({ guid: 'hd-1', title: 'Plain Movie 2022 1080p BluRay', quality: 'Bluray-1080p' }),
      ],
    })
    await openResults()

    const row = document.querySelectorAll('.release-dest')[0] as HTMLElement
    // The folders arrive with the settings read: enabled means they answered.
    await waitFor(() => expect(within(row).getByRole('button', { name: /4K/ })).toBeEnabled())
    expect(within(row).getByRole('button', { name: /Biblioteca/ })).toBeEnabled()
    expect(within(row).getByRole('button', { name: /3D/ })).toBeEnabled()
    // 2160p + a configured folder: the routing rules say → 4K, and the row says so.
    expect(within(row).getByRole('button', { name: /4K/ })).toHaveClass('suggest')
    // …and a plain 1080p row suggests the library.
    const plain = document.querySelectorAll('.release-dest')[1] as HTMLElement
    expect(within(plain).getByRole('button', { name: /Biblioteca/ })).toHaveClass('suggest')
  })

  it('the library button sends no destination and says so explicitly', async () => {
    const fn = mockFetch()
    await openResults()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    const body = grabBodies(fn)[0]
    expect(body).not.toHaveProperty('destination')
    expect(body.library).toBe(true)
    expect(body.quality).toBe('Bluray-1080p')
  })

  it('the 4K button sends the configured folder', async () => {
    const fn = mockFetch()
    await openResults()

    await waitFor(() =>
      expect(
        within(document.querySelectorAll('.release-dest')[0] as HTMLElement).getByRole('button', { name: /4K/ }),
      ).toBeEnabled(),
    )
    pressDest('4K')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].destination).toBe('/mnt/storage-6tb/4k')
    expect(grabBodies(fn)[0]).not.toHaveProperty('library')
  })

  it('the 3D button sends the 3D folder and forces the flag', async () => {
    const fn = mockFetch()
    await openResults()

    await waitFor(() =>
      expect(
        within(document.querySelectorAll('.release-dest')[0] as HTMLElement).getByRole('button', { name: /3D/ }),
      ).toBeEnabled(),
    )
    pressDest('3D')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    const body = grabBodies(fn)[0]
    expect(body.destination).toBe('/mnt/storage/6tb/3d')
    expect(body.is3d).toBe(true)
  })

  it('an unconfigured 4K folder disables its button instead of lying', async () => {
    mockFetch({ path4k: '' })
    await openResults()

    const row = document.querySelectorAll('.release-dest')[0] as HTMLElement
    expect(within(row).getByRole('button', { name: /4K/ })).toBeDisabled()
    expect(within(row).getByRole('button', { name: /Biblioteca/ })).toBeEnabled()
  })

  it('a failed settings read still allows the library grab', async () => {
    const fn = mockFetch({ routingFail: true })
    await openResults()

    const row = document.querySelectorAll('.release-dest')[0] as HTMLElement
    expect(within(row).getByRole('button', { name: /4K/ })).toBeDisabled()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].library).toBe(true)
  })
})

/**
 * The release's quality class is what routes it to its own folder when nobody
 * picked a destination by hand. What is asserted here is only the wire — the
 * server owns the actual mapping — and the one case where claiming a class
 * would be a lie: a batch holding more than one.
 */
describe('ReleaseSearchModal quality routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the release quality on a single grab', async () => {
    const fn = mockFetch({ releases: [makeRelease({ guid: '4k-1', quality: 'Bluray-2160p' })] })
    await openResults()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].quality).toBe('Bluray-2160p')
  })

})

/**
 * The 3D suggestion and the hand correction that outranks it.
 *
 * `looksThreeD` itself is pinned in threeD.test.ts. What these own is the
 * wiring: that the row's answer — not the heuristic's — is what reaches the
 * grab, in both directions, and that a batch does not carry two answers at
 * once.
 */
describe('ReleaseSearchModal 3D routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const suggested = makeRelease({
    guid: 'sug-1',
    title: 'Película 2020 3D HSBS 1080p BluRay',
    quality: 'Bluray-1080p',
  })
  const plain = makeRelease({
    guid: 'plain-1',
    title: 'Otra Película 2022 1080p BluRay',
    quality: 'Bluray-1080p',
  })

  it('sends is3d when the title suggests it', async () => {
    const fn = mockFetch({ releases: [suggested] })
    await openResults()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].is3d).toBe(true)
  })

  it('sends nothing when the title suggests nothing', async () => {
    const fn = mockFetch({ releases: [plain] })
    await openResults()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0]).not.toHaveProperty('is3d')
  })

  it('lets the operator overrule the suggestion', async () => {
    const fn = mockFetch({ releases: [suggested] })
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: /Quitar la marca 3D/ }))
    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    // What the title said is a hint; what the operator says is the answer.
    expect(grabBodies(fn)[0]).not.toHaveProperty('is3d')
  })

  it('lets the operator correct a title the heuristic missed', async () => {
    const fn = mockFetch({ releases: [plain] })
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: /Marcar .* como 3D/ }))
    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].is3d).toBe(true)
  })

})

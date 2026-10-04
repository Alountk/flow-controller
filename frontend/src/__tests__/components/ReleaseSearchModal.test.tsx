import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { ReleaseSearchModal } from '../../components/ReleaseSearchModal'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Release } from '../../api/calendar'

/**
 * Wiring-level tests for the release filter bar.
 *
 * The pure logic is covered in releaseFilters.test.ts. What these guard is the
 * integration: that the modal actually feeds the FILTERED list to the counter,
 * the select-all control and the rendering. Getting that wrong is exactly how a
 * filter silently acts on rows the user cannot see.
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

const destinationFolders = {
  folders: ['/mnt/storage/movies/_manual'],
  arr_available: true,
  detail: '',
}

interface MockOptions {
  destinationsFail?: boolean
  /** Replace the canned results, for the cases that need a different mix. */
  releases?: Release[]
}

function mockFetch(options: MockOptions = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => indexers } as Response)
    }
    if (url.includes('/api/calendar/destinations')) {
      if (options.destinationsFail) {
        return Promise.reject(new Error('destinations unavailable'))
      }
      return Promise.resolve({ ok: true, json: async () => destinationFolders } as Response)
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

  it('select-all marks only the filtered releases', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    const selectAll = screen.getByRole('checkbox', { name: /1 de 2 releases/ })
    fireEvent.click(selectAll)

    // The batch button counts only what was visible.
    expect(screen.getByRole('button', { name: /Descargar \(1\)/ })).toBeInTheDocument()
  })

  it('does not render empty indexer groups after filtering', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    const groups = document.querySelectorAll('.calendar-indexer-group')
    expect(groups).toHaveLength(1)
    expect(within(groups[0] as HTMLElement).getByText(/Todo a la vez/)).toBeInTheDocument()
  })})

/**
 * The destination combo. Its default is the arr's library, which must reach the
 * grab endpoints as NO `destination` field at all — absent is what "library"
 * means end to end. A chosen folder applies to the marked rows.
 */
describe('ReleaseSearchModal destination combo', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to the library and sends no destination on a single grab', async () => {
    const fn = mockFetch()
    await openResults()

    expect(await screen.findByRole('combobox', { name: /Destino/ })).toHaveValue('')

    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0]).not.toHaveProperty('destination')
  })

  it('sends the chosen folder with a batch grab', async () => {
    const fn = mockFetch()
    await openResults()

    await screen.findByRole('option', { name: '/mnt/storage/movies/_manual' })
    fireEvent.change(screen.getByRole('combobox', { name: /Destino/ }), {
      target: { value: '/mnt/storage/movies/_manual' },
    })

    fireEvent.click(document.querySelector('.release-checkbox input') as HTMLInputElement)
    fireEvent.click(screen.getByRole('button', { name: /Descargar \(1\)/ }))

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].destination).toBe('/mnt/storage/movies/_manual')
  })

  it('still grabs when the destination options fail to load', async () => {
    const fn = mockFetch({ destinationsFail: true })
    await openResults()

    // The library default stays available even though the options load failed.
    expect(await screen.findByRole('combobox', { name: /Destino/ })).toHaveValue('')
    expect(screen.queryByRole('option', { name: '/mnt/storage/movies/_manual' })).toBeNull()

    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0]).not.toHaveProperty('destination')
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

    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].quality).toBe('Bluray-2160p')
  })

  it('sends the shared quality as one call when every release has it', async () => {
    const fn = mockFetch({
      releases: [
        makeRelease({ guid: 'a', quality: 'Bluray-2160p' }),
        makeRelease({ guid: 'b', quality: 'Bluray-2160p', title: 'Other 2022 2160p' }),
      ],
    })
    await openResults()

    for (const box of document.querySelectorAll<HTMLInputElement>('.release-checkbox input')) {
      fireEvent.click(box)
    }
    fireEvent.click(screen.getByRole('button', { name: /Descargar \(2\)/ }))

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].quality).toBe('Bluray-2160p')
    expect(grabBodies(fn)[0].guids).toEqual(['a', 'b'])
  })

  it('splits a mixed batch so each class keeps its own quality', async () => {
    const fn = mockFetch({
      releases: [
        makeRelease({ guid: 'a', quality: 'Bluray-2160p' }),
        makeRelease({ guid: 'b', quality: 'WEBDL-1080p', title: 'Other 2022 1080p' }),
      ],
    })
    await openResults()

    for (const box of document.querySelectorAll<HTMLInputElement>('.release-checkbox input')) {
      fireEvent.click(box)
    }
    fireEvent.click(screen.getByRole('button', { name: /Descargar \(2\)/ }))

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(2))

    // `grab-batch` carries ONE quality, so two classes need two calls. Merging
    // them would either drop the 4K in the library — where Radarr may import it
    // and REPLACE the 1080p, the exact coexistence failure this feature exists
    // to avoid — or ship a quality that does not describe half the batch.
    const byQuality = Object.fromEntries(
      grabBodies(fn).map((b) => [b.quality as string, b.guids as string[]]),
    )
    expect(byQuality).toEqual({ 'Bluray-2160p': ['a'], 'WEBDL-1080p': ['b'] })
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

    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].is3d).toBe(true)
  })

  it('sends nothing when the title suggests nothing', async () => {
    const fn = mockFetch({ releases: [plain] })
    await openResults()

    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0]).not.toHaveProperty('is3d')
  })

  it('lets the operator overrule the suggestion', async () => {
    const fn = mockFetch({ releases: [suggested] })
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: /Quitar la marca 3D/ }))
    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    // What the title said is a hint; what the operator says is the answer.
    expect(grabBodies(fn)[0]).not.toHaveProperty('is3d')
  })

  it('lets the operator correct a title the heuristic missed', async () => {
    const fn = mockFetch({ releases: [plain] })
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: /Marcar .* como 3D/ }))
    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].is3d).toBe(true)
  })

  it('splits a batch so the 3D row never travels with the rest', async () => {
    const fn = mockFetch({ releases: [suggested, plain] })
    await openResults()

    for (const box of document.querySelectorAll<HTMLInputElement>('.release-checkbox input')) {
      fireEvent.click(box)
    }
    fireEvent.click(screen.getByRole('button', { name: /Descargar \(2\)/ }))

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(2))

    // Same quality, different folder: one `is3d` per call cannot describe both.
    const routed3d = grabBodies(fn).filter((b) => b.is3d === true)
    expect(routed3d).toHaveLength(1)
    expect(routed3d[0].guids).toEqual(['sug-1'])
    const routedFlat = grabBodies(fn).filter((b) => b.is3d !== true)
    expect(routedFlat).toHaveLength(1)
    expect(routedFlat[0].guids).toEqual(['plain-1'])
  })
})

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

/** A direct-source release row, exactly as `POST /api/calendar/releases`
 *  serves it (S5): never the arr era's quality/languages/indexerId. */
function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    guid: 'en-1',
    title: 'Everything Everywhere All at Once 2022 1080p BluRay',
    size: 10_000_000_000,
    indexer: 'aMuTorrent',
    source: 'torznab',
    link: 'https://idx.test/download/en-1.torrent',
    seeders: 10,
    ...overrides,
  }
}

const releases: Release[] = [
  makeRelease({ guid: 'en-1' }),
  makeRelease({
    guid: 'es-1',
    title: 'Todo a la vez en todas partes 2022 1080p',
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
      // async-grab: the POST starts the job; the status GET settles it.
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, task_id: 'grab-1', status: 'running', detail: 'Descarga lanzada' }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, id: 'grab-1', status: 'done', detail: 'Descarga iniciada' }),
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof mockFetch>

/** Every grab request body the modal has sent, in order. Status GETs carry
 *  no body, so only the POSTs are counted. */
function grabBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(
      ([input, init]) =>
        String(input).includes('/api/calendar/grab') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
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

  it('offers no quality or language chips when the rows carry none (S5)', async () => {
    await openResults()

    // Direct rows never carry quality/languages: the chip groups must not
    // render at all, and an absent value must never surface as text.
    expect(screen.queryByText('Calidad')).toBeNull()
    expect(screen.queryByText('Idioma')).toBeNull()
    expect(within(releasesRegion()).queryByText('undefined')).toBeNull()
  })

  it('a row without seeders is unknown, not zero: it survives the seeders floor', async () => {
    mockFetch({ releases: [makeRelease({ guid: 'no-seed', seeders: undefined })] })
    await openResults()

    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50' } })

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
  })

  it('binds the seeders floor label to its input with htmlFor/id/name (S2)', async () => {
    await openResults()

    const input = screen.getByPlaceholderText('0') as HTMLInputElement
    const label = input.closest('label') as HTMLLabelElement
    expect(label).not.toBeNull()
    expect(label.getAttribute('for')).toBe(input.id)
    expect(input.id).toBe('release-filter-seeders')
    expect(input.name).toBe('release-filter-seeders')
  })
})

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
        makeRelease({ guid: '3d-1', title: 'Película 2020 3D HSBS 1080p BluRay' }),
        makeRelease({ guid: 'hd-1', title: 'Plain Movie 2022 1080p BluRay' }),
      ],
    })
    await openResults()

    // One destination block per row (migrated from alternativeMode.test.tsx).
    expect(document.querySelectorAll('.release-dest')).toHaveLength(2)
    const row = document.querySelectorAll('.release-dest')[0] as HTMLElement
    // The folders arrive with the settings read: enabled means they answered.
    await waitFor(() => expect(within(row).getByRole('button', { name: /4K/ })).toBeEnabled())
    expect(within(row).getByRole('button', { name: /Biblioteca/ })).toBeEnabled()
    expect(within(row).getByRole('button', { name: /3D/ })).toBeEnabled()
    // A 3D title + the configured folder: the rules say → 3D, and the row
    // says so (S5 rows carry no quality class to route by).
    expect(within(row).getByRole('button', { name: /3D/ })).toHaveClass('suggest')
    // …and a row with no class to claim suggests the library.
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
    // Migrated from alternativeMode.test.tsx: a routed grab is never a
    // library grab — `library` and `destination` are exclusive flags.
    expect(body).not.toHaveProperty('library')
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
 * What the grab body may claim. The release quality used to ride the wire so
 * the server could route by it; a direct row never carries one (S5), and the
 * body must say so by omission rather than invent a class.
 */
describe('ReleaseSearchModal grab body honesty', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a direct row has no quality: the body never invents one', async () => {
    const fn = mockFetch({ releases: [makeRelease({ guid: 'no-q-1' })] })
    await openResults()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0]).not.toHaveProperty('quality')
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
  })
  const plain = makeRelease({
    guid: 'plain-1',
    title: 'Otra Película 2022 1080p BluRay',
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

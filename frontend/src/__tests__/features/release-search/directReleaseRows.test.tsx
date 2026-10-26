import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * S5 (calendario-directo): `ReleaseSearchModal` renders the rows our own
 * sources return (`_release_row` in backend/routes/calendar.py) — exactly
 * `{title, guid, link, size, indexer, source, seeders?}`. Chips exist ONLY
 * for fields the row really has: absent quality/languages/seeders means no
 * chip and never the string "undefined", while size and present seeders DO
 * render. The grab payload carries `link` when the row has one (falling back
 * to `guid`) and `indexerId` 0 when the row has none.
 */

/** A Torznab row: full link, stated seeders, no arr fields at all. */
const torznabRow: Release = {
  title: 'Película 2020 1080p BluRay',
  guid: 'https://idx.test/details/tl-1',
  link: 'https://idx.test/download/tl-1.torrent',
  size: 4_294_967_296,
  indexer: 'TorrentLeech',
  source: 'torznab',
  seeders: 12,
}

/** An aMule row: no link, no seeders — its indexer label IS the source. */
const amuleRow: Release = {
  title: 'Otra Película 2021',
  guid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  link: '',
  size: 734_003_200,
  indexer: 'amule',
  source: 'amule',
}

/** A row whose source gave no indexer label at all: the source names it. */
const prowlarrRow: Release = {
  title: 'Tercera Película 2022',
  guid: 'https://idx.test/details/pr-3',
  link: 'https://idx.test/download/pr-3.nzb',
  size: 7_500_000_000,
  indexer: '',
  source: 'prowlarr',
}

const INDEXERS = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

function mockFetch(rows: Release[]) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => INDEXERS } as Response)
    }
    if (url.includes('/api/settings')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          paths: { path_4k: '/mnt/storage-6tb/4k', path_3d: '/mnt/storage-6tb/3d' },
        }),
      } as Response)
    }
    if (url.includes('/api/calendar/grab')) {
      // async-grab: the POST starts the job; the status GET settles it.
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            task_id: 'grab-1',
            status: 'running',
            detail: 'Descarga lanzada',
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, id: 'grab-1', status: 'done', detail: 'Descarga iniciada' }),
      } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases: rows, detail: `${rows.length} releases` }),
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof mockFetch>

/** The search POST bodies the modal sent to `/api/calendar/releases`. */
function searchBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(
      ([input, init]) =>
        String(input).includes('/api/calendar/releases') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

/** Every grab POST body the modal sent, in order. */
function grabBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(
      ([input, init]) =>
        String(input).includes('/api/calendar/grab') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{
          type: 'movie',
          id: 411,
          title: 'Everything Everywhere All at Once',
          source: 'radarr',
        }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

/** The panel keeps its indexer select on the results (the overlay's is gone
 *  by then), so the select/filter flow is a panel scenario. */
function renderPanelModal(id: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{
          type: 'movie',
          id,
          title: 'Everything Everywhere All at Once',
          source: 'radarr',
          has_file: false,
        }}
        presentation="panel"
      />
    </QueryClientProvider>,
  )
}

async function openResults() {
  const view = renderModal()
  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
  await waitFor(() => expect(document.querySelector('.calendar-releases')).not.toBeNull())
  return view
}

const rows = () => [...document.querySelectorAll('.calendar-release')]
const groupNames = () =>
  [...document.querySelectorAll('.calendar-indexer-name')].map((el) => el.textContent ?? '')

/** Press one row's destination button (F-12), scoped to that row's block. */
function pressDest(target: 'Biblioteca' | '4K' | '3D', row = 0) {
  const rowEl = document.querySelectorAll('.release-dest')[row] as HTMLElement
  const name = target === 'Biblioteca' ? /Biblioteca/ : target === '4K' ? /4K/ : /3D/
  fireEvent.click(within(rowEl).getByRole('button', { name }))
}

describe('ReleaseSearchModal renders direct-source rows (S5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders only the fields a direct row really has — no invented chips, no undefined', async () => {
    mockFetch([torznabRow, amuleRow])
    const { container } = await openResults()

    // Absent quality/languages/seeders = NO chip. The string "undefined"
    // must not appear anywhere in what the modal rendered.
    expect(document.querySelectorAll('.release-quality')).toHaveLength(0)
    expect(document.querySelectorAll('.release-lang')).toHaveLength(0)
    expect(container.textContent).not.toContain('undefined')

    // …while the facts the rows DO carry render: size always, seeders only
    // when the source stated one.
    const rendered = rows()
    expect(rendered).toHaveLength(2)
    expect(within(rendered[0] as HTMLElement).getByText('4.0 GB')).toBeInTheDocument()
    expect(
      rendered[0]!.querySelector('.release-seeders')?.textContent,
    ).toBe('⬆ 12')
    expect(rendered[1]!.querySelector('.release-seeders')).toBeNull()
    expect(within(rendered[1] as HTMLElement).getByText('700.0 MB')).toBeInTheDocument()
  })

  it('groups rows under the indexer label, falling back to the source', async () => {
    mockFetch([torznabRow, amuleRow, prowlarrRow])
    await openResults()

    // The header is the indexer's own label; when the label IS the source
    // (aMule) or the source gave none, the source names the group.
    expect(groupNames()).toEqual(['🌐 TorrentLeech', '🌐 amule', '🌐 prowlarr'])
  })

  it('the search call carries the item title', async () => {
    const fn = mockFetch([torznabRow])
    await openResults()

    await waitFor(() => expect(searchBodies(fn)).toHaveLength(1))
    const body = searchBodies(fn)[0]
    expect(body).toMatchObject({
      source: 'radarr',
      type: 'movie',
      id: 411,
      title: 'Everything Everywhere All at Once',
    })
  })
})

describe('ReleaseSearchModal grab payload on direct rows (S5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the row link and indexerId 0 when the row carries no indexerId', async () => {
    const fn = mockFetch([torznabRow])
    await openResults()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    const body = grabBodies(fn)[0]
    expect(body.link).toBe('https://idx.test/download/tl-1.torrent')
    expect(body.guid).toBe('https://idx.test/details/tl-1')
    expect(body.indexerId).toBe(0)
  })

  it('falls back to the guid when the row has no link, and sends indexerId 0', async () => {
    const fn = mockFetch([amuleRow])
    await openResults()

    pressDest('Biblioteca')

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    const body = grabBodies(fn)[0]
    expect(body).not.toHaveProperty('link')
    expect(body.guid).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(body.indexerId).toBe(0)
  })
})

describe('ReleaseSearchModal indexer select on direct rows (S5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers the rows own labels as options and filters with them', async () => {
    mockFetch([torznabRow, amuleRow])
    renderPanelModal(777)
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await waitFor(() => expect(document.querySelector('.calendar-releases')).not.toBeNull())
    expect(rows()).toHaveLength(2)

    // The options ARE the labels the groups below print — the row's indexer,
    // else its source. An arr-derived list can never match these rows.
    const select = within(
      document.querySelector('.calendar-indexer-select') as HTMLElement,
    ).getByRole('combobox') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Todos los indexadores',
      'TorrentLeech',
      'amule',
    ])

    // Selecting a label keeps only its group…
    fireEvent.change(select, { target: { value: 'amule' } })
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(
      within(rows()[0] as HTMLElement).getByText('Otra Película 2021'),
    ).toBeInTheDocument()

    // …and Todos deselects the filter, bringing every row back.
    fireEvent.change(select, { target: { value: 'all' } })
    await waitFor(() => expect(rows()).toHaveLength(2))
  })
})

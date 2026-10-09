import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type ReactElement } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal, type ReleaseSearchItem } from '../../../features/release-search/ReleaseSearchModal.tsx'
import { Peliculas } from '../../../pages/Peliculas.tsx'
import { Series } from '../../../pages/Series.tsx'

/**
 * The has-file tags fed by THREE sources (the "ya está en 4K y en 1080p"
 * requirement): the arr's library (`item.quality`), this app's own grabs
 * (GET /api/grabs — its `quality` and its `destination`), and the routing
 * folders on disk (GET /api/files/browse — an entry whose name starts with
 * this title's folder name is a copy of it).
 *
 * What is pinned here is the contract, not the plumbing:
 * - a tag lights when ANY source PROVES the class, grey when none can;
 * - "unknown" (a failed read, an unconfigured folder) never masquerades as
 *   "absent" — the tags do not grey DOWN and `Comprobación parcial` says why;
 * - the request economy: one grabs call per selection, two browse calls per
 *   session (keyed by folder), none at all for an item with no file.
 */

function makeItem(overrides: Partial<ReleaseSearchItem> = {}): ReleaseSearchItem {
  return {
    type: 'movie',
    id: 711,
    title: 'ParaNorman',
    year: 2012,
    source: 'radarr',
    has_file: true,
    file_name: 'ParaNorman.2012.1080p.BluRay.x264.mkv',
    languages: ['Spanish'],
    quality: 'Bluray-1080p',
    path: '/peliculas/ParaNorman (2012)',
    ...overrides,
  }
}

interface GrabsBody {
  grabs: { quality: string | null; destination: string | null; grabbed_at: number | null }[]
}

interface StubOpts {
  /** `null` makes GET /api/settings itself fail (500). */
  paths?: { path_4k?: string; path_3d?: string } | null
  /** The /api/grabs body; `'error'` makes the endpoint answer HTTP 500, and
   *  a function answers per URL so a test can serve DIFFERENT grabs to
   *  different id kinds — the false-positive pin needs exactly that. */
  grabs?: GrabsBody | 'error' | ((url: string) => GrabsBody)
  /** Per-folder /api/files/browse bodies, by folder path. A folder mapped to
   *  'error' answers HTTP 500; an unlisted folder answers an empty listing. */
  listings?: Record<string, { ok?: boolean; items?: { name: string }[] } | 'error'>
}

/** The rows the section-level card tests select: one of each surface whose
 *  release builder feeds the panel — Biblioteca (catalog*), Calidad
 *  (calidad*) and Estrenos (estreno*). All carry a file so the panel meets
 *  the has-file block (which is the only place the grabs query fires). */
const catalogSeriesCard = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: true,
  path: '/series/Some Show',
  path_exists: true,
  monitored: true,
  episode_count: 10,
  episode_file_count: 4,
}
const catalogMovieCard = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: '',
  has_file: true,
  path: '/peliculas/Your Name. (2016)',
  path_exists: true,
  monitored: true,
  quality: 'WEBDL-1080p',
}
const estrenoEpisodeCard = {
  type: 'episode',
  id: 42,
  title: 'Estreno de Episodio',
  date: '2026-10-06',
  year: null,
  has_file: true,
  remotePoster: '',
  series_title: 'Some Show',
  season_number: 1,
  episode_number: 2,
  source: 'sonarr',
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown, status = 200) {
  return Promise.resolve({ ok: status === 200, status, json: async () => body } as Response)
}

function stubFetch(opts: StubOpts = {}) {
  const paths = 'paths' in opts ? opts.paths : { path_4k: '/mnt/4k', path_3d: '/mnt/3d' }
  const grabs = opts.grabs ?? { grabs: [] }
  const listings = opts.listings ?? {}
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/calendar?')) {
      return ok({ items: [estrenoEpisodeCard], start: '2026-10-01', end: '2026-11-01' })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [catalogSeriesCard], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [catalogMovieCard], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [], total: 0 } },
        updated_at: 0,
      })
    }
    if (url.includes('/api/calendar/indexers')) {
      return ok({ indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }] })
    }
    if (url.includes('/api/calendar/destinations')) {
      return ok({ folders: ['/mnt/peliculas'], arr_available: true, detail: '' })
    }
    if (url.includes('/api/calendar/releases')) {
      return ok({
        releases: [
          {
            guid: 'rel-1',
            title: 'ParaNorman.2012.1080p.BluRay.x264',
            size: 8_000_000_000,
            quality: 'Bluray-1080p',
            indexer: 'aMuTorrent',
            indexerId: 1,
            indexerFlags: '',
            seeders: 15,
            leechers: 2,
            protocol: 'torrent',
            releaseGroup: '',
            languages: ['Spanish'],
          },
        ],
        detail: '1 releases encontrados',
      })
    }
    if (url.includes('/api/grabs')) {
      if (grabs === 'error') return ok({ detail: 'boom' }, 500)
      if (typeof grabs === 'function') return ok(grabs(url))
      return ok(grabs)
    }
    if (url.includes('/api/files/browse')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      const listing = listings[path]
      if (listing === 'error') return ok({ detail: 'boom' }, 500)
      if (listing) return ok(listing)
      return ok({ ok: true, items: [], path })
    }
    if (url.includes('/api/settings')) {
      if (paths === null) return ok({ detail: 'boom' }, 500)
      return ok({ paths })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof stubFetch>

function renderPanel(node: ReactElement, client?: QueryClient) {
  const queryClient =
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

const tags = () =>
  [...document.querySelectorAll('.has-file-tag')].map((el) => ({
    label: el.textContent ?? '',
    on: el.classList.contains('is-on'),
  }))

const callsWith = (fn: FetchMock, needle: string) =>
  fn.mock.calls.filter(([input]) => String(input).includes(needle))

describe('the tags · three sources, one class each', () => {
  beforeEach(() => {
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lights a class the library does not have when OUR grab asked for it', async () => {
    // The requirement's own example: the arr's file is 1080p, but this app
    // once grabbed the 4K too — both copies exist, both tags must say so.
    stubFetch({
      grabs: {
        grabs: [
          { quality: 'Bluray-1080p', destination: null, grabbed_at: 1_700_000_000 },
          { quality: 'Bluray-2160p', destination: null, grabbed_at: 1_700_000_100 },
        ],
      },
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
    })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: true },
        { label: '4K', on: true },
        { label: '3D', on: false },
      ]),
    )
    // Everything was consulted and nothing needs explaining.
    expect(document.querySelector('.has-file-note')).toBeNull()
  })

  it('lights 3D from a grab whose destination is path_3d, whatever the file says', async () => {
    // 3D has no quality token: the destination IS the claim (a place, like
    // `path` membership — the same rule backend destination_for_quality routes by).
    stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      grabs: {
        grabs: [{ quality: 'Bluray-2160p', destination: '/mnt/3d', grabbed_at: 1_700_000_000 }],
      },
    })
    renderPanel(
      <ReleaseSearchModal item={makeItem({ quality: '' })} presentation="panel" />,
    )

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: false },
        { label: '4K', on: true },
        { label: '3D', on: true },
      ]),
    )
  })

  it('lights 4K from a copy sitting in path_4k the library never mentions', async () => {
    // The arr's file is 1080p and we never grabbed a 4K — but one is ON DISK
    // in the 4K folder: the nested layout (a folder named after the title)…
    stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      listings: {
        '/mnt/4k': {
          ok: true,
          items: [{ name: 'ParaNorman (2012)' }, { name: 'Another Title (2010)' }],
        },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    await waitFor(() => expect(tags()[1]).toEqual({ label: '4K', on: true }))
  })

  it('matches the historical flat copies by PREFIX, never by exact equality', async () => {
    // `path_4k/<basename(path)>….mkv`: the entry name starts with the title's
    // folder name but is not equal to it — exact equality would miss it.
    stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      listings: {
        '/mnt/4k': { ok: true, items: [{ name: 'ParaNorman (2012).mkv' }] },
        '/mnt/3d': { ok: true, items: [{ name: 'ParaNorman (2012) 3D.iso' }] },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: true },
        { label: '4K', on: true },
        { label: '3D', on: true },
      ]),
    )
  })

  it('keeps a class grey when a checked folder holds no copy of this title', async () => {
    // Checked, not there: grey is the answer — and with every source
    // consulted there is nothing to explain, so no note renders.
    stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      grabs: {
        grabs: [{ quality: null, destination: null, grabbed_at: null }],
      },
      listings: {
        '/mnt/4k': { ok: true, items: [{ name: 'Some Other Film (1999)' }] },
        '/mnt/3d': { ok: true, items: [] },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem({ quality: '' })} presentation="panel" />)

    await waitFor(() => expect(document.querySelector('.has-file-note')).toBeNull())
    expect(tags().every((tag) => !tag.on)).toBe(true)
  })

  it('never finds a copy for a title that carries no path to name it by', async () => {
    // An absent path must not become "" as a prefix: every entry name starts
    // with "", so the listing would "prove" a copy for any title whatsoever.
    stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      listings: {
        '/mnt/4k': { ok: true, items: [{ name: 'ParaNorman (2012)' }] },
        '/mnt/3d': { ok: true, items: [{ name: 'ParaNorman (2012)' }] },
      },
    })
    renderPanel(
      <ReleaseSearchModal item={makeItem({ path: undefined, quality: '' })} presentation="panel" />,
    )

    await waitFor(() => expect(document.querySelector('.has-file-note')).toBeNull())
    expect(tags().every((tag) => !tag.on)).toBe(true)
  })
})

describe('the tags · unknown is not absent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves the tags as the library said when the grabs call fails', async () => {
    stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      grabs: 'error',
      listings: {
        '/mnt/4k': { ok: true, items: [] },
        '/mnt/3d': { ok: true, items: [] },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    // 1080 stays lit (the library still says so) — a failed source must never
    // grey a tag DOWN — and the note names the source that could not be read.
    expect(await screen.findByText(/Comprobación parcial/)).toBeInTheDocument()
    expect(screen.getByText(/las descargas de la app no se pudieron leer/)).toBeInTheDocument()
    expect(tags()).toEqual([
      { label: '1080', on: true },
      { label: '4K', on: false },
      { label: '3D', on: false },
    ])
  })

  it('leaves the tags as they were when a configured folder cannot be read', async () => {
    stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      listings: { '/mnt/4k': 'error' },
    })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    expect(await screen.findByText(/la carpeta path_4k no se pudo leer/)).toBeInTheDocument()
    expect(screen.queryByText(/path_4k sin configurar/)).toBeNull()
    expect(tags()).toEqual([
      { label: '1080', on: true },
      { label: '4K', on: false },
      { label: '3D', on: false },
    ])
  })

  it('says the folders are unconfigured — not unreadable — when settings say ""', async () => {
    const fn = stubFetch({ paths: { path_4k: '', path_3d: '' } })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    // Unconfigured is a fact, not a failure: the folders cannot contribute,
    // and the copy says exactly that — while a failed read would say the
    // opposite (unknown, never "sin configurar").
    expect(
      await screen.findByText(/path_4k sin configurar · path_3d sin configurar/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/no se pudo leer/)).toBeNull()
    // The rule itself: a folder that does not exist is never browsed.
    expect(callsWith(fn, '/api/files/browse')).toHaveLength(0)
    expect(tags()).toEqual([
      { label: '1080', on: true },
      { label: '4K', on: false },
      { label: '3D', on: false },
    ])
  })

  it('calls the settings read a failure to read, never "sin configurar"', async () => {
    stubFetch({ paths: null })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    expect(
      await screen.findByText(/la configuración de carpetas no se pudo leer/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/sin configurar/)).toBeNull()
    expect(tags()).toEqual([
      { label: '1080', on: true },
      { label: '4K', on: false },
      { label: '3D', on: false },
    ])
  })
})

describe('the tags · what each request costs', () => {
  beforeEach(() => {
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks grabs once per selection and each folder at most once per session', async () => {
    const fn = stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const first = renderPanel(
      <ReleaseSearchModal item={makeItem({ id: 111 })} presentation="panel" />,
      client,
    )
    await waitFor(() => expect(callsWith(fn, '/api/grabs')).toHaveLength(1))
    // Both routing folders, once each: the listing is per FOLDER, not per item.
    await waitFor(() => expect(callsWith(fn, '/api/files/browse')).toHaveLength(2))
    first.unmount()

    renderPanel(
      <ReleaseSearchModal item={makeItem({ id: 222, path: '/peliculas/Otra (2020)' })} presentation="panel" />,
      client,
    )
    // A different title is a different history: exactly one more grabs call…
    await waitFor(() => expect(callsWith(fn, '/api/grabs')).toHaveLength(2))
    // …and ZERO more browse calls: same two folders, already listed this session.
    expect(callsWith(fn, '/api/files/browse')).toHaveLength(2)
    const browsed = callsWith(fn, '/api/files/browse').map(([input]) => String(input))
    expect(browsed.every((url) => url.includes('path=%2Fmnt%2F4k') || url.includes('path=%2Fmnt%2F3d'))).toBe(true)
  })

  it('reads settings through the shared routing-folders document, once', async () => {
    const fn = stubFetch()
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    await waitFor(() => expect(callsWith(fn, '/api/settings')).toHaveLength(1))
    // The tags settle without a second read of the same document.
    await waitFor(() => expect(document.querySelector('.has-file-note')).toBeNull())
    expect(callsWith(fn, '/api/settings')).toHaveLength(1)
  })

  it('never asks any of the three for a title with no file', async () => {
    const fn = stubFetch()
    renderPanel(
      <ReleaseSearchModal
        item={makeItem({ id: 999, has_file: false, file_name: undefined })}
        presentation="panel"
      />,
    )

    // The 🔍 button is what such a title meets instead of the block, and
    // selecting it asks NONE of the three (they are the has-file block's
    // sources): no grabs, no browse — not before the press…
    expect(await screen.findByRole('button', { name: /Buscar Releases/ })).toBeInTheDocument()
    expect(document.querySelector('.has-file-block')).toBeNull()
    expect(callsWith(fn, '/api/grabs')).toHaveLength(0)
    expect(callsWith(fn, '/api/files/browse')).toHaveLength(0)

    // …and not after it either: the press reaches the results, and the
    // three sources are still the block's, not the list's.
    fireEvent.click(screen.getByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(document.querySelector('.has-file-block')).toBeNull()
    expect(callsWith(fn, '/api/grabs')).toHaveLength(0)
    expect(callsWith(fn, '/api/files/browse')).toHaveLength(0)
  })
})

describe('the tags · the ids the grabs history is asked under', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks a movie by movie_id and an episode by episode_id', async () => {
    const movieMock = stubFetch()
    const movie = renderPanel(<ReleaseSearchModal item={makeItem({ id: 42 })} presentation="panel" />)
    await waitFor(() => expect(callsWith(movieMock, '/api/grabs')).toHaveLength(1))
    expect(String(callsWith(movieMock, '/api/grabs')[0][0])).toContain('movie_id=42')
    expect(String(callsWith(movieMock, '/api/grabs')[0][0])).toContain('source=radarr')
    movie.unmount()
    vi.unstubAllGlobals()

    const episodeMock = stubFetch()
    renderPanel(
      <ReleaseSearchModal
        item={makeItem({
          id: 55,
          source: 'sonarr',
          type: 'episode',
          title: 'Of Ice Men',
          series_title: 'Some Show',
        })}
        presentation="panel"
      />,
    )
    await waitFor(() => expect(callsWith(episodeMock, '/api/grabs')).toHaveLength(1))
    const url = String(callsWith(episodeMock, '/api/grabs')[0][0])
    expect(url).toContain('episode_id=55')
    expect(url).toContain('source=sonarr')
    expect(url).not.toContain('movie_id')
  })

  it('a series item asks by series_id and gets ITS grabs, not an id-colliding episode\'s', async () => {
    const fn = stubFetch({
      paths: { path_4k: '', path_3d: '' },
      // The two kinds answer differently: the SERIES owns a 2160p grab, the
      // colliding episode id belongs to another show that grabbed a 1080p.
      // Asking the wrong kind flips the tags, so they pin BOTH the URL and
      // which response was actually consumed.
      grabs: (url) =>
        url.includes('series_id=')
          ? { grabs: [{ quality: 'Bluray-2160p', destination: null, grabbed_at: 1 }] }
          : { grabs: [{ quality: 'Bluray-1080p', destination: null, grabbed_at: 1 }] },
    })
    renderPanel(
      <ReleaseSearchModal
        item={makeItem({
          type: 'episode',
          id: 7,
          source: 'sonarr',
          idKind: 'series',
          quality: undefined,
          path: '/series/Some Show',
        })}
        presentation="panel"
      />,
    )

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: false },
        { label: '4K', on: true },
        { label: '3D', on: false },
      ]),
    )
    const url = String(callsWith(fn, '/api/grabs')[0][0])
    expect(url).toContain('series_id=7')
    expect(url).not.toContain('episode_id')
  })
})

/**
 * The same contract, one level down: what each SECTION's release builder puts
 * on the item. The panel can only ask the right id kind if the builder tells
 * it which kind it is carrying — a Series card types itself `episode` (the
 * only thing Sonarr can grab) while holding the SERIES id, which is exactly
 * the collision the item-level test above pins from the other side.
 */
describe('the ids · what each section card puts on the item', () => {
  let fn: FetchMock

  beforeEach(() => {
    window.location.hash = ''
    // Unconfigured routing folders: these tests pin the id KIND on the grabs
    // query, not the tags — and "" keeps the browse economy intact.
    fn = stubFetch({ paths: { path_4k: '', path_3d: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const grabUrls = () => callsWith(fn, '/api/grabs').map(([input]) => String(input))

  /** The pane's rows (Biblioteca) and the Calidad table's rows. */
  const rowOf = (title: string) =>
    Array.from(document.querySelectorAll('.sec-row, .sec-q-row')).find((row) =>
      row.textContent?.includes(title),
    ) as HTMLElement

  it('a Biblioteca series card asks by series_id, never by an episode id it does not own', async () => {
    renderPanel(<Series />)
    await screen.findByText('Some Show')

    fireEvent.click(rowOf('Some Show'))

    // What this pins is WHICH id is asked (series_id, never episode_id), not
    // when the modal happens to mount: skipping the tab click was incidental
    // setup that only worked while Releases was the default tab.
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }))

    await waitFor(() => expect(grabUrls()).toHaveLength(1))
    expect(grabUrls()[0]).toContain('series_id=3')
    expect(grabUrls()[0]).not.toContain('episode_id')
  })

  it('a Calidad series card asks by series_id too — the view the requirement names', async () => {
    renderPanel(<Series />)
    await screen.findByText('Some Show')
    fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))
    await screen.findByRole('group', { name: 'Filtrar por clase' })

    fireEvent.click(rowOf('Some Show'))

    // Same claim as above: WHICH id is asked (series_id, never episode_id),
    // not when the modal happens to mount — the missing tab click was
    // incidental setup that only worked while Releases was the default tab.
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }))

    await waitFor(() => expect(grabUrls()).toHaveLength(1))
    expect(grabUrls()[0]).toContain('series_id=3')
    expect(grabUrls()[0]).not.toContain('episode_id')
  })

  it('a Calidad movie card asks by movie_id', async () => {
    renderPanel(<Peliculas />)
    await screen.findByText('Your Name.')
    fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))
    await screen.findByRole('group', { name: 'Filtrar por clase' })

    fireEvent.click(rowOf('Your Name.'))

    await waitFor(() => expect(grabUrls()).toHaveLength(1))
    expect(grabUrls()[0]).toContain('movie_id=411')
    expect(grabUrls()[0]).not.toContain('episode_id')
  })

  it('an Estrenos episode card still asks by episode_id — a real episode id', async () => {
    renderPanel(<Series />)
    await screen.findByText('Some Show')
    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))

    fireEvent.click(await screen.findByText('Estreno de Episodio'))

    await waitFor(() => expect(grabUrls()).toHaveLength(1))
    expect(grabUrls()[0]).toContain('episode_id=42')
    expect(grabUrls()[0]).toContain('source=sonarr')
    expect(grabUrls()[0]).not.toContain('series_id')
  })
})

describe('the tags · the block still offers its way out', () => {
  beforeEach(() => {
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps Buscar versiones as the entry into an upgrade search', async () => {
    const fn = stubFetch()
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Buscar versiones' }))

    await screen.findByPlaceholderText('Filtrar por título...')
    expect(callsWith(fn, '/api/calendar/releases')).toHaveLength(1)
  })
})

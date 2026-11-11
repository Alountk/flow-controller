import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type ReactElement } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal, type ReleaseSearchItem } from '../../../features/release-search/ReleaseSearchModal.tsx'

/**
 * The has-file tags' sources of truth: LOCALIZED files only.
 *
 * Three sources may prove a class:
 * 1. the arr's library (`item.quality`, or `item.resolution` when the backend
 *    measured it) — the file Radarr reports IS on disk;
 * 2. the movie's own folder (GET /api/files/browse of `item.path`) — the
 *    physical 1080 file the movieFile stopped naming after a manual import
 *    adopts a 4K;
 * 3. the routing folders on disk (GET /api/files/browse — an entry whose name
 *    starts with this title's folder name is a copy of it).
 *
 * This app's own REQUESTS (GET /api/grabs: what we ASKED the arr to
 * download) never mark anything here — a request is not a file (the bug the
 * operator saw: requests claiming 1080/4K/3D while Archivos held nothing).
 * The request history lives in the Historial tab instead.
 *
 * What is pinned here is the contract, not the plumbing:
 * - a tag lights when a localization source PROVES the class, grey otherwise;
 * - "unknown" (a failed read, an unconfigured folder) never masquerades as
 *   "absent" — the tags do not grey DOWN and `Comprobación parcial` says why;
 * - the request economy: the has-file block never asks /api/grabs, the routing
 *   folders once per session and the title's own folder once per folder (all
 *   keyed by folder), none at all for an item with no file.
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
  /** The /api/grabs body — served only to prove that requests never mark. */
  grabs?: GrabsBody | 'error'
  /** Per-folder /api/files/browse bodies, by folder path. A folder mapped to
   *  'error' answers HTTP 500; an unlisted folder answers an empty listing. */
  listings?: Record<
    string,
    { ok?: boolean; items?: { name: string; is_dir?: boolean; is_video?: boolean }[] } | 'error'
  >
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
            indexer: 'aMuTorrent',
            source: 'torznab',
            link: 'https://idx.test/download/rel-1.torrent',
            seeders: 15,
          },
        ],
        detail: '1 releases encontrados',
      })
    }
    if (url.includes('/api/grabs')) {
      if (grabs === 'error') return ok({ detail: 'boom' }, 500)
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

describe('the tags · what may prove a class', () => {
  beforeEach(() => {
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lights the class the library reports', async () => {
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: true },
        { label: '4K', on: false },
        { label: '3D', on: false },
        { label: 'SD', on: false },
      ]),
    )
    // Everything was consulted and nothing needs explaining.
    expect(document.querySelector('.has-file-note')).toBeNull()
  })

  it('never lights a class from OUR OWN REQUESTS — a request is not a file', async () => {
    // The reported bug: we once asked for the 4K and a 720p copy too, while
    // only the 1080p file is localized — requests may not claim any class.
    const fn = stubFetch({
      grabs: {
        grabs: [
          { quality: 'Bluray-1080p', destination: null, grabbed_at: 1_700_000_000 },
          { quality: 'Bluray-2160p', destination: null, grabbed_at: 1_700_000_100 },
          { quality: 'HDTV-720p', destination: null, grabbed_at: 1_700_000_200 },
        ],
      },
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      listings: { '/mnt/4k': { ok: true, items: [] }, '/mnt/3d': { ok: true, items: [] } },
    })
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    await waitFor(() => expect(document.querySelector('.has-file-note')).toBeNull())
    expect(tags()).toEqual([
      { label: '1080', on: true },
      { label: '4K', on: false },
      { label: '3D', on: false },
      { label: 'SD', on: false },
    ])
    // The block never even consults the request history: that is Historial's.
    expect(callsWith(fn, '/api/grabs')).toHaveLength(0)
  })

  it('never lights 3D from a request destined to path_3d', async () => {
    // 3D from a destination was a REQUEST claim: the arr was told to put a
    // copy there. With no copy on disk and no 3D file, the tag stays grey.
    const fn = stubFetch({
      paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' },
      grabs: {
        grabs: [{ quality: 'Bluray-2160p', destination: '/mnt/3d', grabbed_at: 1_700_000_000 }],
      },
      listings: { '/mnt/4k': { ok: true, items: [] }, '/mnt/3d': { ok: true, items: [] } },
    })
    renderPanel(
      <ReleaseSearchModal item={makeItem({ quality: '' })} presentation="panel" />,
    )

    await waitFor(() => expect(document.querySelector('.has-file-note')).toBeNull())
    expect(tags()).toEqual([
      { label: '1080', on: false },
      { label: '4K', on: false },
      { label: '3D', on: false },
      { label: 'SD', on: false },
    ])
    expect(callsWith(fn, '/api/grabs')).toHaveLength(0)
  })

  it('lights 4K from a copy sitting in path_4k the library never mentions', async () => {
    // The arr's file is 1080p — but a 4K copy is ON DISK in the 4K folder:
    // the nested layout (a folder named after the title)…
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
        { label: 'SD', on: false },
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
      { label: 'SD', on: false },
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
    // The rule itself: folders that do not exist are never browsed — the one
    // browse is the title's own folder, the 1080 file's physical source.
    const browsed = callsWith(fn, '/api/files/browse')
    expect(browsed).toHaveLength(1)
    expect(String(browsed[0][0])).toContain(
      `path=${encodeURIComponent('/peliculas/ParaNorman (2012)')}`,
    )
    expect(tags()).toEqual([
      { label: '1080', on: true },
      { label: '4K', on: false },
      { label: '3D', on: false },
      { label: 'SD', on: false },
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
      { label: 'SD', on: false },
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

  it('reads each routing folder at most once per session, settings once', async () => {
    const fn = stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const first = renderPanel(
      <ReleaseSearchModal item={makeItem({ id: 111 })} presentation="panel" />,
      client,
    )
    // Both routing folders, once each, plus the title's own folder: the
    // listings are per FOLDER, not per item.
    await waitFor(() => expect(callsWith(fn, '/api/files/browse')).toHaveLength(3))
    first.unmount()

    renderPanel(
      <ReleaseSearchModal item={makeItem({ id: 222, path: '/peliculas/Otra (2020)' })} presentation="panel" />,
      client,
    )
    // ONE more browse: the new title's own folder. The routing folders stay
    // cached this session — and still zero grabs calls: the request history
    // is not the tags' source.
    expect(callsWith(fn, '/api/files/browse')).toHaveLength(4)
    expect(callsWith(fn, '/api/grabs')).toHaveLength(0)
    const browsed = callsWith(fn, '/api/files/browse').map(([input]) =>
      new URL(String(input), 'http://x').searchParams.get('path'),
    )
    expect([...browsed].sort()).toEqual(
      ['/mnt/4k', '/mnt/3d', '/peliculas/ParaNorman (2012)', '/peliculas/Otra (2020)'].sort(),
    )
  })

  it('reads settings through the shared routing-folders document, once', async () => {
    const fn = stubFetch()
    renderPanel(<ReleaseSearchModal item={makeItem()} presentation="panel" />)

    await waitFor(() => expect(callsWith(fn, '/api/settings')).toHaveLength(1))
    // The tags settle without a second read of the same document.
    await waitFor(() => expect(document.querySelector('.has-file-note')).toBeNull())
    expect(callsWith(fn, '/api/settings')).toHaveLength(1)
  })

  it('never asks any source for a title with no file', async () => {
    const fn = stubFetch()
    renderPanel(
      <ReleaseSearchModal
        item={makeItem({ id: 999, has_file: false, file_name: undefined })}
        presentation="panel"
      />,
    )

    // The 🔍 button is what such a title meets instead of the block, and
    // selecting it asks NONE of the sources: no grabs, no browse — not
    // before the press…
    expect(await screen.findByRole('button', { name: /Buscar Releases/ })).toBeInTheDocument()
    expect(document.querySelector('.has-file-block')).toBeNull()
    expect(callsWith(fn, '/api/grabs')).toHaveLength(0)
    expect(callsWith(fn, '/api/files/browse')).toHaveLength(0)

    // …and not after it either: the press reaches the results, and the
    // sources are still the block's, not the list's.
    fireEvent.click(screen.getByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(document.querySelector('.has-file-block')).toBeNull()
    expect(callsWith(fn, '/api/grabs')).toHaveLength(0)
    expect(callsWith(fn, '/api/files/browse')).toHaveLength(0)
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

describe('the tags and the presented file · physical links (S1, S2)', () => {
  beforeEach(() => {
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The reported bug: after localizing a 4K, post_move_import →
  // arr_manual_import makes Radarr ADOPT it as movieFile, so quality,
  // resolution and file_name all re-read from the 4K — while the 1080 file
  // is still on disk in the movie folder.
  const adopted4k = {
    quality: 'Bluray-2160p',
    resolution: '2160',
    file_name: 'ParaNorman.2012.2160p.WEB-DL.mkv',
  }

  it('lights 1080 from the movie folder file even when the movieFile is the adopted 4K (S1)', async () => {
    stubFetch({
      listings: {
        '/peliculas/ParaNorman (2012)': {
          ok: true,
          items: [{ name: 'ParaNorman.2012.1080p.BluRay.x264.mkv', is_dir: false, is_video: true }],
        },
        '/mnt/4k': { ok: true, items: [{ name: 'ParaNorman (2012)', is_dir: true }] },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem(adopted4k)} presentation="panel" />)

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: true },
        { label: '4K', on: true },
        { label: '3D', on: false },
        { label: 'SD', on: false },
      ]),
    )
  })

  it('never lights 1080 without a physical 1080 file (S1)', async () => {
    stubFetch({
      listings: {
        '/peliculas/ParaNorman (2012)': { ok: true, items: [] },
        '/mnt/4k': { ok: true, items: [{ name: 'ParaNorman (2012)', is_dir: true }] },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem(adopted4k)} presentation="panel" />)

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: false },
        { label: '4K', on: true },
        { label: '3D', on: false },
        { label: 'SD', on: false },
      ]),
    )
  })

  it('presents the physical 1080 as the downloaded file — or nothing at all (S2)', async () => {
    // The 1080 file is on disk: IT is presented, never the adopted 4K.
    stubFetch({
      listings: {
        '/peliculas/ParaNorman (2012)': {
          ok: true,
          items: [{ name: 'ParaNorman.2012.1080p.BluRay.x264.mkv', is_dir: false, is_video: true }],
        },
      },
    })
    const first = renderPanel(
      <ReleaseSearchModal item={makeItem(adopted4k)} presentation="panel" />,
    )
    await waitFor(() =>
      expect(document.querySelector('.has-file-name')?.textContent).toBe(
        'ParaNorman.2012.1080p.BluRay.x264.mkv',
      ),
    )
    first.unmount()

    // No 1080 anywhere: no file line at all — while the tags still draw the
    // physical 4K copy per S1.
    stubFetch({
      listings: {
        '/peliculas/ParaNorman (2012)': { ok: true, items: [] },
        '/mnt/4k': { ok: true, items: [{ name: 'ParaNorman (2012)', is_dir: true }] },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem(adopted4k)} presentation="panel" />)
    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: false },
        { label: '4K', on: true },
        { label: '3D', on: false },
        { label: 'SD', on: false },
      ]),
    )
    expect(document.querySelector('.has-file-name')).toBeNull()
    expect(document.querySelector('.has-file-missing')).toBeNull()
  })
})

describe("the tags · the detail reads the row's physical answer (libraries)", () => {
  beforeEach(() => {
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Same reported bug as above: the movieFile is the adopted 4K while the
  // 1080 file is still on disk — but here the ROW already answered for both.
  const adopted4k = {
    quality: 'Bluray-2160p',
    resolution: '2160',
    file_name: 'ParaNorman.2012.2160p.WEB-DL.mkv',
  }

  it('lights the tags purely from the row answer and never browses the movie folder', async () => {
    const fn = stubFetch()
    renderPanel(
      <ReleaseSearchModal
        item={makeItem({ ...adopted4k, libraries: ['1080p', '4K'] })}
        presentation="panel"
      />,
    )

    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: true },
        { label: '4K', on: true },
        { label: '3D', on: false },
        { label: 'SD', on: false },
      ]),
    )
    // The routing folders may still be read (their queries stay as they are);
    // the movie's OWN folder must not be — the row answered for it already.
    await waitFor(() => expect(callsWith(fn, '/api/files/browse')).toHaveLength(2))
    expect(
      callsWith(fn, `path=${encodeURIComponent('/peliculas/ParaNorman (2012)')}`),
    ).toHaveLength(0)
  })

  it('passes the row answer through verbatim — an empty answer lights nothing', async () => {
    stubFetch()
    renderPanel(<ReleaseSearchModal item={makeItem({ libraries: [] })} presentation="panel" />)

    // quality: 'Bluray-1080p' claims nothing here: the backend proved none.
    await waitFor(() => expect(tags()).toHaveLength(4))
    expect(tags().every((tag) => !tag.on)).toBe(true)
  })

  it('never ORs the fallback sources into a present row answer', async () => {
    // Both fallback sources would light tags here (the own 1080 file, the
    // path_4k copy); with the row answer present they contribute nothing.
    stubFetch({
      listings: {
        '/peliculas/ParaNorman (2012)': {
          ok: true,
          items: [{ name: 'ParaNorman.2012.1080p.BluRay.x264.mkv', is_dir: false, is_video: true }],
        },
        '/mnt/4k': { ok: true, items: [{ name: 'ParaNorman (2012)', is_dir: true }] },
      },
    })
    renderPanel(<ReleaseSearchModal item={makeItem({ libraries: [] })} presentation="panel" />)

    await waitFor(() => expect(tags()).toHaveLength(4))
    expect(tags().every((tag) => !tag.on)).toBe(true)
  })

  it('presents file_1080 as the downloaded file — and nothing when it is "" (S2)', async () => {
    stubFetch()
    const first = renderPanel(
      <ReleaseSearchModal
        item={
          makeItem({
            ...adopted4k,
            libraries: ['1080p', '4K'],
            file_1080: 'ParaNorman.2012.1080p.BluRay.x264.mkv',
          })
        }
        presentation="panel"
      />,
    )
    await waitFor(() =>
      expect(document.querySelector('.has-file-name')?.textContent).toBe(
        'ParaNorman.2012.1080p.BluRay.x264.mkv',
      ),
    )
    first.unmount()

    // "" = the backend proved no 1080 file: no name line at all — never the
    // adopted 4K's — while the physical tags still draw.
    stubFetch()
    renderPanel(
      <ReleaseSearchModal
        item={makeItem({ ...adopted4k, libraries: ['1080p', '4K'], file_1080: '' })}
        presentation="panel"
      />,
    )
    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: true },
        { label: '4K', on: true },
        { label: '3D', on: false },
        { label: 'SD', on: false },
      ]),
    )
    expect(document.querySelector('.has-file-name')).toBeNull()
    expect(document.querySelector('.has-file-missing')).toBeNull()
  })
})

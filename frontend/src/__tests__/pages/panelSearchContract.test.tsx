import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../pages/Peliculas.tsx'
import { ReleaseSearchModal, type ReleaseSearchItem } from '../../features/release-search/ReleaseSearchModal.tsx'
import type { Release } from '../../shared/api/releases.ts'

/**
 * The two contracts this change establishes, pinned directly:
 *
 * 1. SELECTING A ROW NEVER SEARCHES. The operator initiates — 🔍 Buscar
 *    Releases is THE way the first search starts — and changing the indexer
 *    re-runs it (PR B's requirement, kept). No other trigger exists.
 * 2. `holdsCopy` counts a routing-folder entry only when it is a DIRECTORY
 *    (the nested layout `path_4k/<folder>/<file>`) or a file the backend
 *    CLASSIFIED as video (the flat layout `path_4k/<folder>….mkv`). A `.srt`
 *    proves nothing: Dune's `path_4k` held only subtitles/nfo and the 4K tag
 *    lit anyway — the false positive this pins.
 */

// ── The section surface: rows → panel ────────────────────────────────────────

const catalogMovie = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: '',
  has_file: true,
  path: '/peliculas/Your Name. (2016)',
  path_exists: true,
  monitored: true,
  quality: 'WEBDL-1080p',
  grabbed_at: null,
  grabbed_destination: null,
}

const wantedMovie = {
  id: 813,
  title: 'Todo a la vez en todas partes',
  year: 2022,
  overview: '',
  remotePoster: '',
  has_file: false,
  altTitles: [],
  grabbed_at: null,
  grabbed_destination: null,
}

const release: Release = {
  guid: 'rel-contract-1',
  title: 'Everything.2022.1080p.BluRay.x264',
  size: 8_000_000_000,
  quality: 'Bluray-1080p',
  indexer: 'aMuTorrent',
  indexerId: 1,
  indexerFlags: '',
  seeders: 12,
  leechers: 2,
  protocol: 'torrent',
  releaseGroup: '',
  languages: ['Spanish'],
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch() {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [catalogMovie], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: { radarr: { items: [wantedMovie], total: 1 }, sonarr: { items: [], total: 0 } },
        updated_at: 0,
      })
    }
    if (url.includes('/api/calendar/indexers')) {
      return ok({
        indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
      })
    }
    if (url.includes('/api/calendar/destinations')) {
      return ok({ folders: [], arr_available: true, detail: '' })
    }
    if (url.includes('/api/calendar/releases')) {
      return ok({ releases: [release], detail: '1 releases encontrados' })
    }
    if (url.includes('/api/calendar?')) {
      return ok({ items: [], start: '2026-10-01', end: '2026-11-01' })
    }
    if (url.includes('/api/settings')) {
      return ok({ paths: { path_4k: '', path_3d: '' } })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof stubFetch>

const searchCalls = (fn: FetchMock) =>
  fn.mock.calls.filter(([input]) => String(input).includes('/api/calendar/releases')).length

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

const firstRow = () => document.querySelector('.sec-row') as HTMLElement

describe('the operator initiates · selection searches nothing', () => {
  let fn: FetchMock

  beforeEach(() => {
    window.location.hash = ''
    fn = stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects with ZERO searches, the 🔍 button issues one, the indexer change one more', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Todo a la vez en todas partes')

    // Trigger 1 — SELECTION. It lands the panel on the initial step with the
    // button waiting; no network search of any kind has started.
    fireEvent.click(firstRow())
    const button = await screen.findByRole('button', { name: /Buscar Releases/ })
    expect(searchCalls(fn)).toBe(0)
    // A mount trigger would already have fired (effects flush inside
    // fireEvent's act); one more tick proves nothing is pending either.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(searchCalls(fn)).toBe(0)

    // Trigger 2 — THE OPERATOR. Exactly one search, then the results.
    fireEvent.click(button)
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(searchCalls(fn)).toBe(1)

    // Trigger 3 — the INDEXER, and never before this moment: the count was 1
    // above, and it becomes exactly 2 now (PR B's requirement, kept).
    const select = screen.getByRole('combobox', { name: /Indexador/ }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: '1' } })
    await waitFor(() => expect(searchCalls(fn)).toBe(2))
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(searchCalls(fn)).toBe(2)
  })
})

// ── holdsCopy: what an entry in a routing folder proves ──────────────────────

function makeDune(overrides: Partial<ReleaseSearchItem> = {}): ReleaseSearchItem {
  return {
    type: 'movie',
    id: 777,
    title: 'Dune',
    year: 2021,
    source: 'radarr',
    has_file: true,
    file_name: 'Dune.2021.1080p.BluRay.x264.mkv',
    languages: ['Spanish'],
    // The library says NOTHING about 2160p: the 4K tag can only be lit by a
    // copy on disk, which is exactly what holdsCopy has to prove.
    quality: 'Bluray-1080p',
    path: '/peliculas/Dune (2021)',
    ...overrides,
  }
}

interface ListingEntry {
  name: string
  is_dir?: boolean
  is_video?: boolean
}

/** One stubbed `path_4k`; grabs answer "we own nothing", `path_3d` unset. */
function stubListing(items: ListingEntry[]): FetchMock {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/settings')) {
      return ok({ paths: { path_4k: '/mnt/4k', path_3d: '' } })
    }
    if (url.includes('/api/grabs')) {
      return ok({ grabs: [] })
    }
    if (url.includes('/api/files/browse')) {
      return ok({ ok: true, items, path: '/mnt/4k' })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const tags = () =>
  [...document.querySelectorAll('.has-file-tag')].map((el) => ({
    label: el.textContent ?? '',
    on: el.classList.contains('is-on'),
  }))

const browseCalls = (fn: FetchMock) =>
  fn.mock.calls.filter(([input]) => String(input).includes('/api/files/browse')).length

/**
 * The 4K tag ONCE the routing listing has landed — settled state, never the
 * grey "still fetching" render the tags show on their first paint.
 */
const fourK = async (fn: FetchMock) => {
  await waitFor(() => expect(browseCalls(fn)).toBe(1))
  // The stub answers with resolved promises: one macrotask drains the whole
  // fetch → setData → re-render chain, so what follows is the settled tag.
  await new Promise((resolve) => setTimeout(resolve, 10))
  await waitFor(() => expect(tags()).toHaveLength(3))
  return tags().find((tag) => tag.label === '4K')?.on
}

function renderPanel(item: ReleaseSearchItem) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal item={item} presentation="panel" />
    </QueryClientProvider>,
  )
}

describe('holdsCopy · a directory or a video file — never a subtitle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a directory in path_4k counts — the nested layout', async () => {
    const fn = stubListing([{ name: 'Dune (2021)', is_dir: true, is_video: false }])
    renderPanel(makeDune())

    expect(await fourK(fn)).toBe(true)
  })

  it('a .mkv in path_4k counts — the historical flat layout', async () => {
    const fn = stubListing([{ name: 'Dune (2021).mkv', is_dir: false, is_video: true }])
    renderPanel(makeDune())

    expect(await fourK(fn)).toBe(true)
  })

  it('an .iso in path_4k counts too — a disc image is a video we have', async () => {
    const fn = stubListing([{ name: 'Dune (2021) 3D.iso', is_dir: false, is_video: true }])
    renderPanel(makeDune())

    expect(await fourK(fn)).toBe(true)
  })

  it('a .srt does NOT count — the Dune false positive, pinned', async () => {
    // The real instance: path_4k held ONLY `…[ES+EN].srt` (52 entries of
    // subtitles/nfo) and the tag read as "we have the 4K". Classified as
    // not-a-video, the entry refuses — the tag stays grey like every other
    // source that cannot prove the class.
    const fn = stubListing([
      { name: 'Dune (2021) Bluray-2160p - x265 AC3 - [ES+EN].srt', is_dir: false, is_video: false },
      { name: 'Dune (2021).nfo', is_dir: false, is_video: false },
    ])
    renderPanel(makeDune({ quality: '' }))

    expect(await fourK(fn)).toBe(false)
  })

  it('an entry the payload never classified does not refuse either', async () => {
    // Classification is additive: a stub/older payload without `is_video` is
    // UNKNOWN, not "not a video" — only an explicit classification refuses.
    const fn = stubListing([{ name: 'Dune (2021)' }])
    renderPanel(makeDune())

    expect(await fourK(fn)).toBe(true)
  })
})

// ── The faltantes/todas buttons live beside the name filter ───────────────────
//
// They have existed in MediaPane since the wanted panel but were gated behind
// `showFilterButtons`, which nobody passed — so the name search appeared alone
// and there was no way to reach Faltantes from inside Biblioteca without the
// tab. They are wired to the sub-views rather than to a second filter, because
// two independent filters would contradict each other: clicking "Faltantes"
// and having the tab still read "Biblioteca" would be a bug dressed as a
// feature.

describe('the faltantes/todas buttons sit beside the name filter', () => {
  let fn: FetchMock

  beforeEach(() => {
    window.location.hash = ''
    fn = stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders both buttons and the name search in the same row', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    expect(screen.getByRole('button', { name: /Faltantes/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Todas/ })).toBeTruthy()
    // The search was always there; this pins it beside the buttons.
    expect(screen.getByRole('searchbox', { name: 'Filtrar películas' })).toBeTruthy()
    expect(searchCalls(fn)).toBe(0)
  })

  it('clicking Faltantes switches the SECTION, so the tab cannot contradict it', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes/ }))

    await screen.findByText('Todo a la vez en todas partes')
    // The section follows the button — same choice, one control. There is no
    // tab to contradict it any more, so the control's own state is what proves
    // it is on duty: the button carries `.active` for the view in play.
    expect(
      (screen.getByRole('button', { name: /Faltantes \(/ }) as HTMLElement).className,
    ).toContain('active')
  })

  it('clicking Todas comes back to Biblioteca', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes/ }))
    await screen.findByText('Todo a la vez en todas partes')

    fireEvent.click(screen.getByRole('button', { name: /^Todas/ }))
    await screen.findByText('Your Name.')
    expect(
      (screen.getByRole('tab', { name: 'Biblioteca' }) as HTMLElement).getAttribute('aria-selected'),
    ).toBe('true')
  })
})


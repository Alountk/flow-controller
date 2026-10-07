import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type ReactElement } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal, type ReleaseSearchItem } from '../../components/ReleaseSearchModal'
import type { Release } from '../../api/calendar'
import calendarCss from '../../components/CalendarModal.css?raw'

/**
 * The downloaded-file block (PR C of `odd/tasks/panel-y-estado-fila.md`).
 *
 * What it pins is the maintainer's ask — "no tiene sentido que nos salga
 * 'Ya tiene archivo descargado'; lo que debería salir es qué archivo es el
 * descargado y cuáles son los que faltan":
 *
 * 1. the REAL file name (never a title-derived invention) and its languages;
 * 2. the three quality tags, coloured when the file IS that class and grey
 *    when it is not — grey is the answer to "cuáles son los que faltan";
 * 3. `Buscar versiones`, the only entry into F-01's upgrade for a title that
 *    already has a file (without it the block only tells you what is missing).
 *
 * The overlay path (the calendar's cards carry none of these fields) is
 * asserted too: it must degrade honestly — show what exists, invent nothing.
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
    languages: ['Spanish', 'English'],
    quality: 'Bluray-1080p',
    path: '/peliculas/ParaNorman (2012)',
    ...overrides,
  }
}

const release: Release = {
  guid: 'rel-1',
  title: 'ParaNorman.2012.1080p.BluRay.x264',
  size: 8_000_000_000,
  quality: 'Bluray-2160p',
  indexer: 'aMuTorrent',
  indexerId: 1,
  indexerFlags: '',
  seeders: 15,
  leechers: 2,
  protocol: 'torrent',
  releaseGroup: '',
  languages: ['Spanish'],
}

/** `/api/settings` is where the 3D tag's rule (path inside `path_3d`) comes
 *  from — the same document backend/config.py rebuilds its PATH_3D from. */
function mockFetch(paths: { path_4k?: string; path_3d?: string } = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }] }),
      } as Response)
    }
    if (url.includes('/api/calendar/destinations')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ folders: ['/mnt/peliculas'], arr_available: true, detail: '' }),
      } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases: [release], detail: '1 releases encontrados' }),
      } as Response)
    }
    if (url.includes('/api/settings')) {
      return Promise.resolve({ ok: true, json: async () => ({ paths }) } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderWith(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

/** The panel — the sections' Releases tab, where a selected row lives. */
function renderPanel(item: ReleaseSearchItem) {
  return renderWith(
    <ReleaseSearchModal item={item} presentation="panel" />,
  )
}

/** The overlay — what the calendar opens (its cards carry no file data). */
function renderOverlay(item: ReleaseSearchItem) {
  return renderWith(
    <ReleaseSearchModal item={item} onClose={() => {}} />,
  )
}

const tags = () =>
  [...document.querySelectorAll('.has-file-tag')].map((el) => ({
    label: el.textContent ?? '',
    on: el.classList.contains('is-on'),
  }))

const releaseCalls = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.filter(([input]) => String(input).includes('/api/calendar/releases'))

describe('the downloaded-file block', () => {
  beforeEach(() => {
    mockFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the file that is on disk, never the old one-line answer', async () => {
    renderPanel(makeItem())

    expect(await screen.findByText('ParaNorman.2012.1080p.BluRay.x264.mkv')).toBeInTheDocument()
    // The old copy is gone: it said "✓" and nothing else.
    expect(screen.queryByText(/Ya tiene archivo descargado/)).toBeNull()
  })

  it('shows the languages of that file, and nothing when there are none', async () => {
    const { unmount } = renderPanel(makeItem())

    expect(await screen.findByText('Spanish, English')).toBeInTheDocument()
    unmount()

    renderPanel(makeItem({ languages: [] }))

    // An empty list renders NOTHING — no dash, no "sin idioma".
    expect(document.querySelector('.has-file-langs')).toBeNull()
  })

  it('colours the class the file has and greys the ones it lacks', async () => {
    renderPanel(makeItem())

    await screen.findByText('ParaNorman.2012.1080p.BluRay.x264.mkv')

    expect(tags()).toEqual([
      { label: '1080', on: true },
      { label: '4K', on: false },
      { label: '3D', on: false },
    ])
  })

  it('lights 3D only when the file lives inside path_3d', async () => {
    mockFetch({ path_4k: '/mnt/4k', path_3d: '/mnt/3d' })
    renderPanel(makeItem({ path: '/mnt/3d/ParaNorman (2012)' }))

    await screen.findByText('ParaNorman.2012.1080p.BluRay.x264.mkv')

    // The 3D rule needs `path_3d` from the settings read, which lands one
    // tick after the block renders — wait for the light, not for the DOM.
    await waitFor(() =>
      expect(tags()).toEqual([
        { label: '1080', on: true },
        { label: '4K', on: false },
        { label: '3D', on: true },
      ]),
    )
  })

  it('leaves every tag grey when the quality is unknown', async () => {
    renderPanel(makeItem({ quality: '' }))

    await screen.findByText('ParaNorman.2012.1080p.BluRay.x264.mkv')

    // Unknown is unknown: a tag may only claim what the arr actually said.
    expect(tags().every((t) => !t.on)).toBe(true)
  })

  it('keeps 3D grey when path_3d is unconfigured, whatever the path says', async () => {
    mockFetch({ path_4k: '/mnt/4k', path_3d: '' })
    renderPanel(makeItem({ path: '/mnt/3d/ParaNorman (2012)' }))

    await screen.findByText('ParaNorman.2012.1080p.BluRay.x264.mkv')

    expect(tags().find((t) => t.label === '3D')?.on).toBe(false)
  })

  it('starts the search for this title from the block — the F-01 entry', async () => {
    const fn = mockFetch()
    renderPanel(makeItem())

    fireEvent.click(await screen.findByRole('button', { name: 'Buscar versiones' }))

    await screen.findByPlaceholderText('Filtrar por título...')
    expect(releaseCalls(fn)).toHaveLength(1)
    expect(String(releaseCalls(fn)[0][0])).toContain('/api/calendar/releases')
  })

  it('wraps a long name instead of overflowing it', () => {
    // The CSS is the only place that promise lives: monospace + wrapping.
    expect(calendarCss).toMatch(/\.has-file-name[\s\S]*?font-family:\s*ui-monospace/)
    expect(calendarCss).toMatch(/\.has-file-name[\s\S]*?overflow-wrap/)
  })
})

/**
 * The calendar's cards carry none of this data (no file_name, no languages,
 * no quality, no path), and `Calendar.tsx` does not even open the modal for a
 * title that has a file — but the block must still be honest if an overlay
 * ever gets here: show what exists, never invent a name.
 */
describe('the block without file data (overlay)', () => {
  beforeEach(() => {
    mockFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says the name is unavailable instead of inventing one', async () => {
    renderOverlay(makeItem({ file_name: undefined }))

    expect(await screen.findByText('Nombre no disponible en esta vista')).toBeInTheDocument()
    expect(document.querySelector('.has-file-name')?.textContent).not.toMatch(/\.mkv|ParaNorman\./)
  })

  it('greys every tag and still offers the search', async () => {
    renderOverlay(
      makeItem({ file_name: undefined, languages: undefined, quality: undefined, path: undefined }),
    )

    expect(await screen.findByRole('button', { name: 'Buscar versiones' })).toBeInTheDocument()
    expect(tags()).toEqual([
      { label: '1080', on: false },
      { label: '4K', on: false },
      { label: '3D', on: false },
    ])
  })

  it('searches from the overlay too', async () => {
    const fn = mockFetch()
    renderOverlay(makeItem({ file_name: undefined }))

    fireEvent.click(await screen.findByRole('button', { name: 'Buscar versiones' }))

    await waitFor(() => expect(releaseCalls(fn)).toHaveLength(1))
  })
})

/**
 * A title that still needs a file never meets this block: `WantedMovie` has no
 * file at all, so its panel offers the 🔍 button instead of a status — and
 * sits there until the operator presses it.
 */
describe('a title without a file', () => {
  beforeEach(() => {
    mockFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders no file block — and the press, not the selection, is what searches', async () => {
    const fn = mockFetch()
    // A fresh id: `panelResults` is module-level, and a title that already
    // produced results restores them instead of searching again.
    renderPanel(
      makeItem({
        id: 999,
        has_file: false,
        file_name: undefined,
        languages: undefined,
        quality: undefined,
        path: undefined,
      }),
    )

    // The two halves of the claim, split: no block and no search on
    // selection…
    expect(await screen.findByRole('button', { name: /Buscar Releases/ })).toBeInTheDocument()
    expect(document.querySelector('.has-file-block')).toBeNull()
    expect(releaseCalls(fn)).toHaveLength(0)

    // …and exactly one search from the press.
    fireEvent.click(screen.getByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(document.querySelector('.has-file-block')).toBeNull()
    expect(releaseCalls(fn)).toHaveLength(1)
  })
})

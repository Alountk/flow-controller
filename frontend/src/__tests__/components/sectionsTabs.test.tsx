import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../components/Peliculas'
import { Series } from '../../components/Series'

/**
 * PR 6 of F-08: the detail panel's tabs carry real data.
 *
 * Archivos lists the SELECTED ROW's folder through GET /api/files/browse —
 * read-only, with the honest states a real filesystem produces (no path on
 * the row, a file where a folder was expected, a failed fetch). Episodios
 * (Series) lists GET /api/wanted/series/{id}/episodes, only the fields that
 * response carries. Historial reads the row's own `grabbed_at` and
 * `grabbed_destination` — the app's own grab record — and never asks
 * /api/auto-copy/history, which is a global log, not a per-item one.
 *
 * The tab BAR itself (all tabs enabled, the roadmap token) is pinned in
 * Sections.test; the Releases tab's inline search is pinned in
 * sectionsPanel.test. This file pins what each NEW tab renders.
 */

const CATALOG_PATH = '/peliculas/Your Name. (2016)'
const GRABBED_AT = 1_759_468_800

const movieGrabbed = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: '',
  has_file: true,
  path: CATALOG_PATH,
  path_exists: true,
  monitored: true,
  quality: 'Bluray-2160p',
  grabbed_at: GRABBED_AT,
  grabbed_destination: '/mnt/peliculas/_manual',
}

const movieQuiet = {
  id: 500,
  title: 'Sin Pedido',
  year: 2020,
  remotePoster: '',
  has_file: true,
  path: '/peliculas/Sin Pedido (2020)',
  path_exists: true,
  monitored: true,
  quality: 'WEBDL-1080p',
  grabbed_at: null,
  grabbed_destination: null,
}

/** A missing movie: WantedMovie has NO path field, and the row says so. */
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

const catalogSeries = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: true,
  path: '/series/Some Show',
  path_exists: true,
  monitored: true,
  episode_count: 2,
  episode_file_count: 1,
  // Grabbed with no destination: it went to the arr's own library.
  grabbed_at: GRABBED_AT,
  grabbed_destination: null,
}

/** A wanted episode whose payload omitted `series_id` — no series to ask. */
const orphanEpisode = {
  id: 9,
  title: 'Of Ice Men',
  series_title: 'Some Show',
  series_id: null,
  season_number: 3,
  episode_number: 7,
  air_date: '2006-11-27T00:00:00Z',
  overview: '',
  has_file: false,
  grabbed_at: null,
  grabbed_destination: null,
}

const seriesEpisodes = [
  { id: 7, season_number: 3, episode_number: 7, title: 'Of Ice Men', air_date: '2006-11-27T00:00:00Z' },
  { id: 8, season_number: 3, episode_number: 8, title: 'The Next One', air_date: '2006-12-04T00:00:00Z' },
]

const folderListing = {
  ok: true,
  path: CATALOG_PATH,
  items: [
    { name: 'Your.Name.2016.mkv', path: `${CATALOG_PATH}/Your.Name.2016.mkv`, is_dir: false, size: 12_000_000_000, modified: 1_759_382_400 },
    { name: 'subs', path: `${CATALOG_PATH}/subs`, is_dir: true, size: 0, modified: 1_759_300_000 },
  ],
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** Every listing the sections and the panel's tabs can ask for. */
function stubFetch(opts: { browse?: unknown; browseReject?: boolean } = {}) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/files/browse')) {
      if (opts.browseReject) return Promise.reject(new Error('red caída'))
      if (opts.browse) return ok(opts.browse)
      return ok(folderListing)
    }
    if (url.includes('/api/wanted/series/3/episodes')) {
      return ok({ episodes: seriesEpisodes })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [catalogSeries], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [movieGrabbed, movieQuiet], total: 2, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: {
          radarr: { items: [wantedMovie], total: 1 },
          sonarr: { items: [orphanEpisode], total: 1 },
        },
        updated_at: 0,
      })
    }
    // The Releases tab mounts with the selection: its own endpoints answer.
    if (url.includes('/api/calendar/indexers')) {
      return ok({ indexers: [] })
    }
    if (url.includes('/api/calendar/destinations')) {
      return ok({ folders: ['/mnt/peliculas'], arr_available: true, detail: '' })
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

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

const panel = () => screen.getByRole('region', { name: 'Panel de detalle' })

/** The pane row whose text contains `title`, as the pane rendered it. */
const rowOf = (title: string) =>
  Array.from(document.querySelectorAll('.sec-row')).find((row) =>
    row.textContent?.includes(title),
  ) as HTMLElement

const callsMatching = (fn: FetchMock, needle: string) =>
  fn.mock.calls.filter(([input]) => String(input).includes(needle))

describe('sections · PR 6 — the detail tabs', () => {
  let fn: FetchMock

  beforeEach(() => {
    window.location.hash = ''
    fn = stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the panel empty on every tab until something is selected', async () => {
    renderSection(Peliculas)
    await screen.findByText('Sin Pedido')

    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))

    expect(
      screen.getByText('Selecciona un elemento de la lista para ver su detalle.'),
    ).toBeInTheDocument()
    expect(callsMatching(fn, '/api/files/browse')).toHaveLength(0)
  })

  it('Películas · Archivos lists the selected row folder, read-only', async () => {
    renderSection(Peliculas)
    await screen.findByText('Sin Pedido')

    fireEvent.click(rowOf('Your Name.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))

    // The listing is browsePath on the row's OWN path…
    await screen.findByText('Your.Name.2016.mkv')
    expect(
      callsMatching(fn, `/api/files/browse?path=${encodeURIComponent(CATALOG_PATH)}`),
    ).toHaveLength(1)

    // …with only columns the response actually carries.
    expect(screen.getByRole('columnheader', { name: 'Nombre' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Tamaño' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Modificado' })).toBeInTheDocument()
    expect(screen.getByText('11.2 GB')).toBeInTheDocument()
    // A directory carries size 0 from the endpoint: shown as "—", not "0 B".
    expect(screen.getByText('subs')).toBeInTheDocument()

    // Read-only: rename/delete/copy are NOT in this tab (they stay in the
    // Archivos page until it is retired).
    expect(
      within(panel()).queryByRole('button', { name: /Renombrar|Eliminar|Copiar/ }),
    ).toBeNull()
  })

  it('Películas · Archivos says the entry has no path instead of guessing one', async () => {
    renderSection(Peliculas)
    await screen.findByText('Sin Pedido')

    fireEvent.click(screen.getByRole('tab', { name: 'Faltantes' }))
    await screen.findByText('Todo a la vez en todas partes')
    fireEvent.click(rowOf('Todo a la vez'))
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))

    // The queue's payload carries no path — the tab says exactly that, and
    // does not go browsing through a path it does not have.
    expect(await screen.findByText('Esta entrada no tiene ruta')).toBeInTheDocument()
    expect(callsMatching(fn, '/api/files/browse')).toHaveLength(0)
  })

  it('Películas · Archivos surfaces what browse answers when the path is a file', async () => {
    stubFetch({
      browse: { ok: false, error: 'No es un directorio', items: [], path: '/peliculas/movie.mkv' },
    })
    renderSection(Peliculas)
    await screen.findByText('Sin Pedido')

    fireEvent.click(rowOf('Your Name.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))

    // The endpoint's own words, as an error — never an empty listing that
    // reads as "this folder has no files".
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No es un directorio')
    expect(screen.queryByRole('columnheader', { name: 'Nombre' })).not.toBeInTheDocument()
  })

  it('Películas · Archivos reports a failed fetch as an error, not an empty list', async () => {
    stubFetch({ browseReject: true })
    renderSection(Peliculas)
    await screen.findByText('Sin Pedido')

    fireEvent.click(rowOf('Your Name.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo leer la ruta')
    expect(alert).toHaveTextContent('red caída')
    expect(screen.queryByRole('columnheader', { name: 'Nombre' })).not.toBeInTheDocument()
  })

  it('Películas · Historial reads the row’s own grab record in es-ES', async () => {
    renderSection(Peliculas)
    await screen.findByText('Sin Pedido')

    fireEvent.click(rowOf('Your Name.'))
    fireEvent.click(screen.getByRole('button', { name: 'Historial' }))

    // Grabbed_at formatted the Spanish way, grabbed_destination in full.
    expect(screen.getByText(new Date(GRABBED_AT * 1000).toLocaleDateString('es-ES'))).toBeInTheDocument()
    expect(screen.getByText('/mnt/peliculas/_manual')).toBeInTheDocument()

    // The app's own record ONLY: the global auto-copy log is never asked.
    expect(callsMatching(fn, '/api/auto-copy/history')).toHaveLength(0)
  })

  it('Películas · Historial says the app never asked when the row carries no grab', async () => {
    renderSection(Peliculas)
    await screen.findByText('Sin Pedido')

    fireEvent.click(rowOf('Sin Pedido'))
    fireEvent.click(screen.getByRole('button', { name: 'Historial' }))

    expect(await screen.findByText('Nunca se pidió desde la app')).toBeInTheDocument()
    expect(callsMatching(fn, '/api/auto-copy/history')).toHaveLength(0)
  })

  it('Series · Episodios lists the series’ episodes, only what the payload carries', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(rowOf('Some Show'))
    fireEvent.click(screen.getByRole('button', { name: 'Episodios' }))

    expect(
      await screen.findByText('S03E07'),
    ).toBeInTheDocument()
    expect(callsMatching(fn, '/api/wanted/series/3/episodes')).toHaveLength(1)
    expect(screen.getByText('Of Ice Men')).toBeInTheDocument()
    expect(screen.getByText('2006-11-27')).toBeInTheDocument()
    // The response has no has_file field, so the tab invents no such column.
    expect(
      screen.queryByRole('columnheader', { name: /archivo/i }),
    ).not.toBeInTheDocument()
  })

  it('Series · Episodios is honest when the entry names no series', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(screen.getByRole('tab', { name: 'Faltantes' }))
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))
    fireEvent.click(screen.getByRole('button', { name: 'Episodios' }))

    expect(
      await screen.findByText('Esta entrada no tiene serie asociada'),
    ).toBeInTheDocument()
    expect(callsMatching(fn, '/api/wanted/series/3/episodes')).toHaveLength(0)
  })

  it('Series · Archivos browses the series folder and Historial reads its record', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(rowOf('Some Show'))
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))
    await screen.findByText('Your.Name.2016.mkv')
    expect(
      callsMatching(fn, `/api/files/browse?path=${encodeURIComponent('/series/Some Show')}`),
    ).toHaveLength(1)

    // A grab with no destination went to the arr's library — the tab says so.
    fireEvent.click(screen.getByRole('button', { name: 'Historial' }))
    expect(
      screen.getByText(new Date(GRABBED_AT * 1000).toLocaleDateString('es-ES')),
    ).toBeInTheDocument()
    expect(screen.getByText('Biblioteca del arr')).toBeInTheDocument()
  })
})

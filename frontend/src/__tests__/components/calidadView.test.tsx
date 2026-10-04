import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../components/Peliculas'
import { Series } from '../../components/Series'

/**
 * PR 4 of F-08: the Calidad sub-view is a real, class-filterable list.
 *
 * What these guard is the honesty contract the view is built on: a class is
 * only ever read from a fact (Radarr's file quality for movies, the folder
 * for series), an unknown fact reads as unknown, and a failed or unconfigured
 * fetch never renders as "nothing is in any class".
 */

const movie4k = {
  id: 1, title: '4K Movie', year: 2020, remotePoster: '', has_file: true,
  path: '/movies/4K Movie (2020)', path_exists: true, monitored: true,
  quality: 'Bluray-2160p', grabbed_at: null, grabbed_destination: null,
}
const movie3d = {
  id: 2, title: '3D Movie', year: 2021, remotePoster: '', has_file: true,
  path: '/mnt/3d/3D Movie (2021)', path_exists: true, monitored: true,
  quality: 'Bluray-1080p', grabbed_at: null, grabbed_destination: null,
}
const movieLib = {
  id: 3, title: 'Library Movie', year: 2019, remotePoster: '', has_file: true,
  path: '/movies/Library Movie (2019)', path_exists: true, monitored: true,
  quality: 'WEBDL-1080p', grabbed_at: null, grabbed_destination: null,
}
const movieUnknown = {
  id: 4, title: 'Unknown Movie', year: 2026, remotePoster: '', has_file: false,
  path: '/movies/Unknown Movie (2026)', path_exists: true, monitored: true,
  quality: '', grabbed_at: null, grabbed_destination: null,
}

const series4k = {
  id: 11, title: 'Show in 4K', year: 2022, remotePoster: '', has_file: true,
  path: '/mnt/4k/Show in 4K', path_exists: true, monitored: true,
  episode_count: 10, episode_file_count: 10, grabbed_at: null, grabbed_destination: null,
}
const series3d = {
  id: 12, title: 'Show in 3D', year: 2021, remotePoster: '', has_file: true,
  path: '/mnt/3d/Show in 3D', path_exists: true, monitored: true,
  episode_count: 8, episode_file_count: 4, grabbed_at: null, grabbed_destination: null,
}
const seriesLib = {
  id: 13, title: 'Show in library', year: 2018, remotePoster: '', has_file: true,
  path: '/series/Show in library', path_exists: true, monitored: true,
  episode_count: 20, episode_file_count: 20, grabbed_at: null, grabbed_destination: null,
}

function ok(body: unknown, status = 200) {
  return Promise.resolve({ ok: status === 200, status, json: async () => body } as Response)
}

interface StubOpts {
  movies?: unknown[]
  series?: unknown[]
  /** The `error` field the listing carries (arr failure / not configured). */
  moviesError?: string
  seriesError?: string
  /** null makes GET /api/settings itself fail. */
  folders?: { path_4k?: string; path_3d?: string } | null
}

function stubFetch(opts: StubOpts = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/settings')) {
        if (opts.folders === null) return ok({ detail: 'boom' }, 500)
        return ok({ paths: opts.folders ?? { path_4k: '/mnt/4k', path_3d: '/mnt/3d' } })
      }
      if (url.includes('/api/wanted/series/all')) {
        const items = opts.series ?? []
        return ok({
          items,
          total: items.length,
          page: 1,
          page_size: 0,
          ...(opts.seriesError ? { error: opts.seriesError, error_kind: 'unknown' } : {}),
        })
      }
      if (url.includes('/api/wanted/all')) {
        const items = opts.movies ?? []
        return ok({
          items,
          total: items.length,
          page: 1,
          page_size: 0,
          ...(opts.moviesError ? { error: opts.moviesError, error_kind: 'unknown' } : {}),
        })
      }
      if (url.includes('/api/wanted?')) {
        return ok({
          wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [], total: 0 } },
          updated_at: 0,
        })
      }
      return ok({})
    }),
  )
}

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

/** Opens the Calidad sub-view and waits for its folder-derived chrome. */
async function openCalidad() {
  fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))
  await screen.findByRole('group', { name: 'Filtrar por clase' })
}

// Scoped to the table: the detail panel repeats the title as its heading,
// and the row must be found without ambiguity.
const rowOf = (title: string) =>
  within(screen.getByRole('table')).getByText(title).closest('tr') as HTMLElement
const panel = () => screen.getByRole('region', { name: 'Panel de detalle' })

/** The row's cells in column order: Título, Año, Clase, Calidad, Ruta, Enrutado. */
const cellsOf = (title: string) => within(rowOf(title)).getAllByRole('cell')

describe('Películas · Calidad', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch({ movies: [movie4k, movie3d, movieLib, movieUnknown] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('classes each movie from its file quality and its folder', async () => {
    renderSection(Peliculas)
    await openCalidad()
    await screen.findByText('4K Movie')

    // 2160p → 4K; a movie living in path_3d → 3D (3D outranks resolution);
    // any other known quality → en biblioteca; no quality → desconocida.
    expect(within(rowOf('4K Movie')).getByText('4K')).toBeInTheDocument()
    expect(within(rowOf('3D Movie')).getByText('3D')).toBeInTheDocument()
    expect(within(rowOf('Library Movie')).getByText('en biblioteca')).toBeInTheDocument()
    expect(within(rowOf('Unknown Movie')).getByText('desconocida')).toBeInTheDocument()

    // The unknown quality cell reads "—", never a guessed name.
    expect(cellsOf('Unknown Movie')[3]).toHaveTextContent('—')
    // The folder fact is shown independently of the class chip: the 3D movie
    // says path_3d, and the 4K-class movie that lives in the library folder
    // honestly says it is in neither routing folder.
    expect(cellsOf('3D Movie')[5]).toHaveTextContent('path_3d')
    expect(cellsOf('4K Movie')[5]).toHaveTextContent('—')
  })

  it('filters the rows with the class chips', async () => {
    renderSection(Peliculas)
    await openCalidad()
    await screen.findByText('4K Movie')

    fireEvent.click(screen.getByRole('button', { name: '4K (1)' }))

    expect(rowOf('4K Movie')).toBeInTheDocument()
    expect(screen.queryByText('Library Movie')).not.toBeInTheDocument()
    expect(screen.queryByText('Unknown Movie')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Todas (4)' }))
    expect(screen.getByText('Library Movie')).toBeInTheDocument()
  })

  it('fills the detail panel with the selected row’s own data', async () => {
    renderSection(Peliculas)
    await openCalidad()
    await screen.findByText('Library Movie')

    fireEvent.click(rowOf('Library Movie'))

    expect(within(panel()).getByRole('heading', { name: 'Library Movie' })).toBeInTheDocument()
    expect(within(panel()).getByText('en biblioteca')).toBeInTheDocument()
    expect(within(panel()).getByText('WEBDL-1080p')).toBeInTheDocument()
    expect(within(panel()).getByText('/movies/Library Movie (2019)')).toBeInTheDocument()
    expect(rowOf('Library Movie')).toHaveAttribute('aria-current', 'true')
  })

  it('shows an honest empty state when the catalogue has no titles', async () => {
    stubFetch({ movies: [] })
    renderSection(Peliculas)
    await openCalidad()

    expect(await screen.findByText('No hay películas en el catálogo')).toBeInTheDocument()
    // The filter still exists: the emptiness is the catalogue's, not a failure.
    expect(screen.getByRole('button', { name: 'Todas (0)' })).toBeInTheDocument()
  })

  it('reports a failed fetch as an error, never as an empty class', async () => {
    stubFetch({ movies: [], moviesError: 'radarr: no respondió a tiempo' })
    renderSection(Peliculas)
    fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo consultar Radarr')
    expect(alert).toHaveTextContent('radarr: no respondió a tiempo')
    expect(screen.queryByText('No hay películas en el catálogo')).not.toBeInTheDocument()
  })

  it('says when Radarr was never configured, not that nothing is 4K', async () => {
    stubFetch({ movies: [], moviesError: 'radarr: servicio no configurado' })
    renderSection(Peliculas)
    fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('radarr: servicio no configurado')
    expect(screen.queryByText('No hay películas en el catálogo')).not.toBeInTheDocument()
  })

  it('refuses to classify anything when the folder settings cannot be read', async () => {
    stubFetch({ movies: [movie4k], folders: null })
    renderSection(Peliculas)
    fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo leer la configuración de carpetas')
    expect(screen.queryByText('4K Movie')).not.toBeInTheDocument()
  })
})

describe('Series · Calidad', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch({ series: [series4k, series3d, seriesLib] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('classes each series by the folder it lives in', async () => {
    renderSection(Series)
    await openCalidad()
    await screen.findByText('Show in 4K')

    expect(within(rowOf('Show in 4K')).getByText('4K')).toBeInTheDocument()
    expect(within(rowOf('Show in 3D')).getByText('3D')).toBeInTheDocument()
    expect(within(rowOf('Show in library')).getByText('en biblioteca')).toBeInTheDocument()
    expect(cellsOf('Show in 4K')[5]).toHaveTextContent('path_4k')

    // Sonarr's list carries no quality: the cell says unknown, always.
    for (const title of ['Show in 4K', 'Show in 3D', 'Show in library']) {
      expect(cellsOf(title)[3]).toHaveTextContent('—')
    }
  })

  it('says the class comes from the folder, not from a Sonarr quality', async () => {
    renderSection(Series)
    await openCalidad()

    expect(
      screen.getByText(/la lista de Sonarr no trae la calidad por episodio/),
    ).toBeInTheDocument()
    expect(screen.getByText(/no es un juicio de calidad como el de Radarr/)).toBeInTheDocument()
  })

  it('fills the detail panel with the selected series’ own data', async () => {
    renderSection(Series)
    await openCalidad()
    await screen.findByText('Show in 4K')

    fireEvent.click(rowOf('Show in 4K'))

    expect(within(panel()).getByRole('heading', { name: 'Show in 4K' })).toBeInTheDocument()
    expect(within(panel()).getByText('/mnt/4k/Show in 4K')).toBeInTheDocument()
    const clase = within(panel()).getByText('Clase')
    expect(clase.nextElementSibling).toHaveTextContent('4K')
    expect(rowOf('Show in 4K')).toHaveAttribute('aria-current', 'true')
  })

  it('says when Sonarr was never configured, not that nothing is 4K', async () => {
    stubFetch({ series: [], seriesError: 'sonarr: servicio no configurado' })
    renderSection(Series)
    fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('sonarr: servicio no configurado')
    expect(screen.queryByText('No hay series en el catálogo')).not.toBeInTheDocument()
  })

  it('shows an honest empty state when the catalogue has no titles', async () => {
    stubFetch({ series: [] })
    renderSection(Series)
    await openCalidad()

    expect(await screen.findByText('No hay series en el catálogo')).toBeInTheDocument()
  })
})

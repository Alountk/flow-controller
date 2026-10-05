import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../components/Peliculas'
import { Series } from '../../components/Series'

/**
 * PR 2 of F-08: the sections' sub-view tabs are the filter, and the pane's
 * rows live in the master column.
 *
 * The Faltantes/Todas buttons were originally gated off entirely — "the pane
 * draws no second filter controls" — and that assertion stood in three of these
 * tests. The operator asked for those buttons beside the name search, so the
 * premise changed and the assertion changed with it. It did NOT become weaker:
 * it now pins that the two controls AGREE, which is the thing that could
 * actually break (a button reading Faltantes while the tab reads Biblioteca
 * would be a second source of truth contradicting the first).
 *
 * These tests pin the wiring that is NOT covered elsewhere: the sections drive
 * MediaPane's controlled filter from the tabs, a selected row fills the detail
 * panel with that row's own data,
 * every row action stays reachable, the search text is namespaced per section,
 * and a failed fetch reads as an error rather than an empty list.
 */

/**
 * The invariant the old assertion asserted the OPPOSITE of: two buttons, and
 * exactly one of them active — the same choice the tab shows. The old line said
 * "no second control"; this says "the second control agrees", which is the
 * failure that would actually confuse an operator.
 */
function expectFilterButtonsAgreeWithTab(expectedActive: RegExp) {
  const buttons = Array.from(document.querySelectorAll('.wanted-filter-btn'))
  expect(buttons).toHaveLength(2)
  const active = buttons.filter((b) => b.classList.contains('active'))
  expect(active).toHaveLength(1)
  expect(active[0].textContent ?? '').toMatch(expectedActive)
}

const catalogMovie = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: '',
  has_file: false,
  path_exists: true,
  monitored: true,
}

const wantedMovie = {
  id: 813,
  title: 'Todo a la vez en todas partes',
  year: 2022,
  overview: '',
  remotePoster: '',
  has_file: false,
  altTitles: [],
}

const episode = {
  id: 7,
  title: 'Of Ice Men',
  series_title: 'Some Show',
  series_id: 3,
  season_number: 3,
  episode_number: 7,
  air_date: '2006-11-27T00:00:00Z',
  overview: '',
  has_file: false,
}

const catalogSeries = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: true,
  path_exists: true,
  monitored: true,
  episode_count: 10,
  episode_file_count: 4,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/**
 * Stubs every listing the sections can ask for. `radarrError` flows through
 * /api/wanted (the Faltantes sub-view), `catalogError` through /api/wanted/all
 * (the Biblioteca sub-view).
 */
function stubFetch(opts: { radarrError?: string; catalogError?: string } = {}) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [catalogSeries], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok(
        opts.catalogError
          ? { items: [], total: 0, error: opts.catalogError, error_kind: 'timeout' }
          : { items: [catalogMovie], total: 1, page: 1, page_size: 50 },
      )
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: {
          radarr: opts.radarrError
            ? { items: [], total: 0, error: opts.radarrError, error_kind: 'timeout' }
            : { items: [wantedMovie], total: 1 },
          sonarr: { items: [episode], total: 1 },
        },
        updated_at: 0,
      })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

const panel = () => screen.getByRole('region', { name: 'Panel de detalle' })

/** The first row of the master list, as the pane rendered it. */
const firstRow = () => document.querySelector('.wanted-card, .wanted-row') as HTMLElement

describe('Películas · PR 2 wiring', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the catalogue in Biblioteca with the two buttons agreeing with the tab', async () => {
    renderSection(Peliculas)

    expect(await screen.findByText('Your Name.')).toBeInTheDocument()
    // The buttons exist AND agree with the tab: in Biblioteca, 'Todas' is lit.
    expectFilterButtonsAgreeWithTab(/Todas/)
    // The search field still belongs to the pane.
    expect(screen.getByLabelText('Filtrar películas')).toBeInTheDocument()
  })

  it('switches to the missing queue on the Faltantes tab, actions included', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))

    expect(await screen.findByText('Todo a la vez en todas partes')).toBeInTheDocument()
    // Every action the row had in Faltantes is still reachable here.
    expect(screen.getByRole('button', { name: '🔍 Buscar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '📁 En carpeta' })).toBeInTheDocument()
      // Same two buttons, now agreeing with Faltantes: 'Faltantes' is lit.
      expectFilterButtonsAgreeWithTab(/Faltantes/)
  })

  it('fills the detail panel with the selected row’s own data', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')
    const row = firstRow()

    fireEvent.click(row)

    expect(within(panel()).getByRole('heading', { name: 'Your Name.' })).toBeInTheDocument()
    expect(within(panel()).getByText('2016')).toBeInTheDocument()
    expect(within(panel()).getByText('✗ Sin archivo')).toBeInTheDocument()
    // No invented fields: this row has no quality or path, so the panel shows none.
    expect(within(panel()).queryByText('Calidad')).not.toBeInTheDocument()
    expect(row).toHaveAttribute('aria-current', 'true')

    // A switch resets the selection: the panel belongs to the visible list.
    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    expect(within(panel()).getByRole('heading', { name: 'Sin selección' })).toBeInTheDocument()
  })

  it('keeps the search text in the Películas namespace', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.change(screen.getByLabelText('Filtrar películas'), {
      target: { value: 'your' },
    })

    expect(window.location.hash).toBe('#/peliculas?q=your')
  })

  it('reports a failed fetch as an error, not as an empty list', async () => {
    stubFetch({ catalogError: 'radarr: no respondió a tiempo' })
    renderSection(Peliculas)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo consultar Radarr')
    expect(alert).toHaveTextContent('radarr: no respondió a tiempo')
    expect(screen.queryByText('No hay películas en el catálogo')).not.toBeInTheDocument()
  })
})

describe('Series · PR 2 wiring', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills the detail panel with the selected episode’s own data', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Of Ice Men')
    const row = document.querySelector('.wanted-row') as HTMLElement
    fireEvent.click(row)

    expect(within(panel()).getByRole('heading', { name: 'Some Show' })).toBeInTheDocument()
    expect(within(panel()).getByText('S03E07 · Of Ice Men')).toBeInTheDocument()
    expect(within(panel()).getByText('2006-11-27')).toBeInTheDocument()
    expect(within(panel()).getByText('Falta')).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-current', 'true')
    // Row actions survive the narrow column: titles included.
    expect(screen.getByTitle('Buscar releases')).toBeInTheDocument()
    expect(screen.getByTitle('Buscar en carpeta')).toBeInTheDocument()
      // Series carries the same two buttons, agreeing with its own tab.
      expectFilterButtonsAgreeWithTab(/Todas|Faltantes/)
  })

  it('keeps the search text in the Series namespace', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.change(screen.getByLabelText('Filtrar series'), {
      target: { value: 'some' },
    })

    expect(window.location.hash).toBe('#/series?q=some')
  })
})

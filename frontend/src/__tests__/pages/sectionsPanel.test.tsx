import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../pages/Peliculas.tsx'
import { Series } from '../../pages/Series.tsx'
import type { Release } from '../../shared/api/releases.ts'

/**
 * PR 5 of F-08, the two halves the maintainer called out:
 *
 * 1. The sections' rows take the chosen prototype's shape — mini-poster,
 *    status pill, quality chip, path — pinned describe by describe below.
 * 2. The release search leaves the modal: in the sections it renders inline
 *    in the detail panel's Releases tab, and a grab started there reaches the
 *    wire. The overlay's own behaviour is pinned in ReleaseSearchModal.test;
 *    what is pinned here is the ROUTING — sections → panel.
 */

const catalogMovie = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: 'https://img.example/your-name.jpg',
  has_file: true,
  path: '/peliculas/Your Name. (2016)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-2160p',
  grabbed_at: null,
  grabbed_destination: null,
}

const wantedMovie = {
  id: 813,
  title: 'Todo a la vez en todas partes',
  year: 2022,
  overview: '',
  remotePoster: 'https://img.example/eeaao.jpg',
  has_file: false,
  altTitles: [],
  grabbed_at: null,
  grabbed_destination: null,
}

/** A second missing title: the search-contract tests drive THIS row so they
 *  always meet a panel with no cached results of its own — the module-level
 *  panel cache keys results per item, and each test needs a fresh one. */
const secondWanted = {
  id: 902,
  title: 'Otra Película Sin Archivo',
  year: 2021,
  overview: '',
  remotePoster: '',
  has_file: false,
  altTitles: [],
  grabbed_at: null,
  grabbed_destination: null,
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
  episode_count: 10,
  episode_file_count: 4,
  grabbed_at: null,
  grabbed_destination: null,
}

const release: Release = {
  guid: 'rel-1',
  title: 'Your.Name.2016.2160p.BluRay.x265',
  size: 12_000_000_000,
  quality: 'Bluray-2160p',
  indexer: 'aMuTorrent',
  indexerId: 1,
  indexerFlags: '',
  seeders: 20,
  leechers: 2,
  protocol: 'torrent',
  releaseGroup: '',
  languages: ['Spanish'],
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** Every listing the sections and the pane can ask for, plus the release
 *  search's own endpoints so the inline panel can run end to end. */
function stubFetch() {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [catalogSeries], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [catalogMovie], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: {
          radarr: { items: [wantedMovie, secondWanted], total: 2 },
          sonarr: { items: [episode], total: 1 },
        },
        updated_at: 0,
      })
    }
    if (url.includes('/api/calendar/indexers')) {
      return ok({
        indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
      })
    }
    if (url.includes('/api/calendar/destinations')) {
      return ok({ folders: ['/mnt/peliculas'], arr_available: true, detail: '' })
    }
    if (url.includes('/api/calendar/releases')) {
      return ok({ releases: [release], detail: '1 releases encontrados' })
    }
    if (url.includes('/api/calendar/grab')) {
      return ok({ ok: true, detail: 'Descarga iniciada', downloaded: [], errors: [] })
    }
    if (url.includes('/api/calendar?')) {
      return ok({ items: [], start: '2026-10-01', end: '2026-11-01' })
    }
    if (url.includes('/api/settings')) {
      return ok({ paths: { path_4k: '', path_3d: '' } })
    }
    void init
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof stubFetch>

/** Every grab request body, in order. */
function grabBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes('/api/calendar/grab'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
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

/** The first row the pane rendered in the master column. */
const firstRow = () => document.querySelector('.sec-row') as HTMLElement

const inlineSearch = () => document.querySelector('.release-inline')

describe('sections · the prototype rows', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('draws the dense row: mini-poster, status pill, quality chip and path', async () => {
    renderSection(Peliculas)

    expect(await screen.findByText('Your Name.')).toBeInTheDocument()
    const row = firstRow()
    expect(row.classList.contains('wanted-card')).toBe(true)

    // The mini-poster layers the row's real poster over the initials, which
    // stay in the DOM as the load/error fallback and as the box's text.
    const poster = row.querySelector('.sec-row-poster')
    expect(poster?.textContent).toBe('YN')
    const img = poster?.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('https://img.example/your-name.jpg')

    expect(row.querySelector('.sec-row-name')?.textContent).toBe('Your Name.')
    expect(row.querySelector('.sec-row-year')?.textContent).toBe('2016')
    expect(row.querySelector('.sec-pill')?.textContent).toBe('En biblioteca')
    expect(row.querySelector('.sec-q-tag')?.textContent).toBe('Bluray-2160p')
    expect(row.querySelector('.sec-row-path')?.textContent).toBe('/peliculas/Your Name. (2016)')

    // Selection wiring survived the restyle.
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(within(panel()).getByRole('heading', { name: 'Your Name.' })).toBeInTheDocument()
  })

  it('labels the missing row Falta and claims nothing the data cannot back', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Todo a la vez en todas partes')
    const row = firstRow()

    expect(row.querySelector('.sec-pill')?.textContent).toBe('Falta')
    // A wanted row carries no file: no quality chip, no path — not dashes,
    // not guesses.
    expect(row.querySelector('.sec-q-tag')).toBeNull()
    expect(row.querySelector('.sec-row-path')).toBeNull()
  })

  it('renders the episode row in Series with its code, title and date', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Of Ice Men')
    const row = firstRow()

    expect(row.classList.contains('wanted-row')).toBe(true)
    expect(row.querySelector('.sec-row-name')?.textContent).toBe('Some Show')
    expect(row.querySelector('.sec-pill')?.textContent).toBe('Falta')
    expect(row.querySelector('.sec-row-ep')?.textContent).toBe('S03E07')
    expect(row.querySelector('.sec-row-ep-title')?.textContent).toBe('Of Ice Men')
    expect(row.querySelector('.sec-row-date')?.textContent).toBe('2006-11-27')
    // The icon actions keep their titles: they are what the row offers.
    expect(row.querySelector('button[title="Buscar releases"]')).not.toBeNull()
    expect(row.querySelector('button[title="Buscar en carpeta"]')).not.toBeNull()
  })
})

describe('sections · the release search in the panel', () => {
  let fn: FetchMock

  beforeEach(() => {
    window.location.hash = ''
    fn = stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills the panel inline for the selected row — no backdrop, no Escape', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.click(firstRow())

    await waitFor(() => expect(inlineSearch()).not.toBeNull())
    // Inline means inline: the panel never opens an overlay for itself.
    expect(document.querySelector('.scan-modal-backdrop')).toBeNull()
    expect(panel().contains(inlineSearch() as Node)).toBe(true)
  })

  it('routes the row’s 🔍 action to the panel instead of a modal', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    fireEvent.click(screen.getByRole('button', { name: '🔍 Buscar' }))

    // The click bubbles to the row (which selects it) and the panel shows the
    // Releases tab's search for that selection. No modal per row.
    await waitFor(() => expect(inlineSearch()).not.toBeNull())
    expect(document.querySelector('.scan-modal-backdrop')).toBeNull()
    expect(firstRow()).toHaveAttribute('aria-current', 'true')
  })

  it('drives a grab from the Releases tab end to end', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    // A missing title: a catalogue movie that already has a file honestly
    // answers "ya tiene archivo" instead of offering a search — the row this
    // test picks is a wanted one, which lands the panel on its own 🔍
    // Buscar Releases button.
    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Todo a la vez en todas partes')
    fireEvent.click(firstRow())

    // The press is what reaches the results (selection searched nothing),
    // and once they are on screen the initial step's button is not drawn
    // at all — the list and its counter are the proof the press ran.
    expect(await screen.findByRole('button', { name: /Buscar Releases/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(screen.queryByRole('button', { name: /Buscar Releases/ })).toBeNull()
    expect(screen.getByText('1 releases encontrados')).toBeInTheDocument()

    // The three destination buttons are what the row offers now (F-12):
    // there is no separate "Acción principal" readout to check — the row
    // itself shows where the press would go.
    expect(within(panel()).getByRole('button', { name: /Biblioteca/ })).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: /4K/ })).toBeInTheDocument()

    fireEvent.click(within(panel()).getByRole('button', { name: /Biblioteca/ }))

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0]).toMatchObject({
      source: 'radarr',
      guid: 'rel-1',
      movieId: 813,
      episodeId: 0,
      quality: 'Bluray-2160p',
    })
    await screen.findByText(/Descarga iniciada/)
    // The grab never left the panel: no backdrop was ever opened.
    expect(document.querySelector('.scan-modal-backdrop')).toBeNull()
  })

  it('searches only on the press and on an indexer change — never on selection, never on re-open', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    const searchCalls = () =>
      fn.mock.calls.filter(([input]) => String(input).includes('/api/calendar/releases')).length

    // Trigger 1: SELECTION. The Releases view mounts for a title with
    // nothing to show and sits on the initial step — the operator's press
    // is the only way the first search starts.
    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Otra Película Sin Archivo')
    fireEvent.click(screen.getByText('Otra Película Sin Archivo'))
    expect(await screen.findByRole('button', { name: /Buscar Releases/ })).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(searchCalls()).toBe(0)

    // Trigger 2: the 🔍 press. Exactly one search, and the results it
    // returned are what the rest of this test drives.
    fireEvent.click(screen.getByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(searchCalls()).toBe(1)

    // Trigger 3: picking an indexer re-runs it — exactly one NEW search,
    // under the newly chosen value (and the select is labelled for
    // assistive tech, so the change is addressable by role). Not before:
    // the count was 1 through both triggers above.
    const indexerSelect = screen.getByRole('combobox', { name: /Indexador/ }) as HTMLSelectElement
    const next = indexerSelect.value === 'all' ? '1' : 'all'
    fireEvent.change(indexerSelect, { target: { value: next } })
    await waitFor(() => expect(searchCalls()).toBe(2))
    await screen.findByPlaceholderText('Filtrar por título...')

    // The guarantee: a tab switch unmounts the view, and coming back must
    // restore THIS item's results — a search that already returned never
    // runs again just because the panel was rebuilt around it.
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))
    expect(inlineSearch()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }))

    await screen.findByPlaceholderText('Filtrar por título...')
    expect(searchCalls()).toBe(2)
    expect(screen.getByText('1 releases encontrados')).toBeInTheDocument()

    // Selection as a concept is gone (F-12): the rows carry their own
    // destination buttons, and — the contract this test always guarded —
    // neither searching nor rendering them has fired a single grab.
    expect(within(panel()).getByRole('button', { name: /Biblioteca/ })).toBeInTheDocument()
    expect(grabBodies(fn)).toHaveLength(0)
  })

  it('keeps the panel honest when nothing is selected', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    // Selecting brings the inline search with it…
    fireEvent.click(firstRow())
    await waitFor(() => expect(inlineSearch()).not.toBeNull())

    // …and a sub-view switch resets the selection, which takes the search
    // back to the panel's honest empty state.
    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))

    await waitFor(() => expect(inlineSearch()).toBeNull())
    expect(
      screen.getByText('Selecciona un elemento de la lista para ver su detalle.'),
    ).toBeInTheDocument()
  })
})

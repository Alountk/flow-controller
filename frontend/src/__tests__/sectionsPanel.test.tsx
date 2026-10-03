import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../components/Peliculas'
import { Series } from '../components/Series'
import { MissingContent } from '../components/MissingContent'
import type { Release } from '../api/calendar'

/**
 * PR 5 of F-08, the two halves the maintainer called out:
 *
 * 1. The sections' rows take the chosen prototype's shape — mini-poster,
 *    status pill, quality chip, path — and ONLY the sections: the Faltantes
 *    page keeps the cards it had, down to the markup.
 * 2. The release search leaves the modal: in the sections it renders inline
 *    in the detail panel's Releases tab, and a grab started there reaches the
 *    wire. The overlay's own behaviour is pinned in ReleaseSearchModal.test;
 *    what is pinned here is the ROUTING — sections → panel, page → overlay.
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
          radarr: { items: [wantedMovie], total: 1 },
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

    // The mini-poster is CSS-drawn initials: no external image on the row,
    // even though this row's data carries one for the detail panel.
    const poster = row.querySelector('.sec-row-poster')
    expect(poster?.textContent).toBe('YN')
    expect(row.querySelector('img')).toBeNull()

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

    fireEvent.click(screen.getByRole('tab', { name: 'Faltantes' }))
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

    fireEvent.click(screen.getByRole('tab', { name: 'Faltantes' }))
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

  it('leaves the Faltantes page rows exactly as they were', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MissingContent />
      </QueryClientProvider>,
    )

    await screen.findByText('Todo a la vez en todas partes')

    // The prototype row exists ONLY under the sections: no mini-poster, no
    // chips, no path anywhere on the page surface.
    expect(document.querySelector('.sec-row')).toBeNull()
    expect(document.querySelector('.sec-row-poster')).toBeNull()
    expect(document.querySelector('.sec-q-tag')).toBeNull()

    const card = document.querySelector('.wanted-card') as HTMLElement
    expect(card.querySelector('img.wanted-poster')).not.toBeNull()
    expect(card.querySelector('.wanted-card-actions button')).not.toBeNull()

    // …and the page's search action still opens the OVERLAY, not the panel.
    fireEvent.click(screen.getByRole('button', { name: '🔍 Buscar' }))
    expect(document.querySelector('.scan-modal-backdrop')).not.toBeNull()
    expect(document.querySelector('.release-inline')).toBeNull()
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
    // answers "ya tiene archivo" instead of offering a search.
    fireEvent.click(screen.getByRole('tab', { name: 'Faltantes' }))
    await screen.findByText('Todo a la vez en todas partes')
    fireEvent.click(firstRow())
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

    // Results arrive inside the panel — the filter bar is the proof.
    await screen.findByPlaceholderText('Filtrar por título...')
    expect(screen.getByText('1 releases encontrados')).toBeInTheDocument()

    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

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

  it('keeps the panel honest when nothing is selected', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')

    // Selecting brings the inline search with it…
    fireEvent.click(firstRow())
    await waitFor(() => expect(inlineSearch()).not.toBeNull())

    // …and a sub-view switch resets the selection, which takes the search
    // back to the panel's honest empty state.
    fireEvent.click(screen.getByRole('tab', { name: 'Faltantes' }))

    await waitFor(() => expect(inlineSearch()).toBeNull())
    expect(
      screen.getByText('Selecciona un elemento de la lista para ver su detalle.'),
    ).toBeInTheDocument()
  })
})

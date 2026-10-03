import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../components/Peliculas'
import { Series } from '../components/Series'
import { Calendar } from '../components/Calendar'

/**
 * PR 5's last gap: a calendar card inside a section SELECTS — the detail
 * panel takes the click exactly like a pane row does, and no overlay ever
 * opens from Estrenos. estrenosCalendar's rewritten tests pin the selection
 * itself and the corrected panel note; what is pinned HERE:
 *
 * 1. Both sections: the movie/episode selection reaches the panel on the
 *    Releases tab a view switch already resets it to, and the release search
 *    receives the calendar item's own identity.
 * 2. The panel's tabs stay HONEST for a calendar item: its grab record is
 *    read from the CalendarItem, and what the item does NOT carry (path,
 *    series id) says so instead of reporting the row unreadable — the lie
 *    `{state: 'missing'}` would have told.
 * 3. EVERY card selects — a title that already has its file too.
 * 4. A standalone Calendar (no onSelect) keeps the overlay it always had.
 */

// Noon UTC on 19 September 2026, so the local date is the same in any timezone.
const GRABBED_AT = Date.UTC(2026, 8, 19, 12, 0, 0) / 1000

const movie = {
  type: 'movie',
  id: 855,
  title: 'Estreno de Película',
  date: '2026-10-05',
  year: 2026,
  has_file: false,
  remotePoster: '',
  series_title: null,
  season_number: null,
  episode_number: null,
  source: 'radarr',
  grabbed_at: null,
  grabbed_destination: null,
}

/** The same movie, already on disk: its card must select just like the rest. */
const movieWithFile = { ...movie, id: 856, title: 'Estreno Con Archivo', has_file: true }

/** The same movie with the app's own grab record on it. */
const grabbedMovie = {
  ...movie,
  id: 857,
  title: 'Estreno Pedido',
  grabbed_at: GRABBED_AT,
  grabbed_destination: '/mnt/peliculas/_manual',
}

const episode = {
  type: 'episode',
  id: 42,
  title: 'Estreno de Episodio',
  date: '2026-10-06',
  year: null,
  has_file: false,
  remotePoster: '',
  series_title: 'Serie de Estreno',
  season_number: 1,
  episode_number: 2,
  source: 'sonarr',
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** The calendar answers with the given items; every listing stays empty. */
function mockFetch(items: unknown[]) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void init
    const url = String(input)
    if (url.includes('/api/calendar?')) {
      return ok({ items, start: '2026-10-01', end: '2026-11-01' })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [], total: 0, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [], total: 0, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [], total: 0 } },
        updated_at: 0,
      })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderWith(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

/** The bodies the panel's Releases tab sent to its search endpoint. */
function releaseBodies(fn: ReturnType<typeof mockFetch>): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes('/api/calendar/releases'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

const ROW_MISSING = 'No se pudo leer la fila seleccionada.'
const activeTab = () => document.querySelector('.sec-dtab.is-active')?.textContent ?? ''

describe('Películas · Estrenos selects into the detail panel', () => {
  let fn: ReturnType<typeof mockFetch>

  beforeEach(() => {
    window.location.hash = ''
    fn = mockFetch([movie])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lands on the Releases tab the view switch already resets to, and searches there', async () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
    fireEvent.click(await screen.findByText('Estreno de Película'))

    // changeView already put Releases on duty; the click must not fight it.
    expect(activeTab()).toBe('Releases')
    expect(document.querySelector('.sec-detail h3')?.textContent).toBe('Estreno de Película')
    expect(document.querySelector('.scan-modal-backdrop')).toBeNull()

    // The search the panel runs IS the calendar item's own identity — the
    // fields the release item was built from, not a fresh guess.
    await waitFor(() => expect(releaseBodies(fn)).toHaveLength(1))
    expect(releaseBodies(fn)[0]).toMatchObject({
      source: 'radarr',
      type: 'movie',
      id: 855,
    })
  })

  it('keeps Archivos and Historial honest for the calendar item — never "row unreadable"', async () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
    fireEvent.click(await screen.findByText('Estreno de Película'))

    // Archivos: a CalendarItem carries no folder, so the tab says exactly that.
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))
    expect(await screen.findByText('Esta entrada no tiene ruta')).toBeInTheDocument()
    expect(screen.queryByText(ROW_MISSING)).not.toBeInTheDocument()

    // Historial: grabbed_at is null on this item — never asked, not unreadable.
    fireEvent.click(screen.getByRole('button', { name: 'Historial' }))
    expect(await screen.findByText('Nunca se pidió desde la app')).toBeInTheDocument()
    expect(screen.queryByText(ROW_MISSING)).not.toBeInTheDocument()
  })

  it('reads the grab record the calendar item actually carries', async () => {
    mockFetch([grabbedMovie])
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
    fireEvent.click(await screen.findByText('Estreno Pedido'))

    fireEvent.click(screen.getByRole('button', { name: 'Historial' }))

    // The item's own grabbed_at/grabbed_destination, formatted in es-ES —
    // derived from the CalendarItem, never fabricated, never "missing".
    expect(
      await screen.findByText(new Date(GRABBED_AT * 1000).toLocaleDateString('es-ES')),
    ).toBeInTheDocument()
    expect(screen.getByText('/mnt/peliculas/_manual')).toBeInTheDocument()
    expect(screen.queryByText(ROW_MISSING)).not.toBeInTheDocument()
  })
})

describe('Series · Estrenos selects into the detail panel', () => {
  let fn: ReturnType<typeof mockFetch>

  beforeEach(() => {
    window.location.hash = ''
    fn = mockFetch([episode])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects the episode with its code and keeps all four tabs honest', async () => {
    renderWith(Series)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
    fireEvent.click(await screen.findByText('Estreno de Episodio'))

    // The panel titles the selection by its series and spells the episode out.
    expect(document.querySelector('.sec-detail h3')?.textContent).toBe('Serie de Estreno')
    expect(screen.getByText('S01E02 · Estreno de Episodio')).toBeInTheDocument()
    expect(activeTab()).toBe('Releases')
    expect(document.querySelector('.scan-modal-backdrop')).toBeNull()
    await waitFor(() => expect(releaseBodies(fn)).toHaveLength(1))
    expect(releaseBodies(fn)[0]).toMatchObject({
      source: 'sonarr',
      type: 'episode',
      id: 42,
    })

    // Episodios: Sonarr's calendar payload carries no series id — the tab
    // says it cannot name one instead of inventing it.
    fireEvent.click(screen.getByRole('button', { name: 'Episodios' }))
    expect(
      await screen.findByText('Esta entrada no tiene serie asociada'),
    ).toBeInTheDocument()
    expect(screen.queryByText(ROW_MISSING)).not.toBeInTheDocument()

    // Archivos: no folder on a CalendarItem — the honest "no tiene ruta".
    fireEvent.click(screen.getByRole('button', { name: 'Archivos' }))
    expect(await screen.findByText('Esta entrada no tiene ruta')).toBeInTheDocument()
    expect(screen.queryByText(ROW_MISSING)).not.toBeInTheDocument()

    // Historial: no grab on this item — never asked, not unreadable.
    fireEvent.click(screen.getByRole('button', { name: 'Historial' }))
    expect(await screen.findByText('Nunca se pidió desde la app')).toBeInTheDocument()
    expect(screen.queryByText(ROW_MISSING)).not.toBeInTheDocument()
  })
})

describe('every calendar card selects — a title with its file too', () => {
  let fn: ReturnType<typeof mockFetch>

  beforeEach(() => {
    window.location.hash = ''
    fn = mockFetch([movieWithFile])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects the card that already has its file, without any overlay', async () => {
    renderWith(Peliculas)

    fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
    fireEvent.click(await screen.findByText('Estreno Con Archivo'))

    expect(document.querySelector('.sec-detail h3')?.textContent).toBe('Estreno Con Archivo')
    expect(document.querySelector('.scan-modal-backdrop')).toBeNull()
    expect(document.querySelector('.scan-modal')).toBeNull()

    // A title that already has its file never auto-searches: it meets the
    // has-file block, which degrades honestly — the calendar carries no
    // file name to show.
    expect(await screen.findByText('Nombre no disponible en esta vista')).toBeInTheDocument()
    expect(releaseBodies(fn)).toHaveLength(0)
  })
})

describe('a standalone Calendar keeps the overlay it always had', () => {
  beforeEach(() => {
    window.location.hash = ''
    mockFetch([movie])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the release search as a modal when no onSelect was provided', async () => {
    renderWith(Calendar)

    fireEvent.click(await screen.findByText('Estreno de Película'))

    expect(document.querySelector('.scan-modal-backdrop')).not.toBeNull()
    expect(document.querySelector('.scan-modal')).not.toBeNull()
    // …and nothing selected: the overlay path never touched a panel.
    expect(document.querySelector('.sec-detail')).toBeNull()
  })
})

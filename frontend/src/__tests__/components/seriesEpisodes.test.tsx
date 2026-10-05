import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Series } from '../../components/Series'
import type { Release } from '../../api/calendar'

/**
 * The Episodios tab (the operator's ask: a series opens on its episodes).
 *
 * What is pinned here:
 * 1. selecting a row LANDS on Episodios — the default AND the switch;
 * 2. the season chips (Todas + one per season, counts included) and the
 *    filter they drive;
 * 3. the season header rows and the counts they state — only what the
 *    payload states, dashes where it says nothing;
 * 4. marking an episode: it is a SEPARATE piece of state from the
 *    selection (the trap — an episode in `selected` would null
 *    facts.seriesId and unmount this very list), it survives a round trip
 *    through Releases, and it keys the search on THAT episode.
 */

const GRABBED_AT = 1_759_468_800

const seriesSomeShow = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: false,
  path: '/series/Some Show',
  path_exists: true,
  monitored: true,
  episode_count: 8,
  episode_file_count: 6,
  grabbed_at: GRABBED_AT,
  grabbed_destination: null,
}

const seriesOtherShow = {
  id: 4,
  title: 'Other Show',
  year: 2020,
  remotePoster: '',
  has_file: false,
  path: '/series/Other Show',
  path_exists: true,
  monitored: true,
  episode_count: 1,
  episode_file_count: 0,
  grabbed_at: null,
  grabbed_destination: null,
}

/** The real 8-key payload of GET /api/wanted/series/{id}/episodes: two
 *  seasons, and every shape the file facts can take — a file we could read
 *  (quality + path), a file we could NOT read (true with nulls) and no file
 *  at all. Season 01 answers the header clause of the contract verbatim:
 *  "4 en biblioteca · 1 falta". */
const episodesSomeShow = [
  { id: 11, season_number: 1, episode_number: 1, title: 'Despegue cero', air_date: '2021-01-08T00:00:00Z', has_file: true, quality: 'Bluray-1080p', path: '/series/Some Show/Season 01/' },
  { id: 12, season_number: 1, episode_number: 2, title: 'La señal', air_date: '2021-01-15T00:00:00Z', has_file: true, quality: null, path: null },
  { id: 13, season_number: 1, episode_number: 3, title: 'Hibernación', air_date: '2021-01-22T00:00:00Z', has_file: true, quality: 'WEBDL-720p', path: '/series/Some Show/Season 01/' },
  { id: 14, season_number: 1, episode_number: 4, title: 'El eco', air_date: '2021-01-29T00:00:00Z', has_file: true, quality: null, path: null },
  { id: 15, season_number: 1, episode_number: 5, title: 'Módulo Aurora', air_date: '2021-02-05T00:00:00Z', has_file: false, quality: null, path: null },
  { id: 21, season_number: 2, episode_number: 1, title: 'Nuevo rumbo', air_date: '2023-03-02T00:00:00Z', has_file: true, quality: 'Bluray-2160p', path: '/series/Some Show/Season 02/' },
  { id: 22, season_number: 2, episode_number: 2, title: 'Deriva', air_date: '2023-03-09T00:00:00Z', has_file: true, quality: null, path: null },
  { id: 23, season_number: 2, episode_number: 3, title: 'Eclipse', air_date: '2023-03-16T00:00:00Z', has_file: false, quality: null, path: null },
]

/** A payload WITHOUT the file facts — an older build. Unknown, never a
 *  state: no flag means no claim about the file. */
const episodesOldPayload = [
  { id: 7, season_number: 3, episode_number: 7, title: 'Of Ice Men', air_date: '2006-11-27T00:00:00Z' },
]

const release: Release = {
  guid: 'rel-series-episodes-1',
  title: 'Some.Show.S02E01.2160p.WEB-DL',
  size: 9_000_000_000,
  quality: 'Bluray-2160p',
  indexer: 'aMuTorrent',
  indexerId: 1,
  indexerFlags: '',
  seeders: 9,
  leechers: 1,
  protocol: 'torrent',
  releaseGroup: '',
  languages: ['Spanish'],
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch() {
  const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/wanted/series/3/episodes')) return ok({ episodes: episodesSomeShow })
    if (url.includes('/api/wanted/series/4/episodes')) return ok({ episodes: episodesOldPayload })
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [seriesSomeShow, seriesOtherShow], total: 2, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) return ok({ items: [], total: 0, page: 1, page_size: 50 })
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
      return ok({ folders: [], arr_available: true, detail: '' })
    }
    if (url.includes('/api/calendar/releases')) {
      return ok({ releases: [release], detail: '1 releases encontrados' })
    }
    if (url.includes('/api/grabs')) return ok({ grabs: [] })
    if (url.includes('/api/files/browse')) return ok({ ok: true, items: [], path: '' })
    if (url.includes('/api/settings')) return ok({ paths: { path_4k: '', path_3d: '' } })
    if (url.includes('/api/calendar?')) {
      return ok({ items: [], start: '2026-10-01', end: '2026-11-01' })
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
const activeTab = () => document.querySelector('.sec-dtab.is-active')?.textContent ?? ''

/** The pane's row whose text contains `title`, as the pane rendered it. */
const rowOf = (title: string) =>
  Array.from(document.querySelectorAll('.sec-row')).find((row) =>
    row.textContent?.includes(title),
  ) as HTMLElement

/** The episode row holding `title`, straight from the table. */
const episodeRow = (title: string) =>
  screen.getByText(title).closest('.sec-ep-row') as HTMLElement

const releaseBodies = (fn: FetchMock) =>
  fn.mock.calls
    .filter(([input]) => String(input).includes('/api/calendar/releases'))
    .map(([, init]) => JSON.parse(String((init as RequestInit)?.body)) as Record<string, unknown>)

const grabUrls = (fn: FetchMock) =>
  fn.mock.calls
    .filter(([input]) => String(input).includes('/api/grabs'))
    .map(([input]) => String(input))

const seasonHeaders = () =>
  Array.from(document.querySelectorAll('.sec-season-head'))

const callsFor = (fn: FetchMock, needle: string) =>
  fn.mock.calls.filter(([input]) => String(input).includes(needle))

describe('Series · the Episodios tab', () => {
  let fn: FetchMock

  beforeEach(() => {
    window.location.hash = ''
    fn = stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lands on Episodios when a series row is selected', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')

    // The default the panel opens with…
    expect(activeTab()).toBe('Episodios')

    // …and the switch: from anywhere, a row selection lands on the episodes.
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }))
    expect(activeTab()).toBe('Releases')

    fireEvent.click(rowOf('Some Show'))

    expect(await screen.findByText('S01E01')).toBeInTheDocument()
    expect(activeTab()).toBe('Episodios')
    expect(callsFor(fn, '/api/wanted/series/3/episodes')).toHaveLength(1)
  })

  it('offers Todas plus one chip per season, each with its count', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))
    await screen.findByText('S01E01')

    expect(screen.getByRole('button', { name: 'Todas (8)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Season 01 (5)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Season 02 (3)' })).toBeInTheDocument()
    // Only the seasons that exist — one chip each, nothing invented.
    expect(screen.queryAllByRole('button', { name: /^Season \d\d/ })).toHaveLength(2)
    expect(
      within(screen.getByRole('group', { name: 'Filtrar por temporada' })).getByRole('button', {
        name: 'Todas (8)',
      }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('filters the table to one season, and Todas restores the grouping', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))
    await screen.findByText('S01E01')

    // Grouped by default: both headers, both seasons' rows.
    expect(seasonHeaders()).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Season 01 (5)' }))

    expect(await screen.findByText('S01E05')).toBeInTheDocument()
    expect(screen.queryByText('S02E01')).not.toBeInTheDocument()
    // The single group keeps its header — it is still the season's table.
    expect(screen.getByText('Season 01')).toBeInTheDocument()
    expect(screen.queryByText('Season 02')).not.toBeInTheDocument()
    expect(seasonHeaders()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Todas (8)' }))

    expect(await screen.findByText('S02E01')).toBeInTheDocument()
    expect(screen.getByText('Season 02')).toBeInTheDocument()
    expect(seasonHeaders()).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Todas (8)' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('states only what the payload states: en biblioteca, falta, and dashes', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))
    await screen.findByText('S01E01')

    const [first, second] = seasonHeaders()
    expect(first).toHaveTextContent('Season 01')
    expect(first).toHaveTextContent('2021')
    expect(first).toHaveTextContent('4 en biblioteca')
    expect(first).toHaveTextContent('1 falta')
    expect(second).toHaveTextContent('Season 02')
    expect(second).toHaveTextContent('2023')
    expect(second).toHaveTextContent('2 en biblioteca')
    expect(second).toHaveTextContent('1 falta')

    // has_file: true with null quality/path — the file IS there and could not
    // be read: "En biblioteca" with dashes, never "no file".
    const unreadable = episodeRow('La señal')
    expect(within(unreadable).getByText('En biblioteca')).toBeInTheDocument()
    // No badge: the payload states no quality, so none is claimed — and each
    // fact that IS unknown renders as its own named dash, never "no file".
    expect(unreadable.querySelector('.sec-q-tag')).toBeNull()
    expect(unreadable.querySelector('.sec-ep-qual')).toHaveTextContent('—')
    expect(unreadable.querySelector('.sec-ep-path')).toHaveTextContent('—')

    // A missing file says so, with the same unknowns for its facts.
    const missing = episodeRow('Eclipse')
    expect(within(missing).getByText('Falta')).toBeInTheDocument()

    // An old payload without the file facts claims no state at all.
    fireEvent.click(rowOf('Other Show'))
    await screen.findByText('Of Ice Men')
    const oldRow = episodeRow('Of Ice Men')
    // The PILL is what claims a state; on an unknown payload it says so with
    // a dash rather than inventing one.
    expect(within(oldRow).getByText('—', { selector: '.sec-ep-pill' })).toBeInTheDocument()
  })

  it('marks the episode it is activated on and sends the panel to Releases', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))
    await screen.findByText('S01E01')

    const row = episodeRow('Nuevo rumbo')
    expect(row).toHaveAttribute('tabindex', '0')
    expect(row).toHaveAttribute('aria-selected', 'false')

    fireEvent.keyDown(row, { key: 'Enter' })
    expect(activeTab()).toBe('Releases')

    // The mark survives the round trip back to the list — and the panel's
    // selection never moved off the series (that is what keeps this list
    // mounted in the first place).
    fireEvent.click(screen.getByRole('button', { name: 'Episodios' }))
    expect(episodeRow('Nuevo rumbo')).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelectorAll('.sec-ep-row[aria-selected="true"]')).toHaveLength(1)
    expect(within(panel()).getByRole('heading', { name: 'Some Show' })).toBeInTheDocument()

    // Space on another row moves the mark: it is a single selection.
    fireEvent.keyDown(episodeRow('Eclipse'), { key: ' ' })
    expect(activeTab()).toBe('Releases')
    fireEvent.click(screen.getByRole('button', { name: 'Episodios' }))
    expect(episodeRow('Eclipse')).toHaveAttribute('aria-selected', 'true')
    expect(episodeRow('Nuevo rumbo')).toHaveAttribute('aria-selected', 'false')
  })

  it('searches the MARKED episode under its own id — never the series id', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))
    await screen.findByText('S01E01')

    fireEvent.click(episodeRow('Nuevo rumbo'))
    expect(activeTab()).toBe('Releases')

    // The header speaks for the episode now: its code is the episode_number
    // the search is keyed on, spelled out where the operator can read it.
    expect(within(panel()).getByText('S02E01 · Nuevo rumbo')).toBeInTheDocument()

    // The has-file block asks the history about THAT episode.
    await waitFor(() => expect(grabUrls(fn)).toHaveLength(1))
    expect(grabUrls(fn)[0]).toContain('episode_id=21')
    expect(grabUrls(fn)[0]).not.toContain('series_id')

    // And the search itself runs under the episode's id.
    fireEvent.click(await screen.findByRole('button', { name: 'Buscar versiones' }))
    await waitFor(() => expect(releaseBodies(fn)).toHaveLength(1))
    expect(releaseBodies(fn)[0]).toMatchObject({
      source: 'sonarr',
      type: 'episode',
      id: 21,
    })
    expect(String(releaseBodies(fn)[0].id)).not.toBe('3')
  })

  it('searches the series itself while no episode is marked', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))

    // Nothing marked: the Releases tab is the series' own search, exactly as
    // it has always been — series id on the wire, series detail in the header.
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }))
    expect(within(panel()).getByText('6/8 episodios')).toBeInTheDocument()
    expect(within(panel()).queryByText(/^S\d\dE\d\d ·/)).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await waitFor(() => expect(releaseBodies(fn)).toHaveLength(1))
    expect(releaseBodies(fn)[0]).toMatchObject({
      source: 'sonarr',
      type: 'episode',
      id: 3,
    })
    expect(releaseBodies(fn)[0].id).not.toBe(21)
    expect(grabUrls(fn)).toHaveLength(0)
  })

  it('selecting a different series clears the marked episode', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    fireEvent.click(rowOf('Some Show'))
    await screen.findByText('S01E01')

    fireEvent.click(episodeRow('Nuevo rumbo'))
    expect(activeTab()).toBe('Releases')

    fireEvent.click(rowOf('Other Show'))

    // The new row lands on ITS episodes, with no mark carried over.
    expect(activeTab()).toBe('Episodios')
    expect(await screen.findByText('S03E07')).toBeInTheDocument()
    expect(document.querySelectorAll('.sec-ep-row[aria-selected="true"]')).toHaveLength(0)

    // And Releases is the new series' search again, not the old episode's.
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }))
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await waitFor(() => expect(releaseBodies(fn)).toHaveLength(1))
    expect(releaseBodies(fn)[0]).toMatchObject({
      source: 'sonarr',
      type: 'episode',
      id: 4,
    })
    expect(releaseBodies(fn)[0].id).not.toBe(21)
  })
})

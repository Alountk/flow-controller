import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Series } from '../../../pages/Series.tsx'
import type { AllSeries, DownloadEntry } from '../../../shared/types.ts'

/**
 * Stitch bloque 🟡 — árbol serie→temporada→episodio (stitch-series-tree, S2/S4).
 *
 * The left pane of Series stops being a flat card grid: each series wears a
 * disclosure control and expanding it fetches THAT series' episodes (the
 * existing GET /api/wanted/series/{id}/episodes, on demand — nothing is
 * fetched while collapsed) and renders seasons with the design's episode
 * vocabulary: "En biblioteca" · "Falta" (+ "Descargando"/"Colocado" from the
 * queue in T4), one honest state per payload fact.
 *
 * What these tests pin:
 *
 * - lazy: no episodes request until the disclosure is activated;
 * - expand → seasons with their summary counts derived ONLY from the loaded
 *   episodes, and pills labelled exactly as the payload states them;
 * - an episode whose payload carries no `has_file` wears a neutral dash —
 *   never a coloured state nobody reported (the panel's honesty rule, now in
 *   the tree);
 * - collapse removes the children again, and the disclosure reports its own
 *   state through aria-expanded;
 * - T4 (S5): the live queue crossed by `episode_id` overrides the file state
 *   ONLY for the episode it names — "Descargando"/"Colocado"/the blockage the
 *   queue itself reports — and a queue that says nothing (foreign ids, a
 *   failed read) leaves the honest `has_file` states untouched.
 */

const baseSeries: AllSeries = {
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
  season_count: 3,
  grabbed_at: null,
  grabbed_destination: null,
}

/** Three seasons worth of facts: known-true, known-false, and one episode
 *  whose payload says NOTHING about files (old build → unknown). */
const episodesSomeShow = [
  { id: 11, season_number: 1, episode_number: 1, title: 'Despegue cero', air_date: '2021-01-08T00:00:00Z', has_file: true, quality: 'Bluray-1080p', path: '/series/Some Show/Season 01/' },
  { id: 15, season_number: 1, episode_number: 5, title: 'Módulo Aurora', air_date: '2021-02-05T00:00:00Z', has_file: false, quality: null, path: null },
  { id: 7, season_number: 3, episode_number: 7, title: 'Of Ice Men', air_date: '2006-11-27T00:00:00Z' },
]

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch(
  series: AllSeries,
  downloads: DownloadEntry[] = [],
  opts: { downloadsFail?: boolean } = {},
) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/downloads')) {
      if (opts.downloadsFail) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
      }
      return ok({ downloads, errors: [], updated_at: 0 })
    }
    if (url.includes('/api/wanted/series/3/episodes')) {
      return ok({ episodes: episodesSomeShow })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [series], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [], total: 0 } },
        updated_at: 0,
      })
    }
    void init
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof stubFetch>

const episodeCalls = (fn: FetchMock) =>
  fn.mock.calls.filter(([input]) => String(input).includes('/api/wanted/series/3/episodes'))

const downloadsCalls = (fn: FetchMock) =>
  fn.mock.calls.filter(([input]) => String(input).includes('/api/downloads'))

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

/** The series' disclosure control, the only way into the tree. */
const disclosure = () => screen.getByRole('button', { name: /episodios de Some Show/i }) as HTMLElement

/** The tree episode row holding `title`. */
const epRow = (title: string) =>
  screen.getByText(title).closest('.st-ep') as HTMLElement

describe('Series · árbol serie→temporada→episodio (bloque 🟡)', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for nothing until the disclosure is activated (lazy by series)', async () => {
    const fn = stubFetch(baseSeries)
    renderSection(Series)
    await screen.findByText('Some Show')

    expect(episodeCalls(fn)).toHaveLength(0)
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Despegue cero')).toBeNull()
  })

  it('expanding fetches the series and renders seasons with honest pills', async () => {
    const fn = stubFetch(baseSeries)
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(disclosure())

    // The lazy fetch happened exactly once for this series…
    await screen.findByText('Despegue cero')
    expect(episodeCalls(fn)).toHaveLength(1)
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true')

    // …and the season summary counts ONLY what those payloads state:
    // Season 01 = 2 known episodes (1 in library, 1 missing).
    expect(screen.getByText('Season 01')).toBeInTheDocument()
    expect(screen.getByText('2 episodios · 1 en biblioteca · 1 falta')).toBeInTheDocument()

    // The design's vocabulary, word for word.
    const inLibrary = epRow('Despegue cero').querySelector('.sec-pill-ok')
    expect(inLibrary?.textContent).toBe('En biblioteca')
    const missing = epRow('Módulo Aurora').querySelector('.sec-pill-bad')
    expect(missing?.textContent).toBe('Falta')
  })

  it('never paints a state the payload did not report (unknown → dash)', async () => {
    stubFetch(baseSeries)
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(disclosure())
    await screen.findByText('Despegue cero')

    // Season 03's episode has no `has_file` at all: neutral dash, no tone.
    const unknown = epRow('Of Ice Men')
    expect(unknown.querySelector('.sec-pill-ok')).toBeNull()
    expect(unknown.querySelector('.sec-pill-bad')).toBeNull()
    expect(unknown.querySelector('.sec-pill')?.textContent).toBe('—')

    // Season 03 summary draws no clause it cannot back: total only.
    expect(screen.getByText('1 episodio')).toBeInTheDocument()
    expect(screen.queryByText(/Of Ice Men.*falta/)).toBeNull()
  })

  it('collapsing removes the children and flips the disclosure back', async () => {
    stubFetch(baseSeries)
    renderSection(Series)
    await screen.findByText('Some Show')

    const toggle = disclosure()
    fireEvent.click(toggle)
    await screen.findByText('Despegue cero')

    fireEvent.click(screen.getByRole('button', { name: /contraer episodios de Some Show/i }))
    expect(screen.queryByText('Despegue cero')).toBeNull()
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps selecting the series from its row (master–detail intact)', async () => {
    stubFetch(baseSeries)
    renderSection(Series)
    await screen.findByText('Some Show')

    const row = document.querySelector('.sec-row') as HTMLElement
    fireEvent.click(row)

    expect(row).toHaveAttribute('aria-current', 'true')
    // Selection alone must not expand the tree: the disclosure is independent.
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false')
  })

  /** S2 literal (user decision, L6): the cards leave the Series view — the
   *  series node compacts to the prototype's summary line (no poster box, no
   *  path line; the poster lives in the detail panel) while every contract
   *  other suites rely on survives: selection, the wanted-card class, name,
   *  counts, the completeness line and the row's actions. */
  it('renders the series node compact: no poster box and no path (S2)', async () => {
    stubFetch(baseSeries)
    renderSection(Series)
    await screen.findByText('Some Show')

    const row = document.querySelector('.sec-row') as HTMLElement
    // The card furniture is gone from THIS view. The box used to draw
    // initials even with no poster data, so its absence is structural.
    expect(row.querySelector('.sec-row-poster')).toBeNull()
    expect(row.querySelector('.sec-row-path')).toBeNull()

    // What compaction must never cost (contracts across suites):
    expect(row.classList.contains('wanted-card')).toBe(true)
    expect(row.querySelector('.sec-row-name')?.textContent).toBe('Some Show')
    expect(row.querySelector('.sec-row-ep-count')).not.toBeNull()
    expect(row.querySelector('.sec-row-complete')).not.toBeNull()
    expect(within(row).getByRole('button', { name: /buscar/i })).toBeInTheDocument()

    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-current', 'true')
  })
})

/** A live-queue row as GET /api/downloads hands it over (T1 shape: the Sonarr
 *  ids ride along, omitted rather than null when absent). */
const queueEntry = (overrides: Partial<DownloadEntry>): DownloadEntry => ({
  id: 'q1',
  source: 'sonarr',
  title: 'Some Show S01E05 Módulo Aurora',
  status: 'downloading',
  tracked_state: 'downloading',
  tracked_status: 'ok',
  problem: false,
  messages: [],
  progress: 42,
  size: 100,
  sizeleft: 58,
  timeleft: '00:45:19',
  download_client: 'aMuTorrent',
  indexer: 'Knaben',
  matched: true,
  speed: null,
  eta_seconds: null,
  seeders: null,
  leechers: null,
  torrent_state: null,
  series_id: 3,
  ...overrides,
})

/**
 * T4 (S1/S5) — the active queue crossed into the tree by `episode_id`.
 *
 * The queue's word wins ONLY where the queue has one: the design's
 * "Descargando"/"Colocado" and the blockage the queue itself reports
 * (S5's honest extension). Everywhere else — foreign ids, a failed queue
 * read, a queue state outside the design's vocabulary — the pill stays on
 * the `has_file` facts, which are true either way. Season counts never
 * move: they count files, the cross only speaks through pills.
 */
describe('Series · árbol · la cola por episodio (T4, S5)', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the queue only with the episodes, and "Descargando" outranks the file fact', async () => {
    const fn = stubFetch(baseSeries, [queueEntry({ episode_id: 15 })])
    renderSection(Series)
    await screen.findByText('Some Show')

    // Lazy like the episodes: a collapsed tree reads no queue either.
    expect(downloadsCalls(fn)).toHaveLength(0)

    fireEvent.click(disclosure())
    await screen.findByText('Despegue cero')
    await waitFor(() => expect(downloadsCalls(fn)).toHaveLength(1))

    // The queue really holds episode 15 → its pill is the queue's word…
    await screen.findByText('Descargando')
    const row = epRow('Módulo Aurora')
    expect(row.querySelector('.sec-pill')?.textContent).toBe('Descargando')
    expect(row.querySelector('.sec-pill-warn')).not.toBeNull()
    expect(row.querySelector('.sec-pill-bad')).toBeNull()

    // …while the season counts stay file facts: the cross touches pills only.
    expect(screen.getByText('2 episodios · 1 en biblioteca · 1 falta')).toBeInTheDocument()
  })

  it('reads a placed-but-unimported download as "Colocado", never coloured like a verdict', async () => {
    stubFetch(baseSeries, [
      queueEntry({ episode_id: 7, status: 'completed', tracked_state: 'importPending' }),
    ])
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(disclosure())
    await screen.findByText('Colocado')

    const pill = epRow('Of Ice Men').querySelector('.sec-pill')
    expect(pill?.textContent).toBe('Colocado')
    expect(pill?.classList.contains('sec-pill-neutral')).toBe(true)
    expect(pill?.classList.contains('sec-pill-ok')).toBe(false)
    expect(pill?.classList.contains('sec-pill-bad')).toBe(false)
  })

  it('reflects the blockage the queue itself reports — even over "En biblioteca"', async () => {
    stubFetch(baseSeries, [
      queueEntry({
        episode_id: 11,
        tracked_state: 'importBlocked',
        tracked_status: 'warning',
        problem: true,
      }),
      queueEntry({ id: 'q2', episode_id: 15, status: 'failed', tracked_state: 'failed', problem: true }),
    ])
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(disclosure())
    await screen.findByText('Import bloqueado')

    // Episode 11 HAS its file — the blockage is still the actionable fact.
    const blocked = epRow('Despegue cero')
    expect(blocked.querySelector('.sec-pill-bad')?.textContent).toBe('Import bloqueado')
    expect(blocked.querySelector('.sec-pill-ok')).toBeNull()

    expect(epRow('Módulo Aurora').querySelector('.sec-pill-bad')?.textContent).toBe('Fallida')
    // Counts still count files: the queue moved no count.
    expect(screen.getByText('2 episodios · 1 en biblioteca · 1 falta')).toBeInTheDocument()
  })

  it('crosses by THIS episode only: a foreign queue row changes nothing', async () => {
    const fn = stubFetch(baseSeries, [queueEntry({ episode_id: 999 })])
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(disclosure())
    await screen.findByText('Despegue cero')
    // The queue WAS read — the cross just found no row for these episodes.
    await waitFor(() => expect(downloadsCalls(fn)).toHaveLength(1))

    expect(epRow('Despegue cero').querySelector('.sec-pill-ok')?.textContent).toBe('En biblioteca')
    expect(epRow('Módulo Aurora').querySelector('.sec-pill-bad')?.textContent).toBe('Falta')
    const unknown = epRow('Of Ice Men').querySelector('.sec-pill')
    expect(unknown?.textContent).toBe('—')
    expect(unknown?.classList.contains('sec-pill-ok')).toBe(false)
    expect(unknown?.classList.contains('sec-pill-bad')).toBe(false)
    expect(screen.queryByText('Descargando')).toBeNull()
    expect(screen.queryByText('Colocado')).toBeNull()
  })

  it('falls back to the file facts when the queue read fails (no data → has_file)', async () => {
    const fn = stubFetch(baseSeries, [], { downloadsFail: true })
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(disclosure())
    await screen.findByText('Despegue cero')
    await waitFor(() => expect(downloadsCalls(fn)).toHaveLength(1))
    // Let the query settle into its error state before reading the pills.
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(epRow('Despegue cero').querySelector('.sec-pill-ok')?.textContent).toBe('En biblioteca')
    expect(epRow('Módulo Aurora').querySelector('.sec-pill-bad')?.textContent).toBe('Falta')
    expect(screen.queryByText('Descargando')).toBeNull()
    expect(screen.queryByText('Colocado')).toBeNull()
    expect(screen.queryByText('Import bloqueado')).toBeNull()
  })

  it('keeps the file fact for a queue state the design has no word for (S4 vocabulary)', async () => {
    const fn = stubFetch(baseSeries, [
      queueEntry({ episode_id: 15, status: 'paused', tracked_state: 'paused' }),
    ])
    renderSection(Series)
    await screen.findByText('Some Show')

    fireEvent.click(disclosure())
    await screen.findByText('Despegue cero')
    await waitFor(() => expect(downloadsCalls(fn)).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))

    // "paused" is not in the design's vocabulary and S5 only allows the
    // blockage extension — so the pill stays on the file fact (still true),
    // and no label from another surface is invented here.
    expect(epRow('Módulo Aurora').querySelector('.sec-pill-bad')?.textContent).toBe('Falta')
    expect(screen.queryByText('En pausa')).toBeNull()
    expect(screen.queryByText('Descargando')).toBeNull()
  })
})

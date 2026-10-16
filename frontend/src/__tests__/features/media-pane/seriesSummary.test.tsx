import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Series } from '../../../pages/Series.tsx'
import type { AllSeries } from '../../../shared/types.ts'

/**
 * The series summary lines (stitch-series-summary T1 + T2):
 *
 * - a completeness line under the episodes count, derived ONLY from the two
 *   counts the payload carries: differing counts → "Faltan N episodios para
 *   completar la serie" (warn tone), equal → "Todos los episodios descargados"
 *   (ok tone), no total (0/absent) → NO line at all: with no total there is
 *   nothing to be complete about, and an invented claim is the bug this pins;
 * - "· N temporadas" appended to the episodes line ONLY when the payload
 *   carries `season_count` — absent means the legacy line, word for word.
 *
 * The section-row path only: the card fallback (`renderCatalogSeries`,
 * `isSection: false`) left the codebase with the cards (S2 — the Series view
 * is the tree now), so the summary lines are pinned where the app draws
 * them: through the Series page's SectionRow rows.
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
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** The catalogue payload the Series section renders, fed with THIS series. */
function stubSeriesFetch(series: AllSeries) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
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

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

describe('series summary · completeness line (SectionRow)', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const renderSeries = async (series: AllSeries) => {
    stubSeriesFetch(series)
    renderSection(Series)
    await screen.findByText('Some Show')
  }

  it('warns under the episodes line when the counts differ', async () => {
    await renderSeries(baseSeries) // 4 of 10 → 6 missing

    const line = screen.getByText('Faltan 6 episodios para completar la serie')
    expect(line.className).toContain('sec-row-complete-warn')

    // A NEW line under the episodes count, never in its place.
    const count = document.querySelector('.sec-row-ep-count')
    expect(count).not.toBeNull()
    const follows = (count?.compareDocumentPosition(line) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(follows).toBeTruthy()
  })

  it('reads complete when every counted episode has its file', async () => {
    await renderSeries({ ...baseSeries, episode_file_count: 10 })

    const line = screen.getByText('Todos los episodios descargados')
    expect(line.className).toContain('sec-row-complete-ok')
  })

  it('draws no completeness line when the total is 0', async () => {
    await renderSeries({ ...baseSeries, episode_count: 0, episode_file_count: 0 })

    expect(document.querySelector('.sec-row-complete')).toBeNull()
    expect(screen.queryByText(/episodios para completar/)).toBeNull()
    expect(screen.queryByText('Todos los episodios descargados')).toBeNull()
  })

  it('draws no completeness line when the payload carries no total at all', async () => {
    const withoutTotal: Partial<AllSeries> = { ...baseSeries }
    delete withoutTotal.episode_count
    await renderSeries(withoutTotal as AllSeries)

    expect(document.querySelector('.sec-row-complete')).toBeNull()
    expect(screen.queryByText(/episodios para completar/)).toBeNull()
    expect(screen.queryByText('Todos los episodios descargados')).toBeNull()
  })

  it('appends · N temporadas to the episodes line when the payload carries season_count', async () => {
    await renderSeries({ ...baseSeries, season_count: 3 })

    expect(screen.getByText('4/10 episodios · 3 temporadas')).toBeInTheDocument()
  })

  it('keeps the legacy episodes line exactly when season_count is absent', async () => {
    await renderSeries(baseSeries)

    expect(screen.getByText('4/10 episodios')).toBeInTheDocument()
    expect(screen.queryByText(/temporadas/)).toBeNull()
  })

  it('ignores a season_count below 1 instead of claiming "0 temporadas"', async () => {
    await renderSeries({ ...baseSeries, season_count: 0 })

    expect(screen.getByText('4/10 episodios')).toBeInTheDocument()
    expect(screen.queryByText(/temporadas/)).toBeNull()
  })

  it('never renders "Faltan -N" when the file count exceeds the total', async () => {
    await renderSeries({ ...baseSeries, episode_file_count: 11 })

    expect(screen.getByText('Todos los episodios descargados')).toBeInTheDocument()
    expect(screen.queryByText(/episodios para completar/)).toBeNull()
  })
})

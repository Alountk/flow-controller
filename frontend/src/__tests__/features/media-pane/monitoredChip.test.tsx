import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { SectionRow, faltaStatus } from '../../../features/media-pane/components/SectionRow.tsx'
import { Peliculas } from '../../../pages/Peliculas.tsx'
import { Series } from '../../../pages/Series.tsx'

/**
 * The monitored chip (stitch-delta T1): a catalogue row wears it ONLY when
 * its listing carries the `monitored` field, and the label always matches
 * the flag — true reads "Monitorizada", false reads "Sin monitorear", and a
 * payload without the field (the wanted queue) wears nothing at all. An
 * absent flag must never be read as "unmonitored".
 */

const catalogMovie = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: '',
  has_file: true,
  path: '/peliculas/Your Name. (2016)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-2160p',
  grabbed_at: null,
  grabbed_destination: null,
}

const unmonitoredSeries = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: true,
  path: '/series/Some Show',
  path_exists: true,
  monitored: false,
  episode_count: 10,
  episode_file_count: 4,
  grabbed_at: null,
  grabbed_destination: null,
}

/** The wanted queue carries no monitored field at all. */
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

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch() {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [unmonitoredSeries], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [catalogMovie], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({
        wanted: { radarr: { items: [wantedMovie], total: 1 }, sonarr: { items: [episode], total: 1 } },
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

/** The first row the pane rendered in the master column. */
const firstRow = () => document.querySelector('.sec-row') as HTMLElement

describe('monitored chip · SectionRow', () => {
  it('renders the positive label when the row carries monitored: true', () => {
    render(
      <SectionRow className="wanted-card" wiring={{}} title="Some Show" status={faltaStatus()} monitored>
        <span>acciones</span>
      </SectionRow>,
    )
    const chip = screen.getByText('Monitorizada')
    expect(chip.className).toContain('sec-mon-tag')
  })

  it('renders the negative label when the row carries monitored: false', () => {
    render(
      <SectionRow className="wanted-card" wiring={{}} title="Some Show" status={faltaStatus()} monitored={false}>
        <span>acciones</span>
      </SectionRow>,
    )
    const chip = screen.getByText('Sin monitorear')
    expect(chip.className).toContain('sec-mon-tag')
    expect(screen.queryByText('Monitorizada')).toBeNull()
  })

  it('wears no chip at all when the field is absent: unknown stays invisible', () => {
    render(
      <SectionRow className="wanted-card" wiring={{}} title="Some Show" status={faltaStatus()}>
        <span>acciones</span>
      </SectionRow>,
    )
    expect(document.querySelector('.sec-mon-tag')).toBeNull()
    expect(screen.queryByText('Monitorizada')).toBeNull()
    expect(screen.queryByText('Sin monitorear')).toBeNull()
  })
})

describe('monitored chip · wiring through the sections', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the catalogue series flag on its row', async () => {
    renderSection(Series)
    await screen.findByText('Some Show')
    expect(within(firstRow()).getByText('Sin monitorear')).toBeInTheDocument()
  })

  it('shows the catalogue movie flag on its row', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')
    expect(within(firstRow()).getByText('Monitorizada')).toBeInTheDocument()
  })

  it('the wanted queue (no field) shows no chip on any row', async () => {
    renderSection(Peliculas)
    await screen.findByText('Your Name.')
    fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
    await screen.findByText('Todo a la vez en todas partes')
    expect(document.querySelector('.sec-mon-tag')).toBeNull()
  })
})

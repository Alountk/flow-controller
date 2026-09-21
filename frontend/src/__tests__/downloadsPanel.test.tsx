import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { QueueSidebar } from '../components/QueueSidebar'
import { downloadStateLabel, formatEta, formatSpeed } from '../hooks/useDownloads'
import type { Download } from '../api/downloads'

/**
 * The downloads panel joins Radarr/Sonarr state with the download client's
 * speed and ETA. These tests cover what it must never do: hide an import
 * problem, or show a failed download client as "no downloads".
 */

function makeDownload(overrides: Partial<Download> = {}): Download {
  return {
    id: '1',
    source: 'radarr',
    title: 'Transformers El ultimo caballero (2017).BDrip 2160p.mkv',
    status: 'downloading',
    tracked_state: 'downloading',
    tracked_status: 'ok',
    problem: false,
    messages: [],
    progress: 31,
    size: 1000,
    sizeleft: 690,
    timeleft: '00:45:19',
    download_client: 'aMuTorrent',
    indexer: 'Knaben',
    matched: true,
    speed: 4196000,
    eta_seconds: 3177,
    seeders: 1,
    leechers: 0,
    torrent_state: 'downloading',
    ...overrides,
  }
}

function mockFetch(downloads: Download[], errors: { source: string; error: string }[] = []) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/downloads')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ downloads, errors, updated_at: 0 }),
      } as Response)
    }
    if (url.includes('/api/files/queue/status')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ queue: [], completed: [], running: false }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <QueueSidebar />
    </QueryClientProvider>,
  )
}

describe('formatSpeed / formatEta', () => {
  it('formats speeds with units', () => {
    expect(formatSpeed(4196000)).toBe('4.0 MB/s')
    expect(formatSpeed(2048)).toBe('2.0 KB/s')
  })

  it('renders a dash for missing or zero speed', () => {
    expect(formatSpeed(null)).toBe('—')
    expect(formatSpeed(0)).toBe('—')
  })

  it('formats ETAs into readable units', () => {
    expect(formatEta(45)).toBe('45s')
    expect(formatEta(120)).toBe('2m')
    expect(formatEta(3720)).toBe('1h 2m')
  })

  it('renders a dash for unknown ETA', () => {
    expect(formatEta(null)).toBe('—')
  })
})

describe('downloadStateLabel', () => {
  it('translates the states a user cares about', () => {
    expect(downloadStateLabel(makeDownload({ tracked_state: 'importBlocked' }))).toBe('Import bloqueado')
    expect(downloadStateLabel(makeDownload({ tracked_state: 'importing' }))).toBe('Importando')
    expect(downloadStateLabel(makeDownload({ tracked_state: 'failed' }))).toBe('Fallida')
    expect(downloadStateLabel(makeDownload())).toBe('Descargando')
  })

  it('reports paused downloads', () => {
    expect(downloadStateLabel(makeDownload({ torrent_state: 'stalledDL' }))).toBe('Pausada')
  })
})

describe('downloads panel', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the downloads section next to the operations queue', async () => {
    mockFetch([makeDownload()])
    renderSidebar()

    expect(await screen.findByText('Descargas')).toBeInTheDocument()
    expect(screen.getByText('Operaciones')).toBeInTheDocument()
  })

  it('shows progress, speed, ETA and seeders when the client answered', async () => {
    mockFetch([makeDownload()])
    renderSidebar()

    await waitFor(() => expect(screen.getByText('31%')).toBeInTheDocument())
    expect(screen.getByText(/4\.0 MB\/s/)).toBeInTheDocument()
    expect(screen.getByText(/52m/)).toBeInTheDocument()
    expect(screen.getByText(/🌱 1/)).toBeInTheDocument()
  })

  it('flags an import-blocked download', async () => {
    mockFetch([
      makeDownload({
        tracked_state: 'importBlocked',
        tracked_status: 'warning',
        problem: true,
        messages: ['Failed to import movie'],
      }),
    ])
    renderSidebar()

    await waitFor(() => expect(screen.getByText('Import bloqueado')).toBeInTheDocument())
    expect(screen.getByText('Failed to import movie')).toBeInTheDocument()
  })

  it('explains when the download client could not be matched', async () => {
    mockFetch([makeDownload({ matched: false, speed: null, eta_seconds: null, seeders: null })])
    renderSidebar()

    await waitFor(() =>
      expect(screen.getByText('Sin datos del cliente de descargas')).toBeInTheDocument(),
    )
  })

  it('says there are no downloads when there genuinely are none', async () => {
    mockFetch([])
    renderSidebar()

    await waitFor(() => expect(screen.getByText('Sin descargas')).toBeInTheDocument())
  })

  it('reports a download-client failure instead of showing an empty panel', async () => {
    mockFetch([makeDownload({ matched: false })], [
      { source: 'amutorrent', error: 'aMuTorrent: no respondió a tiempo' },
    ])
    renderSidebar()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('aMuTorrent: no respondió a tiempo')
    // The download is still listed, just without client data.
    expect(screen.getByText(/Transformers/)).toBeInTheDocument()
  })

  it('keeps the long release title from breaking the layout', async () => {
    const longTitle = 'Transformers El ultimo caballero (2017).BDrip 2160p x265 10Bit DV HDR DUAL ac3-eac3.(.HispaShare.).mkv'
    mockFetch([makeDownload({ title: longTitle })])
    renderSidebar()

    const title = await screen.findByText(longTitle)
    // The full title stays available as a tooltip even when visually clamped.
    expect(title).toHaveAttribute('title', longTitle)
  })
})

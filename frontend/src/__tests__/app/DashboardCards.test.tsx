import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DashboardCards } from '../../app/DashboardCards.tsx'
import type {
  DiskResponse,
  DownloadEntry,
  ServiceStatus,
  Trace,
  TraceSummary,
} from '../../shared/types.ts'

const summary: TraceSummary = {
  downloading: 1,
  downloaded: 3,
  import_blocked: 2,
  failed: 0,
  sent: 1,
  category_mismatches: 0,
}

function download(overrides: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    id: '1',
    source: 'radarr',
    title: 'Some.Release',
    status: 'downloading',
    tracked_state: '',
    tracked_status: '',
    problem: false,
    messages: [],
    progress: 10,
    size: 1000,
    sizeleft: 900,
    timeleft: '',
    download_client: 'AmuTorrent',
    indexer: '',
    matched: true,
    speed: null,
    eta_seconds: null,
    seeders: null,
    leechers: null,
    torrent_state: null,
    ...overrides,
  }
}

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    source: 'radarr',
    title: 'Show',
    date: null,
    indexer: null,
    download_client: null,
    download_client_host: null,
    download_id: '',
    matched_hash: null,
    stage: 'import_blocked',
    torrent: null,
    expected_category: null,
    category_ok: null,
    paused: false,
    ids: { queue_id: null, episode_id: null, movie_id: null, series_id: null },
    destination: null,
    queue: null,
    ...overrides,
  }
}

const online: ServiceStatus[] = [
  { key: 'radarr', label: 'Radarr', state: 'online', reason: '' },
  { key: 'sonarr', label: 'Sonarr', state: 'online', reason: '' },
]

const disk: DiskResponse = {
  volumes: [
    {
      name: 'storage',
      path: '/mnt/storage',
      total_bytes: 4 * 1024 ** 4,
      used_bytes: 2.6 * 1024 ** 4,
      free_bytes: 1.4 * 1024 ** 4,
      percent: 65,
    },
  ],
}

function renderCards(props: Partial<Parameters<typeof DashboardCards>[0]> = {}) {
  const onOpenSeguimiento = vi.fn()
  const utils = render(
    <DashboardCards
      downloads={[]}
      disk={disk}
      summary={summary}
      traces={[]}
      services={online}
      onOpenSeguimiento={onOpenSeguimiento}
      {...props}
    />,
  )
  return { ...utils, onOpenSeguimiento }
}

describe('DashboardCards (diseño Stitch 01)', () => {
  it('card 1 counts problem downloads with a per-source breakdown and the warn footer', () => {
    renderCards({
      downloads: [
        download({ source: 'radarr', problem: true }),
        download({ source: 'radarr', problem: true }),
        download({ source: 'sonarr', problem: true }),
        download({ problem: false }),
      ],
    })

    expect(screen.getByText('Descargas atascadas')).toBeInTheDocument()
    expect(screen.getByText('3 elementos')).toBeInTheDocument()
    expect(screen.getByText('2 en Radarr, 1 en Sonarr')).toBeInTheDocument()
    expect(screen.getByText('Requiere revisión manual')).toBeInTheDocument()
  })

  it('omits the warn footer when nothing is stuck (honesty rule)', () => {
    renderCards({ downloads: [] })

    expect(screen.getByText('0 elementos')).toBeInTheDocument()
    expect(screen.queryByText('Requiere revisión manual')).not.toBeInTheDocument()
    expect(screen.queryByText(/en Radarr/)).not.toBeInTheDocument()
  })

  it('card 1 is the door to Seguimiento (C-11)', () => {
    const { onOpenSeguimiento } = renderCards()

    fireEvent.click(screen.getByRole('button', { name: /Descargas atascadas/ }))
    expect(onOpenSeguimiento).toHaveBeenCalledTimes(1)
  })

  it('card 2 counts blocked imports and shows the first blocked destination in mono', () => {
    renderCards({
      traces: [
        trace({ stage: 'import_blocked', destination: '/media/series/inbox' }),
        trace({ stage: 'sent' }),
      ],
    })

    expect(screen.getByText('Importaciones bloqueadas')).toBeInTheDocument()
    expect(screen.getByText('Destino: /media/series/inbox')).toBeInTheDocument()
  })

  it('omits card 2 footer when no blocked trace carries a destination', () => {
    renderCards({ traces: [] })

    expect(screen.queryByText(/^Destino:/)).not.toBeInTheDocument()
  })

  it('card 3 renders free space, total capacity and mount point from the disk payload', () => {
    renderCards()

    expect(screen.getByText('Espacio en disco')).toBeInTheDocument()
    expect(screen.getByText('1.4 TB libres')).toBeInTheDocument()
    expect(screen.getByText('Capacidad total: 4.0 TB')).toBeInTheDocument()
    expect(screen.getByText('Punto de montaje: /mnt/storage')).toBeInTheDocument()
  })

  it('card 3 stays honest when the disk payload is missing', () => {
    renderCards({ disk: undefined })

    expect(screen.getByText('Sin datos')).toBeInTheDocument()
    expect(screen.queryByText(/libres/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Punto de montaje:/)).not.toBeInTheDocument()
  })

  it('card 4 counts active services and joins the online labels', () => {
    renderCards()

    expect(screen.getByText('Estado de servicios')).toBeInTheDocument()
    expect(screen.getByText('2 de 2 activos')).toBeInTheDocument()
    expect(screen.getByText('Radarr y Sonarr operativos')).toBeInTheDocument()
  })

  it('card 4 footer reports each offline service with its real reason, and none when all are online', () => {
    const { rerender, container } = renderCards()
    expect(container.querySelector('.dash-foot.bad')).not.toBeInTheDocument()

    rerender(
      <DashboardCards
        downloads={[]}
        disk={disk}
        summary={summary}
        traces={[]}
        services={[
          { key: 'radarr', label: 'Radarr', state: 'online', reason: '' },
          { key: 'amutorrent', label: 'AmuTorrent', state: 'offline', reason: 'timeout tras 5s' },
        ]}
        onOpenSeguimiento={() => {}}
      />,
    )

    expect(screen.getByText('1 de 2 activos')).toBeInTheDocument()
    expect(screen.getByText('Radarr operativos')).toBeInTheDocument()
    expect(screen.getByText('AmuTorrent: timeout tras 5s')).toBeInTheDocument()
  })

  it('hides the services card when nothing is configured', () => {
    renderCards({ services: [] })

    expect(screen.queryByText('Estado de servicios')).not.toBeInTheDocument()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Seguimiento } from '../../components/Seguimiento'
import { queueStatus } from '../../api/files'
import type { ActionsResponse, Trace, TraceResponse } from '../../types'

/**
 * The kanban chosen in F-09 phase 0: the state IS the column.
 *
 * The mapping is the whole contract — six stages, four columns — and it is
 * where a regression would be silent (a trace sitting in the wrong column
 * still renders, still looks fine, and answers the operator's question with
 * the wrong answer). Everything else here guards the honesty rules: only
 * fields `/api/trace` actually carries get drawn, a blockage shows its
 * reason instead of a bare pill, and the per-trace actions Trazabilidad
 * carried live on the card — retiring the old page loses none of them.
 */

vi.mock('../../api/files', () => ({ queueStatus: vi.fn() }))

const queueStatusMock = vi.mocked(queueStatus)

const OPEN_ACTIONS: ActionsResponse = { actions: [], safe_mode: false, available: [] }

const RETRY_ACTIONS: ActionsResponse = {
  actions: [
    {
      key: 'retry_import',
      label: 'Reintentar import',
      description: 'Vuelve a lanzar el import en el arr',
      destructive: false,
      scope: 'import',
    },
  ],
  safe_mode: false,
  available: ['retry_import'],
}

function trace(over: Partial<Trace> = {}): Trace {
  return {
    source: 'radarr',
    title: 'Dune (2021)',
    date: '2026-10-07T11:42:00Z',
    indexer: 'AMULE',
    download_client: 'aMuTorrent',
    download_client_host: 'amutorrent',
    download_id: 'hash-1',
    matched_hash: 'hash-1',
    stage: 'downloading',
    torrent: {
      state: 'downloading',
      progress: 67,
      category: 'radarr',
      save_path: '/downloads',
      current_path: null,
      content_path: null,
      size: 6_710_886_400,
    },
    expected_category: 'radarr',
    category_ok: true,
    paused: false,
    ids: { queue_id: null, episode_id: null, movie_id: null, series_id: null },
    destination: null,
    queue: null,
    ...over,
  }
}

function summaryOf(traces: Trace[]) {
  const count = (fn: (t: Trace) => boolean) => traces.filter(fn).length
  return {
    downloading: count((t) => t.stage === 'downloading'),
    downloaded: count((t) => t.stage === 'downloaded'),
    import_blocked: count((t) => t.stage === 'import_blocked'),
    failed: count((t) => t.stage === 'failed'),
    sent: count((t) => t.stage === 'sent'),
    category_mismatches: count((t) => t.category_ok === false),
  }
}

function resp(traces: Trace[]): TraceResponse {
  return { traces, summary: summaryOf(traces), indexer: '', updated_at: 1 }
}

function renderView(
  data: TraceResponse | null,
  loading = false,
  actions: ActionsResponse = OPEN_ACTIONS,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Seguimiento
        data={data}
        loading={loading}
        actions={actions}
        onActionDone={() => {}}
      />
    </QueryClientProvider>,
  )
}

function column(container: HTMLElement, key: string): Element {
  const el = container.querySelector(`[data-col="${key}"]`)
  if (!el) throw new Error(`no column ${key}`)
  return el
}

beforeEach(() => {
  // Every render mounts the operations band and the sweep panel's history
  // read; tests that do not care still need an answer, or react-query warns
  // about an undefined payload and the history errors out loudly.
  queueStatusMock.mockResolvedValue({ queue: [], completed: [], running: false })
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as Response),
    ),
  )
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('the four columns', () => {
  it('maps every stage to the column the operator reads it in', () => {
    const traces = [
      trace({ stage: 'downloading', title: 'Descargando (2021)' }),
      trace({ stage: 'downloaded', title: 'Descargada (2022)' }),
      trace({ stage: 'importing', title: 'Importando (2023)' }),
      trace({ stage: 'import_blocked', title: 'Bloqueada (2014)' }),
      trace({ stage: 'failed', title: 'Fallida (2021)' }),
      trace({ stage: 'sent', title: 'Enviada (2024)' }),
    ]
    const { container } = renderView(resp(traces))

    expect(column(container, 'downloading').textContent).toContain('Descargando (2021)')
    // `downloaded` is "bytes arrived, import not yet": the operator experiences
    // it as importing, never as a fifth column of its own.
    expect(column(container, 'importing').textContent).toContain('Descargada (2022)')
    expect(column(container, 'importing').textContent).toContain('Importando (2023)')
    // A failure and a block both mean "the flow stopped here".
    expect(column(container, 'blocked').textContent).toContain('Bloqueada (2014)')
    expect(column(container, 'blocked').textContent).toContain('Fallida (2021)')
    expect(column(container, 'done').textContent).toContain('Enviada (2024)')
  })

  it('counts each column in its header', () => {
    const { container } = renderView(
      resp([
        trace({ stage: 'downloading', title: 'A' }),
        trace({ stage: 'downloading', title: 'B' }),
        trace({ stage: 'sent', title: 'C' }),
      ]),
    )

    expect(column(container, 'downloading').querySelector('.sg-col-count')).toHaveTextContent('2')
    expect(column(container, 'importing').querySelector('.sg-col-count')).toHaveTextContent('0')
    expect(column(container, 'blocked').querySelector('.sg-col-count')).toHaveTextContent('0')
    expect(column(container, 'done').querySelector('.sg-col-count')).toHaveTextContent('1')
  })

  it('keeps the stage pill telling blocked and failed apart inside the column', () => {
    const { container } = renderView(
      resp([
        trace({ stage: 'import_blocked', title: 'Bloqueada' }),
        trace({ stage: 'failed', title: 'Fallida' }),
      ]),
    )

    const blocked = column(container, 'blocked')
    expect(blocked.textContent).toContain('Import bloqueado')
    expect(blocked.textContent).toContain('Fallida')
  })
})

describe('what each card draws', () => {
  it('shows the queue message that explains a blockage', () => {
    const { container } = renderView(
      resp([
        trace({
          stage: 'import_blocked',
          title: 'Transformers (2014)',
          queue: {
            state: 'warning',
            status: 'importBlocked',
            output_path: '/data/movies/Transformers',
            messages: ['Sin ruta de importación: la carpeta queda fuera de las raíces'],
          },
        }),
      ]),
    )

    expect(container.textContent).toContain('Sin ruta de importación')
    expect(container.textContent).toContain('/data/movies/Transformers')
  })

  it('flags a wrong category instead of hiding it in the pill', () => {
    const { container } = renderView(
      resp([
        trace({
          stage: 'import_blocked',
          category_ok: false,
          expected_category: 'tv-sonarr',
          torrent: { ...trace().torrent!, category: 'amule' },
        }),
      ]),
    )

    // The label also exists in the summary strip, so the CARD's chip is what
    // this test is about: scoped to it, plus the expected category as tooltip.
    expect(container.querySelector('.sg-chip-warn')).toHaveTextContent('Cat. incorrecta')
    expect(screen.getByTitle('tv-sonarr')).toBeInTheDocument()
  })

  it('shows a progress bar only while there are bytes moving', () => {
    const { container, rerender } = renderView(
      resp([trace({ stage: 'downloading', title: 'Con progreso' })]),
    )

    expect(container.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '67')

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={client}>
        <Seguimiento
          data={resp([trace({ stage: 'sent', title: 'Sin progreso' })])}
          loading={false}
          actions={OPEN_ACTIONS}
          onActionDone={() => {}}
        />
      </QueryClientProvider>,
    )

    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('shows where a finished download ended up', () => {
    renderView(
      resp([
        trace({
          stage: 'sent',
          title: 'The Bear',
          destination: '/mnt/storage/tv/The Bear/Season 02',
        }),
      ]),
    )

    expect(screen.getByText(/→ \/mnt\/storage\/tv\/The Bear\/Season 02/)).toBeInTheDocument()
  })

  it('never invents a number the payload does not carry', () => {
    // No speed, no ETA on the card: `/api/trace` has no such field. The card
    // shows progress and path only — a guessed speed would be a lie.
    const { container } = renderView(resp([trace({ stage: 'downloading' })]))

    expect(container.textContent).not.toMatch(/MB\/s/)
    expect(container.textContent).not.toMatch(/ETA/)
  })
})

describe('the page states', () => {
  it('says so when there is nothing registered, instead of four empty columns', () => {
    renderView(resp([]))

    expect(screen.getByText('Sin descargas registradas.')).toBeInTheDocument()
  })

  it('says so while the first payload has not arrived', () => {
    renderView(null, true)

    expect(screen.getByText('Cargando seguimiento…')).toBeInTheDocument()
  })

  it('renders the summary strip from the payload', () => {
    const { container } = renderView(
      resp([
        trace({ stage: 'import_blocked' }),
        trace({ stage: 'failed' }),
        trace({ stage: 'sent' }),
      ]),
    )

    // Scoped to the strip: the same words appear again as stage pills on the
    // cards, and both being present is exactly the point of the page.
    const sum = container.querySelector('.sg-sum')
    expect(sum).not.toBeNull()
    expect(sum!.textContent).toContain('Import bloqueado')
    expect(sum!.textContent).toContain('Fallidas')
    expect(sum!.textContent).toContain('Completadas')
  })
})

describe('the actions Trazabilidad used to own', () => {
  it('offers a blocked trace its retry button on the card', () => {
    // The whole point of carrying TraceActions here: retiring the old page
    // must not take the only door to "Reintentar import" with it.
    renderView(
      resp([trace({ stage: 'import_blocked', title: 'Transformers (2014)' })]),
      false,
      RETRY_ACTIONS,
    )

    expect(screen.getByRole('button', { name: 'Reintentar import' })).toBeInTheDocument()
  })

  it('renders no action bar when the catalogue offers nothing', () => {
    const { container } = renderView(resp([trace({ stage: 'import_blocked' })]))

    expect(container.querySelector('.trace-actions')).toBeNull()
  })

  it('carries the sweep panel that used to live in Trazabilidad', () => {
    // "Revisar descargas" was reachable ONLY through the page being retired.
    renderView(resp([trace()]))

    expect(screen.getByRole('button', { name: 'Revisar descargas' })).toBeInTheDocument()
  })
})

describe('the operations band', () => {
  it('lists active operations with their progress and the recent ones after', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [
        {
          id: 'op-1',
          type: 'copy',
          name: 'Oppenheimer (2023)',
          src: '/downloads/Oppenheimer',
          dst: '/mnt/storage/movies/Oppenheimer',
          status: 'running',
          detail: null,
          progress: 49,
          copied_bytes: 3_328_599_654,
          total_bytes: 6_710_886_400,
          files_done: 1,
          files_total: 2,
          import_status: '',
        },
      ],
      completed: [
        {
          id: 'op-0',
          type: 'move',
          name: 'Godzilla Minus One (2023)',
          src: '/a',
          dst: '/b',
          status: 'done',
          detail: null,
          progress: 100,
          copied_bytes: 0,
          total_bytes: 0,
          files_done: 0,
          files_total: 0,
          import_status: 'imported',
        },
      ],
      running: true,
    })

    renderView(resp([trace()]))

    await waitFor(() => expect(screen.getByText('Oppenheimer (2023)')).toBeInTheDocument())
    expect(screen.getByText('Copiar')).toBeInTheDocument()
    expect(screen.getByText(/49%/)).toBeInTheDocument()
    expect(screen.getByText('en curso')).toBeInTheDocument()
    expect(screen.getByText('Godzilla Minus One (2023)')).toBeInTheDocument()
    expect(screen.getByText('hecha')).toBeInTheDocument()
    expect(queueStatusMock).toHaveBeenCalled()
  })
})

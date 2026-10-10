import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Seguimiento } from '../../pages/Seguimiento.tsx'
import { queueCancel, queueStatus } from '../../shared/api/files.ts'
import type { ActionsResponse, Trace, TraceResponse } from '../../shared/types.ts'

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

vi.mock('../../shared/api/files', () => ({ queueStatus: vi.fn(), queueCancel: vi.fn() }))

const queueStatusMock = vi.mocked(queueStatus)
const queueCancelMock = vi.mocked(queueCancel)

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

  it('carries the sweep panel that used to live in Trazabilidad — in the tail', () => {
    // "Revisar descargas" was reachable ONLY through the page being retired.
    // It must exist, and it must NOT sit on top of the board: the top of this
    // page is the kanban and nothing else (the old section's header block must
    // not resurface here).
    const { container } = renderView(resp([trace()]))

    expect(screen.getByRole('button', { name: 'Revisar descargas' })).toBeInTheDocument()
    expect(container.querySelector('.sg-ops .auto-copy')).not.toBeNull()
    expect(container.querySelector('.sg > .auto-copy')).toBeNull()
    expect(container.querySelector('.sg-sum')).toBeNull()
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

describe('the operations tail carries the retired sidebar\'s duties', () => {
  const runningOp = {
    id: 'op-9',
    type: 'copy',
    name: 'Movie (2024)',
    src: '/src/movie',
    dst: '/dst/movie',
    status: 'running',
    detail: null,
    progress: 40,
    copied_bytes: 400,
    total_bytes: 1000,
    files_done: 1,
    files_total: 2,
    import_status: '',
  }

  it('cancels an active operation from its row', async () => {
    queueStatusMock.mockResolvedValue({ queue: [runningOp], completed: [], running: true })

    renderView(resp([trace()]))

    const cancel = await screen.findByTitle('Cancelar operación')
    fireEvent.click(cancel)

    await waitFor(() => expect(queueCancelMock).toHaveBeenCalled())
    // react-query passes its own context as a second argument.
    expect(queueCancelMock.mock.calls[0][0]).toBe('op-9')
  })

  it('offers no cancel on a finished row', async () => {
    queueStatusMock.mockResolvedValue({ queue: [], completed: [{ ...runningOp, status: 'done', import_status: 'imported' }], running: false })

    renderView(resp([trace()]))

    await screen.findByText('Movie (2024)')
    expect(screen.queryByTitle('Cancelar operación')).toBeNull()
  })

  it('refreshes the lists when an operation reports its import finished', async () => {
    // The effect the QueueSidebar carried shell-wide: without it the
    // grabbed-marks the lists draw go stale after our own copy imports.
    queueStatusMock.mockResolvedValue({
      queue: [],
      completed: [{ ...runningOp, status: 'done', import_status: 'imported' }],
      running: false,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const spy = vi.spyOn(client, 'invalidateQueries')

    render(
      <QueryClientProvider client={client}>
        <Seguimiento data={resp([trace()])} loading={false} actions={OPEN_ACTIONS} onActionDone={() => {}} />
      </QueryClientProvider>,
    )

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ['wanted-movies-infinite'] }),
    )
  })
})

describe('the detail panel', () => {
  /** The `dt`/`dd` value of a labelled row inside the panel (null = no such row). */
  function field(panel: HTMLElement, label: string): string | null {
    const dt = [...panel.querySelectorAll('dt')].find((d) => d.textContent === label)
    const dd = dt?.nextElementSibling ?? null
    return dd ? (dd.textContent ?? '').trim() : null
  }

  it('draws every real field /api/trace carries — and no speed, no ETA', () => {
    // The honesty rule the cards already inherit (Seguimiento header): the
    // panel is the FULL truth of the payload, so it may only draw fields the
    // payload actually carries. A guessed speed would be its first lie too.
    renderView(resp([trace()]))

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))

    const panel = screen.getByRole('complementary', { name: 'Detalle de Dune (2021)' })
    expect(within(panel).getByRole('heading', { name: 'Dune (2021)' })).toBeInTheDocument()

    // Identity + status
    expect(field(panel, 'Etapa')).toBe('Descargando')
    expect(field(panel, 'Fecha')).toBe('2026-10-07T11:42:00Z')
    expect(field(panel, 'Índice')).toBe('AMULE')
    expect(field(panel, 'Cliente de descarga')).toBe('aMuTorrent')
    expect(field(panel, 'Host del cliente')).toBe('amutorrent')
    expect(field(panel, 'ID de descarga')).toBe('hash-1')
    expect(field(panel, 'Hash emparejado')).toBe('hash-1')
    expect(field(panel, 'Pausa')).toBe('No')

    // Torrent facts — progress is a real field, drawn as the card draws it
    expect(field(panel, 'Progreso')).toContain('67%')
    const bar = within(panel).getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '67')
    expect(field(panel, 'Estado del torrent')).toBe('downloading')
    expect(field(panel, 'Categoría')).toBe('radarr')
    expect(field(panel, 'Categoría esperada')).toBe('radarr')
    expect(field(panel, 'Tamaño')).toBe('6.3 GB')
    expect(field(panel, 'Guardado en')).toBe('/downloads')

    // Absent facts say so with the empty marker — never with an invention
    expect(field(panel, 'Destino')).toBe('—')
    expect(field(panel, 'ID de cola')).toBe('—')

    // The honesty pin: the payload has no speed and no ETA, so the panel
    // must not draw either (same rule the cards are held to).
    const text = panel.textContent ?? ''
    expect(text).not.toMatch(/MB\/s/)
    expect(text).not.toMatch(/ETA/)
    expect(text).not.toMatch(/velocidad/i)
  })

  it('explains a block with every queue message and the category verdict', () => {
    renderView(
      resp([
        trace({
          stage: 'import_blocked',
          title: 'Transformers (2014)',
          category_ok: false,
          expected_category: 'tv-sonarr',
          torrent: { ...trace().torrent!, category: 'amule' },
          queue: {
            state: 'warning',
            status: 'importBlocked',
            output_path: '/data/movies/Transformers',
            messages: ['motivo uno', 'motivo dos'],
          },
        }),
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))

    const panel = screen.getByRole('complementary', { name: 'Detalle de Transformers (2014)' })
    expect(field(panel, 'Etapa')).toBe('Import bloqueado')
    // The card draws only the FIRST message; the panel carries them all.
    expect(within(panel).getByText('motivo uno')).toBeInTheDocument()
    expect(within(panel).getByText('motivo dos')).toBeInTheDocument()
    expect(within(panel).getByText('Cat. incorrecta')).toBeInTheDocument()
    expect(field(panel, 'Categoría')).toBe('amule')
    expect(field(panel, 'Categoría esperada')).toBe('tv-sonarr')
    expect(field(panel, 'Estado de la cola')).toBe('warning')
    expect(field(panel, 'Estado de importación')).toBe('importBlocked')
    expect(field(panel, 'Ruta de salida')).toBe('/data/movies/Transformers')
  })

  it('closes from its button and from Escape', () => {
    renderView(resp([trace()]))

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))
    expect(screen.getByRole('complementary', { name: 'Detalle de Dune (2021)' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalle' }))
    expect(screen.queryByRole('complementary')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('swaps its content in place when another card is selected', () => {
    renderView(
      resp([
        trace({ title: 'Dune (2021)', download_id: 'hash-a' }),
        trace({ title: 'The Bear', download_id: 'hash-b', stage: 'sent' }),
      ]),
    )

    fireEvent.click(
      within(screen.getByRole('article', { name: 'Dune (2021)' })).getByRole('button', {
        name: 'Ver detalles',
      }),
    )
    expect(
      screen.getByRole('complementary', { name: 'Detalle de Dune (2021)' }),
    ).toBeInTheDocument()

    fireEvent.click(
      within(screen.getByRole('article', { name: 'The Bear' })).getByRole('button', {
        name: 'Ver detalles',
      }),
    )

    // One panel, new content — the open panel swaps, never stacks.
    const panels = screen.getAllByRole('complementary')
    expect(panels).toHaveLength(1)
    expect(panels[0]).toHaveAccessibleName('Detalle de The Bear')
    expect(screen.queryByRole('complementary', { name: 'Detalle de Dune (2021)' })).toBeNull()
  })

  it('closes itself when the record leaves the payload', () => {
    // The panel is derived from the trace list, not from a copied snapshot:
    // a download that disappears (cancelled, acked away) must not leave a
    // stale detail open over a board that no longer has its card.
    const { rerender } = renderView(resp([trace()]))

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))
    expect(screen.getByRole('complementary')).toBeInTheDocument()

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={client}>
        <Seguimiento data={resp([])} loading={false} actions={OPEN_ACTIONS} onActionDone={() => {}} />
      </QueryClientProvider>,
    )

    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.getByText('Sin descargas registradas.')).toBeInTheDocument()
  })

  it('leaves the board/tail DOM contract untouched while open', () => {
    // The e2e contract (kanban-fit.spec.ts:139-150, :153-188): `.sg` IS the
    // board + tail, exactly two children, and the 70/30 split is measured on
    // those two boxes. The panel must live OUTSIDE `.sg` so opening it can
    // change neither — an overlay, not a third flex child.
    const { container } = renderView(
      resp([trace({ title: 'Dune (2021)', download_id: 'hash-a' }), trace({ title: 'Otra', download_id: 'hash-b' })]),
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Ver detalles' })[0])
    expect(screen.getByRole('complementary')).toBeInTheDocument()

    const sg = container.querySelector('.sg')
    expect(sg).not.toBeNull()
    expect([...sg!.children].map((el) => el.className)).toEqual(['sg-board', 'sg-ops'])
    expect(sg!.contains(screen.getByRole('complementary'))).toBe(false)
    // The tail coexists: still mounted, still the home of the sweep.
    expect(container.querySelector('.sg-ops')).not.toBeNull()
    expect(container.querySelector('.sg-ops .auto-copy')).not.toBeNull()
    expect(container.querySelectorAll('.sg-col')).toHaveLength(4)
    // …and the overlay is rendered, just not inside the measured grid.
    expect(container.querySelector('.sg-det')).not.toBeNull()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Seguimiento } from '../../pages/Seguimiento.tsx'
import { completeQueueOp, queueCancel, queueStatus } from '../../shared/api/files.ts'
import type { MuxTask } from '../../shared/api/mixer.ts'
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

vi.mock('../../shared/api/files', () => ({
  queueStatus: vi.fn(),
  queueCancel: vi.fn(),
  completeQueueOp: vi.fn(),
}))

const queueStatusMock = vi.mocked(queueStatus)
const queueCancelMock = vi.mocked(queueCancel)
const completeQueueOpMock = vi.mocked(completeQueueOp)

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

  /** The `<section>` a labelled row lives in, keyed by its visible heading. */
  function sectionOf(panel: HTMLElement, heading: string): Element | null {
    const h = [...panel.querySelectorAll('h4')].find((el) => el.textContent === heading)
    return h?.closest('section') ?? null
  }

  it('groups the body into General, Ficheros and Bloqueo/Cola sections', () => {
    // The Stitch 05 design restructures the flat <dl> into three visible
    // groups: an operator scanning the panel reads the headings, not ~20
    // bare rows. Each expected fact must land in ITS section, not just exist.
    renderView(
      resp([
        trace({
          queue: {
            state: 'warning',
            status: 'importBlocked',
            output_path: '/data/movies/Dune',
            messages: ['motivo uno'],
          },
        }),
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))

    const panel = screen.getByRole('complementary', { name: 'Detalle de Dune (2021)' })
    expect(within(panel).getByRole('heading', { name: 'General', level: 4 })).toBeInTheDocument()
    expect(within(panel).getByRole('heading', { name: 'Ficheros', level: 4 })).toBeInTheDocument()
    expect(
      within(panel).getByRole('heading', { name: 'Bloqueo/Cola', level: 4 }),
    ).toBeInTheDocument()

    const labelsIn = (heading: string) =>
      [...(sectionOf(panel, heading)?.querySelectorAll('dt') ?? [])].map((d) => d.textContent)

    expect(labelsIn('General')).toEqual(
      expect.arrayContaining(['Etapa', 'Fecha', 'Índice', 'Pausa', 'Progreso']),
    )
    expect(labelsIn('Ficheros')).toEqual(
      expect.arrayContaining(['Estado del torrent', 'Guardado en', 'Destino', 'Ruta de salida']),
    )
    expect(labelsIn('Bloqueo/Cola')).toEqual(
      expect.arrayContaining(['Estado de la cola', 'Categoría esperada', 'ID de cola']),
    )
  })

  it('carries the release title inside the header zone', () => {
    // Design 05: the header row IS title + pill + chips + close. The title
    // below the header (the old markup) is the layout bug being fixed.
    renderView(resp([trace()]))

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))

    const panel = screen.getByRole('complementary', { name: 'Detalle de Dune (2021)' })
    const title = within(panel).getByRole('heading', { name: 'Dune (2021)' })
    const head = panel.querySelector('.sg-det-head')
    expect(head).not.toBeNull()
    expect(head!.contains(title)).toBe(true)
    // The close button keeps its top-right home in that same zone.
    expect(head!.querySelector('.sg-det-close')).not.toBeNull()
  })

  it('marks path and ID values with the mono styling hook', () => {
    // C-06 token contract: mono is for machine facts (paths, IDs) only —
    // a human label like "Etapa" must NOT read as an identifier.
    renderView(resp([trace()]))

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))

    const panel = screen.getByRole('complementary', { name: 'Detalle de Dune (2021)' })
    const classesOf = (label: string) => {
      const dt = [...panel.querySelectorAll('dt')].find((d) => d.textContent === label)
      return dt?.nextElementSibling?.classList ?? null
    }

    expect(classesOf('ID de descarga')).toContain('sg-det-mono')
    expect(classesOf('Hash emparejado')).toContain('sg-det-mono')
    expect(classesOf('Guardado en')).toContain('sg-det-mono')
    expect(classesOf('Índice')).not.toContain('sg-det-mono')
    expect(classesOf('Etapa')).not.toContain('sg-det-mono')
  })

  it('renders every block message the payload carries, in order', () => {
    // The card shows only the FIRST message; the panel carries them all.
    // Order matters: the queue reports causes in sequence.
    renderView(
      resp([
        trace({
          stage: 'import_blocked',
          title: 'Transformers (2014)',
          queue: {
            state: 'warning',
            status: 'importBlocked',
            output_path: '/data/movies/Transformers',
            messages: ['motivo uno', 'motivo dos', 'motivo tres'],
          },
        }),
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))

    const panel = screen.getByRole('complementary', { name: 'Detalle de Transformers (2014)' })
    const why = panel.querySelector('.sg-det-why')
    expect(why).not.toBeNull()
    const text = why!.textContent ?? ''
    expect(text).toContain('motivo uno')
    expect(text).toContain('motivo dos')
    expect(text).toContain('motivo tres')
    expect(text.indexOf('motivo uno')).toBeLessThan(text.indexOf('motivo dos'))
    expect(text.indexOf('motivo dos')).toBeLessThan(text.indexOf('motivo tres'))
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

describe('the Mezclas band (S11)', () => {
  function mixTask(over: Partial<MuxTask> = {}): MuxTask {
    return {
      task_id: 'm-1',
      status: 'running',
      progress: 0,
      detail: '',
      output_path: null,
      created_at: 1,
      ...over,
    }
  }

  /** `/api/mixer/tasks` with a mutable queue so a control can retire a row. */
  function stubMixer(state: { tasks: MuxTask[] }, onCall?: (url: string) => void) {
    const calls: { url: string; method: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, method: init?.method ?? 'GET' })
        onCall?.(url)
        if (url.includes('/api/mixer/tasks')) {
          return { ok: true, json: async () => ({ tasks: state.tasks }) } as Response
        }
        return { ok: true, json: async () => ({ items: [] }) } as Response
      }),
    )
    return calls
  }

  async function mixBand(): Promise<HTMLElement> {
    const heading = await screen.findByRole('heading', { name: /Mezclas/ })
    return heading.closest('section') as HTMLElement
  }

  it('renders the queue rows as received: running with progress, queued waiting, terminal rows', async () => {
    stubMixer({
      tasks: [
        mixTask({ task_id: 'm-run', status: 'running', progress: 0.42, detail: 'mezclando vídeo', output_path: '/mnt/movies/Dune.mkv', created_at: 3 }),
        mixTask({ task_id: 'm-q', status: 'queued', progress: 0, detail: 'espera FIFO', created_at: 4 }),
        mixTask({ task_id: 'm-done', status: 'done', progress: 1, detail: 'sustituido', created_at: 2 }),
        mixTask({ task_id: 'm-err', status: 'error', progress: 0.7, detail: 'ffmpeg falló', created_at: 1 }),
      ],
    })
    renderView(resp([trace()]))

    const band = await mixBand()
    await within(band).findByText('mezclando vídeo')
    const rows = [...band.querySelectorAll('.sg-mix-row')]

    // The backend sends queue order (running first, queued FIFO, terminal
    // last) — the band renders it as-is, no re-sorting.
    expect(rows.map((r) => r.querySelector('.sg-mix-detail')?.textContent)).toEqual([
      'mezclando vídeo',
      'espera FIFO',
      'sustituido',
      'ffmpeg falló',
    ])

    // The running row carries a real progress bar whose width follows the
    // 0..1 `progress` fraction.
    const fill = rows[0].querySelector('.mixer-progress-fill') as HTMLElement | null
    expect(fill).not.toBeNull()
    expect(fill!.style.width).toBe('42%')

    // The queued row shows its waiting state and no progress bar.
    expect(rows[1].textContent).toContain('En cola')
    expect(rows[1].querySelector('.mixer-progress-fill')).toBeNull()

    // Recent terminal rows keep their place at the tail.
    expect(rows[2].textContent).toContain('Completada')
    expect(rows[3].textContent).toContain('Error')
  })

  it('cancelling a queued row calls the cancel endpoint and the row disappears after refetch', async () => {
    const state = {
      tasks: [mixTask({ task_id: 'm-q', status: 'queued', progress: 0, detail: 'espera FIFO', created_at: 2 })],
    }
    const calls = stubMixer(state, (url) => {
      if (url === '/api/mixer/tasks/m-q/cancel') state.tasks = []
    })
    renderView(resp([trace()]))

    const band = await mixBand()
    const cancel = await within(band).findByRole('button', { name: '✕ Cancelar tarea' })
    fireEvent.click(cancel)

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/api/mixer/tasks/m-q/cancel' && c.method === 'POST'),
      ).toBe(true),
    )
    // A cancelled queued mix is retired without running: the refetch shows it.
    await waitFor(() => expect(within(band).queryByText('espera FIFO')).toBeNull())
  })

  it('wires «Pausar» / «Reanudar» to the pause and resume endpoints', async () => {
    const state = {
      tasks: [
        mixTask({ task_id: 'm-run', status: 'running', progress: 0.3, detail: 'mezclando', created_at: 2 }),
        mixTask({ task_id: 'm-pa', status: 'paused', progress: 0.3, detail: 'en pausa', created_at: 1 }),
      ],
    }
    const calls = stubMixer(state)
    renderView(resp([trace()]))

    const band = await mixBand()
    fireEvent.click(await within(band).findByRole('button', { name: '⏸ Pausar' }))
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/api/mixer/tasks/m-run/pause' && c.method === 'POST'),
      ).toBe(true),
    )

    fireEvent.click(within(band).getByRole('button', { name: '▶ Reanudar' }))
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/api/mixer/tasks/m-pa/resume' && c.method === 'POST'),
      ).toBe(true),
    )
  })
})

describe('marking a blocked operation as completed (T1/S3)', () => {
  const stuckOp = {
    id: 'op-7',
    type: 'copy',
    name: 'Blade Runner (1982)',
    src: '/downloads/Blade Runner',
    dst: '/mnt/storage/movies/Blade Runner',
    status: 'running',
    detail: null,
    progress: 100,
    copied_bytes: 100,
    total_bytes: 100,
    files_done: 1,
    files_total: 1,
    import_status: '',
  }

  it('offers the manual completion on an active row and calls the endpoint', async () => {
    queueStatusMock.mockResolvedValue({ queue: [stuckOp], completed: [], running: false })
    completeQueueOpMock.mockResolvedValue({ ok: true, detail: 'Operación marcada como completada' })

    renderView(resp([trace()]))

    const button = await screen.findByRole('button', { name: 'Marcar como completada' })
    fireEvent.click(button)

    // react-query appends its mutation context as a second argument — assert
    // the first one, same as the cancel test above (mock.calls[0][0]).
    await waitFor(() => expect(completeQueueOpMock.mock.calls[0][0]).toBe('op-7'))
  })

  it('also offers it on a stuck archived row whose status never settled', async () => {
    queueStatusMock.mockResolvedValue({ queue: [], completed: [stuckOp], running: false })

    renderView(resp([trace()]))

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Marcar como completada' }),
      ).toBeInTheDocument(),
    )
  })

  it('does not offer it on rows that already settled', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [],
      completed: [
        { ...stuckOp, id: 'd1', status: 'done' },
        { ...stuckOp, id: 'f1', status: 'failed' },
      ],
      running: false,
    })

    renderView(resp([trace()]))

    await waitFor(() => expect(screen.getByText('hecha')).toBeInTheDocument())
    expect(
      screen.queryByRole('button', { name: 'Marcar como completada' }),
    ).toBeNull()
  })
})

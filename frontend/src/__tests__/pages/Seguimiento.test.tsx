import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Seguimiento } from '../../pages/Seguimiento.tsx'
import { completeQueueOp, queueCancel, queueStatus, type QueueOp } from '../../shared/api/files.ts'
import type { MuxTask } from '../../shared/api/mixer.ts'
import type { ActionsResponse, Trace, TraceResponse } from '../../shared/types.ts'

/**
 * S2's unified task list (decision L3: «Vista única con filtros»): ONE list of
 * rows — traces + copy operations + mix tasks — under filter tabs, replacing
 * the board+tail stacking this view used to pin.
 *
 * The mapping is the whole contract — every source status lands in exactly one
 * of «Activas» / «Completadas» / «Errores» — and it is where a regression would
 * be silent (a row sitting under the wrong tab still renders, still looks fine,
 * and answers the operator's question with the wrong answer). Everything else
 * here guards the honesty rules the old cards inherited: only fields the
 * payloads actually carry get drawn, a blockage shows its reason instead of a
 * bare pill, and every source keeps its real controls — retiring the board
 * must lose none of them.
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

/** The one list S2 is about — the only place task rows may live. */
function list(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.sg-list')
  if (!el) throw new Error('no unified task list')
  return el as HTMLElement
}

/** The rows of a box, in DOM order, by their accessible name. */
function rowNames(box: HTMLElement): string[] {
  return [...box.querySelectorAll('.sg-row')].map(
    (r) => r.getAttribute('aria-label') ?? '',
  )
}

/** Open one of the filter tabs by its visible label. */
function openTab(name: string | RegExp) {
  fireEvent.click(screen.getByRole('tab', { name }))
}

function opRow(over: Partial<QueueOp> = {}): QueueOp {
  return {
    id: 'op-1',
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
    ...over,
  }
}

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

beforeEach(() => {
  // Every render mounts the copy-queue poll and the sweep panel's history
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
  // The highlight tests carry the target in the hash; nothing may leak into
  // the next test through the URL.
  window.location.hash = ''
})

describe('the unified task list (S2)', () => {
  it('shows the filter tabs — «Activas (n)» selected by default — and one global counter', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [opRow({ id: 'op-run', name: 'copia en curso' })],
      completed: [opRow({ id: 'op-done', name: 'copia hecha', status: 'done', import_status: 'imported' })],
      running: true,
    })
    stubMixer({
      tasks: [
        mixTask({ task_id: 'm-run', status: 'running', progress: 0.5, detail: 'mezcla X', created_at: 2 }),
        mixTask({ task_id: 'm-err', status: 'error', progress: 0.5, detail: 'mezcla Y', created_at: 1 }),
      ],
    })

    renderView(
      resp([
        trace({ title: 'Dune Parte Dos', download_id: 'h-1' }),
        trace({ title: 'The Bear', download_id: 'h-2' }),
        trace({ title: 'Oppenheimer', download_id: 'h-3', stage: 'sent' }),
      ]),
    )

    // The exact UI of decision L3: «Activas (n)» (the default) / «Completadas»
    // / «Errores», plus one global counter over every row of every source.
    // Actives: 2 traces + 1 copy op + 1 mix; the counter counts all 7 rows.
    const active = await screen.findByRole('tab', { name: 'Activas (4)' })
    expect(active).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Completadas' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(screen.getByRole('tab', { name: 'Errores' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    await screen.findByText('7 tareas')
  })

  it('merges traces, copy operations and mix tasks as rows in ONE list', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [opRow({ id: 'op-1', name: 'copia Y en curso' })],
      completed: [],
      running: true,
    })
    stubMixer({
      tasks: [mixTask({ task_id: 'm-1', status: 'queued', detail: 'mezcla X en cola' })],
    })

    const { container } = renderView(resp([trace({ title: 'Dune Parte Dos' })]))

    await screen.findByText('copia Y en curso')
    await screen.findByText('mezcla X en cola')
    const lists = container.querySelectorAll('.sg-list')
    expect(lists).toHaveLength(1)
    const rows = [...lists[0].querySelectorAll('.sg-row')]
    expect(rows.map((r) => r.className)).toEqual([
      expect.stringContaining('sg-row-trace'),
      expect.stringContaining('sg-row-copy'),
      expect.stringContaining('sg-row-mix'),
    ])
    expect(rowNames(lists[0] as HTMLElement)).toEqual([
      'Dune Parte Dos',
      'copia Y en curso',
      'mezcla X en cola',
    ])
  })

  it('hides completed and failed rows under their own tabs — the default view is Actives only', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [opRow({ id: 'op-run', name: 'copia activa' })],
      completed: [opRow({ id: 'op-done', name: 'copia hecha', status: 'done', import_status: 'imported' })],
      running: true,
    })
    stubMixer({
      tasks: [mixTask({ task_id: 'm-err', status: 'error', detail: 'mezcla rota' })],
    })

    const { container } = renderView(resp([trace({ title: 'Descarga activa' })]))

    await screen.findByText('copia activa')
    expect(rowNames(list(container))).toEqual(['Descarga activa', 'copia activa'])

    openTab('Completadas')
    await screen.findByText('copia hecha')
    expect(rowNames(list(container))).toEqual(['copia hecha'])

    openTab('Errores')
    await screen.findByText('mezcla rota')
    expect(rowNames(list(container))).toEqual(['mezcla rota'])

    // Switching back re-hides them: the tabs are filters, not a reordering.
    openTab(/Activas/)
    expect(rowNames(list(container))).toEqual(['Descarga activa', 'copia activa'])
  })

  it('keeps every source\'s real progress and controls on its row', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [
        opRow({
          id: 'op-1',
          name: 'copia Y',
          progress: 49,
          copied_bytes: 3_328_599_654,
          total_bytes: 6_710_886_400,
        }),
      ],
      completed: [],
      running: true,
    })
    stubMixer({
      tasks: [mixTask({ task_id: 'm-1', status: 'running', progress: 0.42, detail: 'mezcla X' })],
    })

    const { container } = renderView(
      resp([trace({ title: 'Dune Parte Dos', stage: 'downloaded' })]),
      false,
      RETRY_ACTIONS,
    )

    await screen.findByText('mezcla X')
    await screen.findByText('copia Y')
    const traceRow = container.querySelector('.sg-row-trace') as HTMLElement
    expect(within(traceRow).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '67')
    expect(within(traceRow).getByRole('button', { name: 'Reintentar import' })).toBeInTheDocument()
    expect(within(traceRow).getByRole('button', { name: 'Ver detalles' })).toBeInTheDocument()

    const copyRow = container.querySelector('.sg-row-copy') as HTMLElement
    expect(copyRow.textContent).toContain('49%')
    expect(within(copyRow).getByTitle('Cancelar operación')).toBeInTheDocument()
    expect(
      within(copyRow).getByRole('button', { name: 'Marcar como completada' }),
    ).toBeInTheDocument()

    const mixRow = container.querySelector('.sg-row-mix') as HTMLElement
    const fill = mixRow.querySelector('.mixer-progress-fill') as HTMLElement
    expect(fill.style.width).toBe('42%')
    expect(within(mixRow).getByRole('button', { name: '⏸ Pausar' })).toBeInTheDocument()
    expect(within(mixRow).getByRole('button', { name: '✕ Cancelar tarea' })).toBeInTheDocument()
  })
})

describe('status → tab mapping (the whole contract)', () => {
  it('maps every trace stage by its column semantics: moving → Activas, stopped → Errores, sent → Completadas', () => {
    const { container } = renderView(
      resp([
        trace({ stage: 'downloading', title: 'Descargando (2021)' }),
        trace({ stage: 'downloaded', title: 'Descargada (2022)' }),
        trace({ stage: 'importing', title: 'Importando (2023)' }),
        trace({ stage: 'import_blocked', title: 'Bloqueada (2014)' }),
        trace({ stage: 'failed', title: 'Fallida (2021)' }),
        trace({ stage: 'sent', title: 'Enviada (2024)' }),
      ]),
    )

    // The flow still moving is Activa: `downloaded` is "bytes arrived, the
    // import has not" — the operator experiences it as importing, and both
    // ride the same tab as `downloading`.
    expect(rowNames(list(container))).toEqual([
      'Descargando (2021)',
      'Descargada (2022)',
      'Importando (2023)',
    ])

    // A failure and a block both mean "the flow stopped here" (the old
    // «Bloqueado» column): both are Errores, and the pill on each row keeps
    // telling them apart.
    openTab('Errores')
    expect(rowNames(list(container))).toEqual(['Bloqueada (2014)', 'Fallida (2021)'])
    expect(list(container).textContent).toContain('Import bloqueado')
    expect(list(container).textContent).toContain('Fallida')

    openTab('Completadas')
    expect(rowNames(list(container))).toEqual(['Enviada (2024)'])
  })

  it('maps copy operations: pending/running → Activas, done → Completadas, failed/cancelled → Errores', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [
        opRow({ id: 'op-p', name: 'op en cola', status: 'pending' }),
        opRow({ id: 'op-r', name: 'op en curso', status: 'running' }),
      ],
      completed: [
        opRow({ id: 'op-d', name: 'op hecha', status: 'done', import_status: 'imported' }),
        opRow({ id: 'op-f', name: 'op fallida', status: 'failed' }),
        opRow({ id: 'op-c', name: 'op cancelada', status: 'cancelled' }),
      ],
      running: true,
    })

    const { container } = renderView(resp([]))

    await screen.findByText('op en curso')
    expect(rowNames(list(container))).toEqual(['op en cola', 'op en curso'])

    openTab('Completadas')
    expect(rowNames(list(container))).toEqual(['op hecha'])

    openTab('Errores')
    expect(rowNames(list(container))).toEqual(['op cancelada', 'op fallida'])
  })

  it('maps mix tasks: running/queued/paused → Activas, done → Completadas, error/cancelled → Errores', async () => {
    stubMixer({
      tasks: [
        mixTask({ task_id: 'm-1', status: 'running', detail: 'corriendo', created_at: 6 }),
        mixTask({ task_id: 'm-2', status: 'queued', detail: 'en espera', created_at: 5 }),
        mixTask({ task_id: 'm-3', status: 'paused', detail: 'pausada', created_at: 4 }),
        mixTask({ task_id: 'm-4', status: 'done', detail: 'sustituida', created_at: 3 }),
        mixTask({ task_id: 'm-5', status: 'error', detail: 'ffmpeg falló', created_at: 2 }),
        mixTask({ task_id: 'm-6', status: 'cancelled', detail: 'cancelada', created_at: 1 }),
      ],
    })

    const { container } = renderView(resp([]))

    await screen.findByText('corriendo')
    expect(rowNames(list(container))).toEqual(['corriendo', 'en espera', 'pausada'])

    openTab('Completadas')
    expect(rowNames(list(container))).toEqual(['sustituida'])

    openTab('Errores')
    expect(rowNames(list(container))).toEqual(['ffmpeg falló', 'cancelada'])
  })
})

describe('what each row draws', () => {
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

    // A block is an Error row (S2): it lives under «Errores», not the default
    // view — the tab is part of reaching the row at all.
    openTab('Errores')
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

    openTab('Errores')
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

    // The finished row is under «Completadas» (S2) — open it so the pin is
    // about the row's bar, not about the row being hidden.
    openTab('Completadas')
    expect(screen.getByText('Sin progreso')).toBeInTheDocument()
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

    openTab('Completadas')
    expect(screen.getByText(/→ \/mnt\/storage\/tv\/The Bear\/Season 02/)).toBeInTheDocument()
  })

  it('never invents a number the payload does not carry', () => {
    // No speed, no ETA on the row: `/api/trace` has no such field. The row
    // shows progress and path only — a guessed speed would be a lie.
    const { container } = renderView(resp([trace({ stage: 'downloading' })]))

    expect(container.textContent).not.toMatch(/MB\/s/)
    expect(container.textContent).not.toMatch(/ETA/)
  })

  it('renders rows in a stable order — traces, then copy operations, then mix tasks', async () => {
    // T3's seam: hoisting a just-submitted mix to the top of «Activas» must be
    // a reorder of THIS list, not a second list beside it. Source order inside
    // each kind is the payload order (traces as reported, active queue before
    // recent, mixes as the backend sends them) — never re-sorted here.
    queueStatusMock.mockResolvedValue({
      queue: [opRow({ id: 'op-1', name: 'copia uno' }), opRow({ id: 'op-2', name: 'copia dos' })],
      completed: [],
      running: true,
    })
    stubMixer({
      tasks: [
        mixTask({ task_id: 'm-1', status: 'running', detail: 'mezcla uno', created_at: 2 }),
        mixTask({ task_id: 'm-2', status: 'queued', detail: 'mezcla dos', created_at: 1 }),
      ],
    })

    const { container } = renderView(
      resp([
        trace({ title: 'traza uno', download_id: 'h-1' }),
        trace({ title: 'traza dos', download_id: 'h-2' }),
      ]),
    )

    await screen.findByText('mezcla dos')
    expect(rowNames(list(container))).toEqual([
      'traza uno',
      'traza dos',
      'copia uno',
      'copia dos',
      'mezcla uno',
      'mezcla dos',
    ])
  })
})

describe('the page states', () => {
  it('says so when nothing is tracked at all — one empty list, not a board', () => {
    const { container } = renderView(resp([]))

    expect(screen.getByText('Sin descargas registradas.')).toBeInTheDocument()
    // The board is gone for good: the empty state is the list's own message.
    expect(container.querySelector('.sg-board')).toBeNull()
    expect(container.querySelectorAll('.sg-col')).toHaveLength(0)
  })

  it('says so while the first payload has not arrived', () => {
    renderView(null, true)

    expect(screen.getByText('Cargando seguimiento…')).toBeInTheDocument()
  })

  it('says so when the open tab holds nothing, without hiding rows of the others', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [],
      completed: [opRow({ id: 'op-d', name: 'copia hecha', status: 'done', import_status: 'imported' })],
      running: false,
    })

    const { container } = renderView(resp([trace({ title: 'Descarga activa' })]))

    // Sync on the global counter: the hidden row still counts once it lands.
    await screen.findByText('2 tareas')
    expect(screen.queryByText('Sin tareas activas.')).toBeNull()

    openTab('Errores')
    expect(screen.getByText('Sin tareas con errores.')).toBeInTheDocument()
    expect(rowNames(list(container))).toEqual([])

    openTab('Completadas')
    expect(rowNames(list(container))).toEqual(['copia hecha'])
  })
})

describe('the actions Trazabilidad used to own', () => {
  it('offers a blocked trace its retry button on the row', () => {
    // The whole point of carrying TraceActions here: retiring the old page
    // must not take the only door to "Reintentar import" with it. A block is
    // an Error row (S2) — the tab is part of reaching it.
    renderView(
      resp([trace({ stage: 'import_blocked', title: 'Transformers (2014)' })]),
      false,
      RETRY_ACTIONS,
    )

    openTab('Errores')
    expect(screen.getByRole('button', { name: 'Reintentar import' })).toBeInTheDocument()
  })

  it('renders no action bar when the catalogue offers nothing', () => {
    const { container } = renderView(resp([trace({ stage: 'import_blocked' })]))

    openTab('Errores')
    expect(container.querySelector('.trace-actions')).toBeNull()
  })

  it('carries the sweep panel below the list — the top of the view is the list and nothing else', async () => {
    // "Revisar descargas" was reachable ONLY through the page being retired.
    // It must exist, and it must NOT sit on top of the list: the top of this
    // page is the task list and nothing else (the old section's header block
    // must not resurface here).
    const { container } = renderView(resp([trace()]))

    expect(screen.getByRole('button', { name: 'Revisar descargas' })).toBeInTheDocument()
    const sweep = container.querySelector('.auto-copy')
    expect(sweep).not.toBeNull()
    expect(container.querySelector('.sg-sweep .auto-copy')).not.toBeNull()
    expect(container.querySelector('.sg-list .auto-copy')).toBeNull()
    expect(container.querySelector('.sg > .auto-copy')).toBeNull()
    expect(container.querySelector('.sg-sum')).toBeNull()
    expect(container.querySelector('.sg-head')).toBeNull()

    // "Below the list", in DOM order (jsdom draws no boxes): the sweep comes
    // AFTER the list — the list reads first, the sweep is its footer.
    const listEl = list(container)
    expect(
      listEl.compareDocumentPosition(sweep!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('the copy rows carry the retired sidebar\'s duties', () => {
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

  it('shows active copy operations with their progress — settled ones live under their tabs', async () => {
    queueStatusMock.mockResolvedValue({
      queue: [runningOp],
      completed: [{ ...runningOp, id: 'op-0', name: 'Godzilla Minus One (2023)', status: 'done', import_status: 'imported' }],
      running: true,
    })

    const { container } = renderView(resp([trace()]))

    await screen.findByText('Movie (2024)')
    const row = container.querySelector('.sg-row-copy') as HTMLElement
    expect(within(row).getByText('Copiar')).toBeInTheDocument()
    expect(row.textContent).toContain('40%')
    expect(row.textContent).toContain('en curso')
    expect(queueStatusMock).toHaveBeenCalled()

    // The settled row is NOT in the default view — S2 hides it under its tab.
    expect(rowNames(list(container))).toEqual(['Dune (2021)', 'Movie (2024)'])
    openTab('Completadas')
    expect(rowNames(list(container))).toEqual(['Godzilla Minus One (2023)'])
    expect(list(container).textContent).toContain('hecha')
  })

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

    openTab('Completadas')
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
    // The honesty rule the rows already inherit (Seguimiento header): the
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

    // Torrent facts — progress is a real field, drawn as the row draws it
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
    // must not draw either (same rule the rows are held to).
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

    openTab('Errores')
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }))

    const panel = screen.getByRole('complementary', { name: 'Detalle de Transformers (2014)' })
    expect(field(panel, 'Etapa')).toBe('Import bloqueado')
    // The row draws only the FIRST message; the panel carries them all.
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
    // The row shows only the FIRST message; the panel carries them all.
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

    openTab('Errores')
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

  it('swaps its content in place when another row is selected', () => {
    renderView(
      resp([
        trace({ title: 'Dune (2021)', download_id: 'hash-a' }),
        trace({ title: 'The Bear', download_id: 'hash-b' }),
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
    // stale detail open over a list that no longer has its row.
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

  it('leaves the unified list untouched while open — the overlay is not a row', () => {
    // The overlay must live OUTSIDE the list: opening it changes neither the
    // list's rows nor the sweep below it — an overlay, not another row.
    const { container } = renderView(
      resp([trace({ title: 'Dune (2021)', download_id: 'hash-a' }), trace({ title: 'Otra', download_id: 'hash-b' })]),
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Ver detalles' })[0])
    expect(screen.getByRole('complementary')).toBeInTheDocument()

    const rows = container.querySelectorAll('.sg-list .sg-row')
    expect(rows).toHaveLength(2)
    expect(container.querySelector('.sg-list')!.contains(screen.getByRole('complementary'))).toBe(false)
    // The sweep coexists: still mounted, still below the list.
    expect(container.querySelector('.sg-sweep')).not.toBeNull()
    expect(container.querySelector('.sg-sweep .auto-copy')).not.toBeNull()
    // …and the overlay is rendered, just not inside the measured list.
    expect(container.querySelector('.sg-det')).not.toBeNull()
  })
})

describe('the mix rows (S11)', () => {
  it('renders the mix rows as received — running with progress, queued waiting, terminal under their tabs', async () => {
    stubMixer({
      tasks: [
        mixTask({ task_id: 'm-run', status: 'running', progress: 0.42, detail: 'mezclando vídeo', output_path: '/mnt/movies/Dune.mkv', created_at: 3 }),
        mixTask({ task_id: 'm-q', status: 'queued', progress: 0, detail: 'espera FIFO', created_at: 4 }),
        mixTask({ task_id: 'm-done', status: 'done', progress: 1, detail: 'sustituido', created_at: 2 }),
        mixTask({ task_id: 'm-err', status: 'error', progress: 0.7, detail: 'ffmpeg falló', created_at: 1 }),
      ],
    })
    const { container } = renderView(resp([trace()]))

    await screen.findByText('mezclando vídeo')
    const activeRows = [...list(container).querySelectorAll('.sg-row-mix')]

    // The backend sends queue order (running first, queued FIFO, terminal
    // last) — the list renders it as-is, no re-sorting.
    expect(activeRows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'mezclando vídeo',
      'espera FIFO',
    ])

    // The running row carries a real progress bar whose width follows the
    // 0..1 `progress` fraction.
    const fill = activeRows[0].querySelector('.mixer-progress-fill') as HTMLElement | null
    expect(fill).not.toBeNull()
    expect(fill!.style.width).toBe('42%')

    // The queued row shows its waiting state and no progress bar.
    expect(activeRows[1].textContent).toContain('En cola')
    expect(activeRows[1].querySelector('.mixer-progress-fill')).toBeNull()

    // Terminal rows live under their own tabs, never in the default view.
    openTab('Completadas')
    expect(rowNames(list(container))).toEqual(['sustituido'])
    expect(list(container).textContent).toContain('Completada')

    openTab('Errores')
    expect(rowNames(list(container))).toEqual(['ffmpeg falló'])
    expect(list(container).textContent).toContain('Error')
  })

  it('cancelling a queued row calls the cancel endpoint and the row disappears after refetch', async () => {
    const state = {
      tasks: [mixTask({ task_id: 'm-q', status: 'queued', progress: 0, detail: 'espera FIFO', created_at: 2 })],
    }
    const calls = stubMixer(state, (url) => {
      if (url === '/api/mixer/tasks/m-q/cancel') state.tasks = []
    })
    renderView(resp([trace()]))

    const cancel = await screen.findByRole('button', { name: '✕ Cancelar tarea' })
    fireEvent.click(cancel)

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/api/mixer/tasks/m-q/cancel' && c.method === 'POST'),
      ).toBe(true),
    )
    // A cancelled queued mix is retired without running: the refetch shows it.
    await waitFor(() => expect(screen.queryByText('espera FIFO')).toBeNull())
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

    fireEvent.click(await screen.findByRole('button', { name: '⏸ Pausar' }))
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/api/mixer/tasks/m-run/pause' && c.method === 'POST'),
      ).toBe(true),
    )

    fireEvent.click(screen.getByRole('button', { name: '▶ Reanudar' }))
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
        { ...stuckOp, id: 'd1', name: 'Ya hecha (1982)', status: 'done' },
        { ...stuckOp, id: 'f1', name: 'Ya fallida (1982)', status: 'failed' },
      ],
      running: false,
    })

    renderView(resp([trace()]))

    openTab('Completadas')
    await screen.findByText('hecha')
    expect(screen.queryByRole('button', { name: 'Marcar como completada' })).toBeNull()

    openTab('Errores')
    await screen.findByText('fallida')
    expect(screen.queryByRole('button', { name: 'Marcar como completada' })).toBeNull()
  })
})

/* ── T3/S1 — the just-submitted mix lands hoisted and accented ─────────── */

describe('the highlighted mix after «Mezclar» (T3/S1)', () => {
  /** How App lands the user here: the target rides the hash. */
  function landWithHighlight(taskId: string) {
    window.location.hash = `#/seguimiento?highlight=${taskId}`
  }

  /** Two mixes + a copy op + a trace, all «Activas» — the target is LAST in
   *  the source-stable order, so the hoist has to move it across sources. */
  function stubActiveSources() {
    queueStatusMock.mockResolvedValue({
      queue: [opRow({ id: 'op-1', name: 'copia en curso' })],
      completed: [],
      running: true,
    })
    stubMixer({
      tasks: [
        mixTask({ task_id: 'm-old', status: 'running', detail: 'mezcla previa', created_at: 1 }),
        mixTask({ task_id: 'm-new', status: 'queued', detail: 'mezcla nueva', created_at: 2 }),
      ],
    })
  }

  it('hoists the just-submitted mix to the top of «Activas» and draws the accent border on it', async () => {
    stubActiveSources()
    landWithHighlight('m-new')
    const { container } = renderView(resp([trace({ title: 'Descarga activa', download_id: 'h-1' })]))

    await screen.findByText('mezcla nueva')

    // Landing always shows «Activas» (the default tab) …
    expect(screen.getByRole('tab', { name: /Activas/ })).toHaveAttribute('aria-selected', 'true')

    // … with the target hoisted ABOVE every other source, and only the
    // target carrying the accent border (S1: «borde de acento arriba del
    // todo»). The rest of the order is untouched source-stable order.
    expect(rowNames(list(container))).toEqual([
      'mezcla nueva',
      'Descarga activa',
      'copia en curso',
      'mezcla previa',
    ])
    const target = screen.getByRole('article', { name: 'mezcla nueva' })
    expect(target).toHaveClass('sg-row-highlight')
    expect(target.style.borderLeft).toBe('3px solid var(--accent)')
    for (const name of ['Descarga activa', 'copia en curso', 'mezcla previa']) {
      const other = screen.getByRole('article', { name })
      expect(other).not.toHaveClass('sg-row-highlight')
      expect(other.style.borderLeft).toBe('')
    }
  })

  it('consumes the highlight on the first tab change — returning to «Activas» must not resurrect the hoist', async () => {
    stubActiveSources()
    landWithHighlight('m-new')
    const { container } = renderView(resp([trace({ title: 'Descarga activa', download_id: 'h-1' })]))

    await screen.findByText('mezcla nueva')
    expect(rowNames(list(container))[0]).toBe('mezcla nueva')

    openTab('Completadas')
    openTab(/Activas/)

    // The highlight is one-shot per visit: the row is back in its natural
    // slot, plain, and the consumed param is gone from the URL.
    expect(rowNames(list(container))).toEqual([
      'Descarga activa',
      'copia en curso',
      'mezcla previa',
      'mezcla nueva',
    ])
    expect(container.querySelector('.sg-row-highlight')).toBeNull()
    expect(window.location.hash).not.toContain('highlight')
  })

  it('never resurrects the hoist even if the hash param comes back', async () => {
    stubActiveSources()
    landWithHighlight('m-new')
    const { container } = renderView(resp([trace({ title: 'Descarga activa', download_id: 'h-1' })]))

    await screen.findByText('mezcla nueva')
    openTab('Completadas') // consumes the highlight

    // A back/forward restore puts the parameter back in the URL — the
    // consumed latch must swallow it for the rest of this visit.
    window.location.hash = '#/seguimiento?highlight=m-new'
    fireEvent(window, new Event('hashchange'))
    openTab(/Activas/)

    expect(rowNames(list(container))).toEqual([
      'Descarga activa',
      'copia en curso',
      'mezcla previa',
      'mezcla nueva',
    ])
    expect(container.querySelector('.sg-row-highlight')).toBeNull()
  })

  it('shows no highlight when the just-submitted mix is not in «Activas»', async () => {
    // No special casing: a mix that settled into «Errores» before the user
    // landed keeps living under its own tab like every error row. The
    // pending highlight is consumed by the first tab change like any other.
    queueStatusMock.mockResolvedValue({ queue: [], completed: [], running: false })
    stubMixer({
      tasks: [mixTask({ task_id: 'm-new', status: 'error', detail: 'mezcla fallida' })],
    })
    landWithHighlight('m-new')
    const { container } = renderView(resp([trace({ title: 'Descarga activa', download_id: 'h-1' })]))

    await screen.findByText('Descarga activa')
    expect(rowNames(list(container))).toEqual(['Descarga activa'])
    expect(container.querySelector('.sg-row-highlight')).toBeNull()

    openTab('Errores')
    expect(rowNames(list(container))).toEqual(['mezcla fallida'])
    expect(container.querySelector('.sg-row-highlight')).toBeNull()
  })
})

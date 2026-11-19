import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionKey, ActionMeta, Trace } from '../../../shared/types.ts'
import { TraceActions } from '../../../features/trace-actions/TraceActions.tsx'

/**
 * C-02 from the blocked card: one click to retry (already wired) and one
 * click to clear ("Descartar bloqueo") so the incident stops occupying the
 * Bloqueado column.
 *
 * The clear rides `POST /api/trace/blocked/ack` — the TRACE seam, not
 * `/api/actions`: the action catalogue lives in the server config and the
 * clear is view state about a trace, not an arr command. Both calls are
 * driven here with a mocked fetch, because "the button exists" was never
 * the contract — "the button ACTS" is.
 */

const RETRY_META: ActionMeta = {
  key: 'retry_import',
  label: 'Reintentar import',
  description: 'Vuelve a lanzar el import en el arr',
  destructive: false,
  scope: 'import',
}

const COPY_META: ActionMeta = {
  key: 'copy_files',
  label: 'Copiar archivos',
  description: 'Copia los archivos al destino',
  destructive: false,
  scope: 'arr',
}

const meta = { retry_import: RETRY_META, copy_files: COPY_META } as Record<ActionKey, ActionMeta>

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    source: 'radarr',
    title: 'Transformers (2007)',
    date: null,
    indexer: null,
    download_client: null,
    download_client_host: null,
    download_id: 'abc123',
    matched_hash: 'abc123',
    stage: 'import_blocked',
    torrent: null,
    expected_category: null,
    category_ok: null,
    paused: false,
    ids: { queue_id: 7, episode_id: null, movie_id: 603, series_id: null },
    destination: null,
    queue: null,
    ...overrides,
  }
}

function deferredJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

/** Dispatch by URL so retry and clear answer independently. */
function stubFetch(handlers: {
  ack?: () => Promise<Response> | Response
  retry?: () => Promise<Response> | Response
}) {
  const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/trace/blocked/ack')) {
      return (handlers.ack ?? (() => deferredJson({ ok: true, key: 'k' })))()
    }
    if (url.includes('/api/actions/retry_import')) {
      return (handlers.retry ?? (() => deferredJson({ ok: true, steps: [] })))()
    }
    return Promise.resolve(deferredJson({}))
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderActions(t: Trace, onDone = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TraceActions trace={t} meta={meta} safeMode={false} onDone={onDone} />
    </QueryClientProvider>,
  )
  return { onDone }
}

function bodyOf(call: [RequestInfo | URL, RequestInit?]): Record<string, unknown> {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>
}

afterEach(() => {
  clearToasts()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Descartar bloqueo — the one-click clear', () => {
  it('is offered on an import_blocked trace', () => {
    stubFetch({})
    renderActions(trace())

    expect(
      screen.getByRole('button', { name: 'Descartar bloqueo' }),
    ).toBeInTheDocument()
  })

  it('is not offered for stages that are not blocked', () => {
    stubFetch({})
    // `downloaded` renders the bar (retry is in the catalogue for it), so
    // this asserts the stage gate itself — not the empty-bar guard.
    renderActions(trace({ stage: 'downloaded' }))

    expect(
      screen.queryByRole('button', { name: 'Descartar bloqueo' }),
    ).not.toBeInTheDocument()
  })

  it('POSTs the trace identity to the trace seam and refreshes the board', async () => {
    const fetchMock = stubFetch({})
    const { onDone } = renderActions(trace())

    fireEvent.click(screen.getByRole('button', { name: 'Descartar bloqueo' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/trace/blocked/ack'),
    )
    expect(call, 'the clear must reach POST /api/trace/blocked/ack').toBeTruthy()
    expect(call![1]?.method).toBe('POST')
    const body = bodyOf(call!)
    expect(body).toMatchObject({
      source: 'radarr',
      download_id: 'abc123',
      ids: { queue_id: 7, movie_id: 603 },
    })
  })

  it('shows the refusal instead of pretending the board was cleared', async () => {
    stubFetch({
      ack: () => deferredJson({ ok: false, error: 'el historial no está disponible' }),
    })
    const { onDone } = renderActions(trace())

    fireEvent.click(screen.getByRole('button', { name: 'Descartar bloqueo' }))

    expect(
      await screen.findByText('el historial no está disponible'),
    ).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('Reintentar import — the one-click retry, driven end to end', () => {
  it('POSTs the retry action with the trace identity and refreshes', async () => {
    const fetchMock = stubFetch({})
    const { onDone } = renderActions(trace())

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar import' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/actions/retry_import'),
    )
    expect(call, 'retry must reach POST /api/actions/retry_import').toBeTruthy()
    expect(call![1]?.method).toBe('POST')
    expect(bodyOf(call!)).toMatchObject({
      source: 'radarr',
      download_id: 'abc123',
      ids: { queue_id: 7 },
    })
  })
})

describe('feedback on the row', () => {
  it('shows a spinner on the button while the action runs', async () => {
    let release: (r: Response) => void = () => {}
    stubFetch({ ack: () => new Promise<Response>((res) => { release = res }) })
    renderActions(trace())

    fireEvent.click(screen.getByRole('button', { name: 'Descartar bloqueo' }))

    const btn = screen.getByRole('button', { name: 'Descartar bloqueo' })
    expect(btn.querySelector('.action-spinner')).not.toBeNull()
    expect(btn).toBeDisabled()
    release(deferredJson({ ok: true, key: 'k' }))
    await waitFor(() => expect(btn.querySelector('.action-spinner')).toBeNull())
  })

  it('keeps a failure on screen until it is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stubFetch({ ack: () => deferredJson({ ok: false, error: 'sin historial' }) })
      renderActions(trace())

      fireEvent.click(screen.getByRole('button', { name: 'Descartar bloqueo' }))
      await screen.findByText(/sin historial/)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(screen.getByText(/sin historial/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso' }))
      expect(screen.queryByText(/sin historial/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('Marcar como completada — a finished download the client still lists', () => {
  it('is offered on a downloaded trace and not on a blocked one', () => {
    stubFetch({})
    renderActions(trace({ stage: 'downloaded' }))
    expect(screen.getByRole('button', { name: 'Marcar como completada' })).toBeInTheDocument()
  })

  it('is not offered on a blocked trace', () => {
    stubFetch({})
    renderActions(trace())
    expect(screen.queryByRole('button', { name: 'Marcar como completada' })).not.toBeInTheDocument()
  })

  it('POSTs the identity with settled: true and refreshes the board', async () => {
    const fetchMock = stubFetch({})
    const { onDone } = renderActions(trace({ stage: 'downloaded' }))

    fireEvent.click(screen.getByRole('button', { name: 'Marcar como completada' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/trace/blocked/ack'))
    expect(bodyOf(call!)).toMatchObject({ download_id: 'abc123', settled: true })
  })
})

describe('Copiar archivos on a downloaded trace verifies the destination first', () => {
  const downloaded = () =>
    trace({
      stage: 'downloaded',
      destination: '/movies/Transformers (2007)',
      torrent: {
        state: 'pausedUP', progress: 100, category: 'x', save_path: '/dl', current_path: '/dl',
        content_path: '/dl/Transformers.2007.mkv', size: 1000,
      },
    })

  function stubBrowse(items: unknown[]) {
    const fn = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/files/browse')) {
        return Promise.resolve(deferredJson({ ok: true, items }))
      }
      return Promise.resolve(deferredJson({ ok: true, key: 'k' }))
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('lists the destination folder and flags the matching file', async () => {
    stubBrowse([{ name: 'Transformers.2007.mkv', is_dir: false, size: 1000 }])
    renderActions(downloaded())

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))

    expect(await screen.findByText(/coincide con la descarga/)).toBeInTheDocument()
  })

  it('"Ya está en destino" settles the row instead of copying', async () => {
    const fetchMock = stubBrowse([])
    const { onDone } = renderActions(downloaded())

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Ya está en destino' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/trace/blocked/ack'))
    expect(bodyOf(call!)).toMatchObject({ settled: true })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/actions/copy_files'))).toBe(false)
  })

  it('"No ha llegado" falls through to the normal copy confirmation', async () => {
    stubBrowse([])
    renderActions(downloaded())

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))
    fireEvent.click(await screen.findByRole('button', { name: 'No ha llegado: copiar' }))

    expect(await screen.findByRole('button', { name: 'Confirmar' })).toBeInTheDocument()
  })
})

describe('Copiar archivos on an import_blocked trace verifies the destination too', () => {
  it('lists the folder of a title that is already in the library (an upgrade)', async () => {
    const fn = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        deferredJson(
          String(input).includes('/api/files/browse')
            ? { ok: true, items: [{ name: 'Jurassic Park II (SD).avi', is_dir: false, size: 1000 }] }
            : { ok: true, key: 'k' },
        ),
      ),
    )
    vi.stubGlobal('fetch', fn)
    renderActions(
      trace({
        stage: 'import_blocked',
        destination: '/movies/Jurassic Park II (1997)',
        queue: { state: 'importBlocked', status: 'warning', output_path: '/dl/Jurassic.Park.II.1080p.mkv', messages: [] },
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))

    expect(await screen.findByText('Verificar destino')).toBeInTheDocument()
    expect(fn.mock.calls.some(([url]) => String(url).includes('/api/files/browse'))).toBe(true)
  })
})

describe('Copiar archivos reports a refusal on the row', () => {
  it('shows the server reason after "No ha llegado: copiar" is confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/files/browse')) return Promise.resolve(deferredJson({ ok: true, items: [] }))
      if (url.includes('/api/actions/copy_files')) {
        return Promise.resolve(deferredJson({
          ok: false, steps: [{ target: 'radarr', ok: false, detail: 'sin output_path' }],
        }))
      }
      return Promise.resolve(deferredJson({}))
    }))
    renderActions(trace({
      stage: 'downloaded',
      destination: '/movies/Transformers (2007)',
      torrent: {
        state: 'pausedUP', progress: 100, category: 'x', save_path: '/dl', current_path: '/dl',
        content_path: '/dl/Transformers.2007.mkv', size: 1000,
      },
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))
    fireEvent.click(await screen.findByRole('button', { name: 'No ha llegado: copiar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }))

    expect(await screen.findByText(/radarr: sin output_path/)).toBeInTheDocument()
    expect(getToasts().some((t) => t.tone === 'error' && /sin output_path/.test(t.message))).toBe(true)
  })
})

describe('Copiar archivos keeps its source path through the confirmation', () => {
  it('offers no delete checkbox and always sends the source path', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/actions/copy_files')) {
        return Promise.resolve(deferredJson({ ok: false, steps: [{ target: 'radarr', ok: false, detail: 'x' }] }))
      }
      return Promise.resolve(deferredJson({}))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderActions(trace({
      queue: { state: 'importPending', status: 'warning', output_path: '/dl/x.mkv', messages: [] },
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))
    await screen.findByRole('button', { name: 'Confirmar' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('copy_files'))).toBe(true))
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('copy_files'))!
    expect(bodyOf(call as [RequestInfo | URL, RequestInit?])).toMatchObject({ output_path: '/dl/x.mkv' })
  })
})

describe('Copiar archivos shows its progress in the row, not in a modal', () => {
  const blocked = () => trace({ queue: { state: 'importPending', status: 'warning', output_path: '/dl/x.mkv', messages: [] } })

  it('closes the confirmation at once and reports the copy phase to the row', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/actions/copy_files')) {
        return Promise.resolve(deferredJson({ ok: true, task_id: 't1', src_path: '/dl/x.mkv', dst_path: '/movies/x.mkv' }))
      }
      if (url.includes('/api/tasks/t1')) {
        return Promise.resolve(deferredJson({
          ok: true, task_id: 't1', status: 'running', copied_bytes: 50, total_bytes: 100,
          files_done: 0, files_total: 1, detail: 'copiando', src_path: '/dl/x.mkv', dst_path: '/movies/x.mkv',
        }))
      }
      return Promise.resolve(deferredJson({}))
    }))
    const onCopyTask = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <TraceActions trace={blocked()} meta={meta} safeMode={false} onDone={vi.fn()} onCopyTask={onCopyTask} />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }))

    // The row draws the bar in its centre: this cell only keeps the cancel button.
    expect(await screen.findByRole('button', { name: 'Cancelar copia' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Estado de la copia' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(onCopyTask).toHaveBeenCalledWith(expect.objectContaining({ task_id: 't1', status: 'running' })),
    )
  })
})

describe('Copiar archivos warns when the file does not fit the destination', () => {
  const blocked = () => trace({ queue: { state: 'importPending', status: 'warning', output_path: '/dl/x.mkv', messages: [] } })

  it('asks first and, once accepted, resends the copy to the suggested folder', async () => {
    const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const body = String(_init?.body ?? '')
      if (String(input).includes('/api/actions/copy_files')) {
        return Promise.resolve(
          body.includes('dest_root')
            ? deferredJson({ ok: true, task_id: 't2', src_path: '/dl/x.mkv', dst_path: '/4k/x.mkv' })
            : deferredJson({
                ok: false,
                needs_confirmation: true,
                mismatch: { file: 'x.mkv', resolution: '2160', destination: '/lib/Movie', suggested: '/4k' },
              }),
        )
      }
      return Promise.resolve(deferredJson({ ok: true, status: 'running' }))
    })
    vi.stubGlobal('fetch', fn)
    renderActions(blocked())

    fireEvent.click(screen.getByRole('button', { name: 'Copiar archivos' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }))
    expect(await screen.findByText('Esta carpeta no es la que toca')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copiar a la carpeta correcta' }))

    await waitFor(() => {
      const sent = fn.mock.calls.filter((c) => String(c[0]).includes('/api/actions/copy_files')).map((c) => bodyOf(c as [RequestInfo | URL, RequestInit?]))
      expect(sent).toHaveLength(2)
      expect(sent[1]).toMatchObject({ dest_root: '/4k', output_path: '/dl/x.mkv' })
    })
  })
})

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

const meta = { retry_import: RETRY_META } as Record<ActionKey, ActionMeta>

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

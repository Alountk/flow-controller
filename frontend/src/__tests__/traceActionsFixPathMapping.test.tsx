import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionKey, ActionMeta, Trace } from '../types'
import { TraceActions } from '../components/TraceActions'

/**
 * "Mapear ruta" must not send a hardcoded local_path.
 *
 * It used to pre-fill local_path with /downloads/incoming — the download
 * client's own container namespace — so for an aMule download the arr got the
 * self-mapping /downloads/incoming → /downloads/incoming. That maps nothing,
 * and it stayed in the arr. The backend resolves the local path now; the
 * frontend only sends the host and the editable remote path.
 */

const META: ActionMeta = {
  key: 'fix_path_mapping',
  label: 'Mapear ruta',
  description: 'Crea un remote path mapping',
  destructive: false,
  scope: 'arr',
}

const meta = { fix_path_mapping: META } as Record<ActionKey, ActionMeta>

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    source: 'radarr',
    title: 'Wonder Woman',
    date: null,
    indexer: null,
    download_client: 'amule',
    download_client_host: 'amule-host',
    download_id: 'abc123',
    matched_hash: null,
    stage: 'import_blocked',
    torrent: null,
    expected_category: null,
    category_ok: null,
    paused: false,
    ids: { queue_id: 1, episode_id: null, movie_id: 1, series_id: null },
    destination: null,
    queue: {
      state: 'downloading',
      status: 'warning',
      output_path: '/downloads/incoming/Wonder.Woman.(2017).mkv',
      messages: [],
    },
    ...overrides,
  }
}

function renderActions(t: Trace) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TraceActions trace={t} meta={meta} safeMode={false} onDone={() => {}} />
    </QueryClientProvider>,
  )
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

describe('fix_path_mapping request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not send a hardcoded local_path', async () => {
    const fetchMock = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
      ok({ ok: true, steps: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderActions(trace())

    fireEvent.click(screen.getByRole('button', { name: 'Mapear ruta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/actions/fix_path_mapping'),
    )
    expect(call).toBeTruthy()
    const body = JSON.parse(String((call![1] as RequestInit).body))
    // The backend owns the translation; the frontend must not invent a path.
    expect(body.local_path).toBeUndefined()
    expect(body.remote_path).toBe('/downloads/incoming')
    expect(body.host).toBe('amule-host')
  })

  it('still lets the user type a local_path', async () => {
    const fetchMock = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
      ok({ ok: true, steps: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderActions(trace())

    fireEvent.click(screen.getByRole('button', { name: 'Mapear ruta' }))
    const localInput = screen.getByDisplayValue('')
    // The local field is empty (not pre-filled) and remains editable.
    fireEvent.change(localInput, { target: { value: '/mnt/custom/amule' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/actions/fix_path_mapping'),
    )
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.local_path).toBe('/mnt/custom/amule')
  })
})

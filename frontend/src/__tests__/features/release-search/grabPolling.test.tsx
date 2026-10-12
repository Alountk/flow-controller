import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Release } from '../../../shared/api/releases.ts'
import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'

/**
 * async-grab — the grab polls a job instead of holding the POST open.
 *
 * The synchronous POST awaited the whole chain inline: the ED2K resolve
 * alone measures 30-60 s against a proxy that cuts at ~60 s, so the request
 * died as a 504 while the download was already on its way. These tests pin
 * the flow that replaces it — the POST answers with a task id in
 * milliseconds, the modal polls `GET /api/calendar/grab/{task_id}` with the
 * C-10 pattern (a react-query query keyed by the task id, a `refetchInterval`
 * that stops at a terminal status), and the outcome reaches the EXACT
 * success/error branches the synchronous answer always used. A synchronous
 * refusal (no task id) keeps today's handling without ever polling.
 */

function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    guid: 'en-1',
    title: 'Everything Everywhere All at Once 2022 1080p BluRay',
    size: 10_000_000_000,
    quality: 'Bluray-1080p',
    indexer: 'aMuTorrent',
    indexerId: 1,
    indexerFlags: '',
    seeders: 10,
    leechers: 1,
    protocol: 'torrent',
    releaseGroup: '',
    languages: ['English'],
    ...overrides,
  }
}

const releases: Release[] = [makeRelease()]

const indexers = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

const STARTED_GRAB = { ok: true, task_id: 'grab-1', status: 'running', detail: 'Descarga lanzada' }

interface PollOptions {
  /** What the grab POST answers: a started job by default, a refusal if given. */
  grabPostBody?: Record<string, unknown>
  /** What the grab status GET answers, in order; the last entry repeats. */
  grabStatusBodies?: Record<string, unknown>[]
}

/**
 * A fetch mock shaped like the async-grab backend: the release search
 * answers synchronously (it has its own suite), while the grab POST starts a
 * job and its status GET reports `running` until the last body settles it.
 */
function mockPollingFetch(options: PollOptions = {}) {
  const grabBodies = options.grabStatusBodies ?? [
    { ok: true, id: 'grab-1', status: 'running', detail: 'Descarga lanzada' },
    { ok: true, id: 'grab-1', status: 'done', detail: 'Release encolado para descarga' },
  ]
  const state = { grabCalls: 0 }
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body } as Response)
    if (url.includes('/api/calendar/indexers')) return ok(indexers)
    if (url.includes('/api/settings')) {
      return ok({ paths: { path_4k: '/mnt/storage-6tb/4k', path_3d: '/mnt/storage/6tb/3d' } })
    }
    if (url.includes('/api/calendar/releases')) {
      return ok({ releases, detail: '1 releases encontrados' })
    }
    if (url.includes('/api/calendar/grab')) {
      if (init?.method === 'POST') return ok(options.grabPostBody ?? STARTED_GRAB)
      const body = grabBodies[Math.min(state.grabCalls, grabBodies.length - 1)]
      state.grabCalls += 1
      return ok(body)
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 411, title: 'Everything Everywhere All at Once', source: 'radarr' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

type FetchMock = ReturnType<typeof mockPollingFetch>

const grabCalls = (fn: FetchMock) =>
  fn.mock.calls.filter(([input]) => String(input).includes('/api/calendar/grab'))
const grabPostCalls = (fn: FetchMock) =>
  grabCalls(fn).filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
const grabStatusCalls = (fn: FetchMock) =>
  grabCalls(fn).filter(([input]) => String(input).includes('/api/calendar/grab/'))

describe('grab polling (async-grab)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('keeps the in-flight state, polls the job, and toasts the settled detail', async () => {
    const fn = mockPollingFetch()
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    fireEvent.click(document.querySelector('.release-dest-btn') as HTMLElement)

    // The in-flight message is set the moment the press lands — before the
    // POST even answers — and stays while the job runs.
    expect(await screen.findByText(/Enviando la descarga al servidor/)).toBeInTheDocument()

    // The settled detail — not the start body — is what reaches the ack.
    await waitFor(
      () => expect(getToasts().map((t) => t.message)).toContain('Release encolado para descarga'),
      { timeout: 4000 },
    )
    expect(getToasts()[0].tone).toBe('ok')

    // One POST, and the status endpoint asked more than once: the flow
    // polled instead of holding a single request open.
    expect(grabPostCalls(fn)).toHaveLength(1)
    expect(grabStatusCalls(fn).length).toBeGreaterThanOrEqual(2)
  })

  it('shows a synchronous refusal from the POST without ever polling', async () => {
    const fn = mockPollingFetch({
      grabPostBody: { ok: false, detail: 'Destino no permitido: /etc/nope' },
    })
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    fireEvent.click(document.querySelector('.release-dest-btn') as HTMLElement)

    expect(await screen.findByText('Destino no permitido: /etc/nope')).toBeInTheDocument()
    expect(document.querySelector('.calendar-modal-status')).toHaveClass('status-error')
    expect(grabStatusCalls(fn)).toHaveLength(0)
    expect(getToasts().map((t) => t.message)).toContain('Destino no permitido: /etc/nope')
    expect(getToasts()[0].tone).toBe('error')
  })

  it('surfaces a failed job through the same error step a failed POST uses', async () => {
    mockPollingFetch({
      grabStatusBodies: [
        { ok: true, id: 'grab-1', status: 'running', detail: 'Descarga lanzada' },
        {
          ok: false,
          id: 'grab-1',
          status: 'error',
          detail: 'Error interno: arr exploded',
          direct: false,
        },
      ],
    })
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    fireEvent.click(document.querySelector('.release-dest-btn') as HTMLElement)

    expect(
      await screen.findByText('Error interno: arr exploded', {}, { timeout: 4000 }),
    ).toBeInTheDocument()
    expect(document.querySelector('.calendar-modal-status')).toHaveClass('status-error')
    expect(getToasts().map((t) => t.message)).toContain('Error interno: arr exploded')
    expect(getToasts()[0].tone).toBe('error')
  })

  it('settles a worker refusal (done with ok:false) on the error branch', async () => {
    // The task RAN fine; its payload says the grab did not — the same body
    // the synchronous handler used to return for a foreign-link miss.
    mockPollingFetch({
      grabStatusBodies: [
        { ok: false, id: 'grab-1', status: 'done', detail: 'No encontré «X» en el indexador de aMule' },
      ],
    })
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')
    fireEvent.click(document.querySelector('.release-dest-btn') as HTMLElement)

    expect(
      await screen.findByText('No encontré «X» en el indexador de aMule', {}, { timeout: 4000 }),
    ).toBeInTheDocument()
    expect(document.querySelector('.calendar-modal-status')).toHaveClass('status-error')
    expect(getToasts()[0].tone).toBe('error')
  })
})

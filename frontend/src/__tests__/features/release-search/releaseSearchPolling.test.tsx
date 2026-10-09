import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * C-10 — the release search polls a job instead of holding the POST open.
 *
 * The synchronous POST measured 91.6 s (Radarr × 20 indexers) against a proxy
 * that cuts at ~60 s: the request died as a 504 before any release could come
 * back (masked once by raising `proxy_read_timeout` by hand in nginx). These
 * tests pin the flow that replaces it — the POST answers with a task id in
 * milliseconds, the modal polls `GET /api/calendar/releases/{task_id}` with
 * the TraceActions pattern (a react-query query keyed by the task id, a
 * `refetchInterval` that stops at a terminal status), and the results render
 * only when the job is done. A failed job surfaces through the same error
 * step a failed POST always used.
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

const releases: Release[] = [
  makeRelease({ guid: 'en-1' }),
  makeRelease({
    guid: 'es-1',
    title: 'Todo a la vez en todas partes 2022 1080p',
    quality: 'WEBDL-1080p',
    languages: ['Spanish'],
  }),
]

const indexers = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

const STARTED_JOB = { ok: true, task_id: 'rel-job-1', status: 'running', detail: 'Búsqueda de releases lanzada' }

interface PollOptions {
  /** What the POST answers: a started job by default, a refusal if given. */
  postBody?: Record<string, unknown>
  /** What the status GET answers, in order; the last entry repeats. */
  statusBodies?: Record<string, unknown>[]
}

/**
 * A fetch mock shaped like the C-10 backend: POST starts the job, GET
 * `/api/calendar/releases/{task_id}` reports its status and serves the
 * payload once `done`.
 */
function mockPollingFetch(options: PollOptions = {}) {
  const statusBodies = options.statusBodies ?? [
    { ok: true, id: 'rel-job-1', status: 'running', detail: 'Búsqueda de releases lanzada' },
    { ok: true, id: 'rel-job-1', status: 'done', detail: '2 releases encontrados', releases },
  ]
  const state = { statusCalls: 0 }
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => indexers } as Response)
    }
    if (url.includes('/api/settings')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ paths: { path_4k: '/mnt/storage-6tb/4k', path_3d: '/mnt/storage/6tb/3d' } }),
      } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => options.postBody ?? STARTED_JOB,
        } as Response)
      }
      const body = statusBodies[Math.min(state.statusCalls, statusBodies.length - 1)]
      state.statusCalls += 1
      return Promise.resolve({ ok: true, json: async () => body } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
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

const releasesCalls = (fn: FetchMock) =>
  fn.mock.calls.filter(([input]) => String(input).includes('/api/calendar/releases'))
const postCalls = (fn: FetchMock) =>
  releasesCalls(fn).filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
const statusCalls = (fn: FetchMock) =>
  releasesCalls(fn).filter(([input]) => String(input).includes('/api/calendar/releases/'))

describe('Release search polling (C-10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('polls the release job and renders the results when the task completes', async () => {
    const fn = mockPollingFetch()
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

    // The POST is answered instantly — the modal is still searching while the
    // job runs, exactly as the loading step always looked.
    expect(await screen.findByText(/Buscando releases/)).toBeInTheDocument()

    await waitFor(
      () => expect(screen.getByText('2 releases encontrados')).toBeInTheDocument(),
      { timeout: 4000 },
    )
    expect(document.querySelectorAll('.release-title')).toHaveLength(2)

    // One POST, and the status endpoint was asked more than once: the flow
    // polled instead of holding a single request open.
    expect(postCalls(fn)).toHaveLength(1)
    expect(statusCalls(fn).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps polling while the job is still running', async () => {
    mockPollingFetch()
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

    // First status answer is `running`: no results yet, the search is in
    // flight, and only later polls may complete it.
    expect(await screen.findByText(/Buscando releases/)).toBeInTheDocument()
    expect(screen.queryByText('2 releases encontrados')).not.toBeInTheDocument()

    await waitFor(
      () => expect(screen.getByText('2 releases encontrados')).toBeInTheDocument(),
      { timeout: 4000 },
    )
  })

  it('surfaces a failed job through the same error step a failed POST uses', async () => {
    mockPollingFetch({
      statusBodies: [
        { ok: true, id: 'rel-job-1', status: 'running', detail: 'Búsqueda de releases lanzada' },
        { ok: true, id: 'rel-job-1', status: 'error', detail: 'Error interno: arr exploded', releases: [] },
      ],
    })
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

    expect(
      await screen.findByText('Error interno: arr exploded', {}, { timeout: 4000 }),
    ).toBeInTheDocument()
    expect(document.querySelector('.calendar-modal-status')).toHaveClass('status-error')
    expect(screen.queryByText('2 releases encontrados')).not.toBeInTheDocument()
  })

  it('shows a synchronous refusal from the POST without ever polling', async () => {
    const fn = mockPollingFetch({
      postBody: { releases: [], detail: 'Servicio desconocido: pluto' },
    })
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

    expect(await screen.findByText('Servicio desconocido: pluto')).toBeInTheDocument()
    expect(statusCalls(fn)).toHaveLength(0)
  })

  it('applies the chosen indexer to the results the poll delivers', async () => {
    // The choice is captured when the search STARTS (the select is disabled
    // while the job runs) and must filter the payload the poll brings back —
    // not whatever the select says by then.
    mockPollingFetch({
      statusBodies: [
        { ok: true, id: 'rel-job-1', status: 'running', detail: 'Búsqueda de releases lanzada' },
        {
          ok: true,
          id: 'rel-job-1',
          status: 'done',
          detail: '2 releases encontrados',
          releases: [
            makeRelease({ guid: 'mu-1', indexer: 'aMuTorrent' }),
            makeRelease({ guid: 'other-1', indexer: 'OtherIndexer', title: 'Solo en OtherIndexer 2022 1080p' }),
          ],
        },
      ],
    })
    renderModal()

    // The options come from the async indexers query: changing the select
    // before they render would write a value no option has.
    await screen.findByRole('option', { name: 'aMuTorrent' })
    fireEvent.change(document.getElementById('release-indexer') as HTMLSelectElement, {
      target: { value: '1' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

    await waitFor(
      () => expect(screen.getByText('1 releases encontrados')).toBeInTheDocument(),
      { timeout: 4000 },
    )
    // Scope to the rows: the modal header repeats the item title, so a
    // document-wide query would match it too.
    const titles = [...document.querySelectorAll('.release-title')].map((el) => el.textContent ?? '')
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain('Everything Everywhere')
    expect(titles.join(' ')).not.toContain('Solo en OtherIndexer')
  })
})

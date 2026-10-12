import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EventStreamContext, useEventStream } from '../../shared/hooks/useEventStream.ts'
import { ReleaseSearchModal } from '../../features/release-search/ReleaseSearchModal.tsx'
import { TraceActions } from '../../features/trace-actions/TraceActions.tsx'
import { MediaMixer } from '../../pages/MediaMixer.tsx'
import App from '../../app/App.tsx'
import type { ActionKey, ActionMeta, Trace } from '../../shared/types.ts'
import type { Release } from '../../shared/api/releases.ts'
import { clearToasts } from '../../shared/utils/toast.ts'

/**
 * B1 — the four TASK polls sleep while the SSE stream is connected.
 *
 * The worker publishes `event: task` when a job closes, so a live stream
 * covers exactly what these refetchIntervals were polling for: release
 * search (1500), grab (1500), copy task (1500) and mixer tasks (2000/10000).
 * Three contracts are pinned here:
 *
 * - connected → each gated query's `refetchInterval` option IS `false`,
 *   extracted from the query the component's own observer mounted;
 * - disconnected OR no provider at all (the context default) → today's
 *   interval, evaluated against the same payloads the old code saw — the
 *   functions themselves never change shape, only the wrapper around them;
 * - the stream lifecycle drives the gate: `open` turns polling off, `error`
 *   resuscitates it (an OBSERVED refetch, not just an option flip), `open`
 *   turns it off again. EventSource retries after an error, so an `open`
 *   that follows an `error` counts as connected.
 *
 * The existing polling suites (releaseSearchPolling, grabPolling) keep
 * asserting the observed no-provider behavior unchanged; this file adds the
 * option-level contract plus the error/open resuscitation they cannot see.
 */

/** The interval as the observer stores it: today's function, or `false`. */
type IntervalFn = (query: { state: { data: unknown } }) => number | false

/** The exact options the component's observer mounted on the real query. */
function intervalFor(client: QueryClient, queryKey: unknown[]) {
  const query = client
    .getQueryCache()
    .getAll()
    .find(
      (q) =>
        q.queryKey.length === queryKey.length &&
        q.queryKey.every((k, i) => k === queryKey[i]),
    )
  if (!query) throw new Error(`query ${JSON.stringify(queryKey)} is not in the cache`)
  // The observer writes its full options (refetchInterval included) onto the
  // query at runtime; the core `QueryOptions` type simply does not declare it.
  const interval = (query.options as { refetchInterval?: number | false | IntervalFn })
    .refetchInterval
  if (interval === undefined) {
    throw new Error(`query ${JSON.stringify(queryKey)} carries no refetchInterval option`)
  }
  return interval
}

function todayInterval(client: QueryClient, queryKey: unknown[]): IntervalFn {
  const interval = intervalFor(client, queryKey)
  if (typeof interval !== 'function') {
    throw new Error(`expected today's interval function, got ${JSON.stringify(interval)}`)
  }
  return interval
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/**
 * Renders `ui` under an optional EventStreamContext provider. Omitting
 * `connected` reproduces today's "no provider mounted" default.
 */
function mount(client: QueryClient, ui: ReactNode, connected?: boolean) {
  const tree =
    connected === undefined ? (
      ui
    ) : (
      <EventStreamContext.Provider value={{ connected }}>{ui}</EventStreamContext.Provider>
    )
  render(<QueryClientProvider client={client}>{tree}</QueryClientProvider>)
}

/** Stubs fetch with a body mapper; every response answers ok with its body. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve({ ok: true, json: async () => handler(String(input), init) } as Response),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const ITEM = {
  type: 'movie' as const,
  id: 411,
  title: 'Everything Everywhere All at Once',
  source: 'radarr',
}

const INDEXERS = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

const SETTINGS = { paths: { path_4k: '/mnt/storage/4k', path_3d: '/mnt/storage/3d' } }

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

const COPY_META: ActionMeta = {
  key: 'copy_files',
  label: 'Copiar archivos',
  description: 'Copia el archivo descargado a la carpeta de destino',
  destructive: false,
  scope: 'files',
}

function copyTrace(): Trace {
  return {
    source: 'radarr',
    title: 'Some Movie',
    date: null,
    indexer: null,
    download_client: null,
    download_client_host: null,
    download_id: 'abc123',
    matched_hash: null,
    stage: 'import_blocked',
    torrent: null,
    expected_category: null,
    category_ok: null,
    paused: false,
    ids: { queue_id: 42, episode_id: null, movie_id: 1, series_id: null },
    destination: null,
    queue: { state: 'ok', status: 'importing', output_path: '/downloads/incoming', messages: [] },
  }
}

function releaseModal() {
  return <ReleaseSearchModal item={ITEM} onClose={() => {}} />
}

function copyActions() {
  return (
    <TraceActions
      trace={copyTrace()}
      meta={{ copy_files: COPY_META } as Record<ActionKey, ActionMeta>}
      safeMode={false}
      onDone={() => {}}
    />
  )
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Listener = () => void

class MockEventSource {
  static instances: MockEventSource[] = []
  readonly url: string
  closed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(kind: string, listener: Listener): void {
    const existing = this.listeners.get(kind) ?? []
    existing.push(listener)
    this.listeners.set(kind, existing)
  }

  removeEventListener(kind: string, listener: Listener): void {
    const existing = this.listeners.get(kind) ?? []
    this.listeners.set(kind, existing.filter((l) => l !== listener))
  }

  close(): void {
    this.closed = true
  }

  dispatch(kind: string): void {
    for (const listener of this.listeners.get(kind) ?? []) listener()
  }
}

/** The arrangement App uses: the hook owns the status, the provider passes it down. */
function StreamHarness({ children }: { children: ReactNode }) {
  const stream = useEventStream(false)
  return <EventStreamContext.Provider value={stream}>{children}</EventStreamContext.Provider>
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearToasts()
  MockEventSource.instances = []
})

describe('SSE gates the task polls (B1)', () => {
  describe('connected: each task query refetchInterval evaluates to false', () => {
    it('turns the release search poll off', async () => {
      stubFetch((url, init) => {
        if (url.includes('/api/calendar/indexers')) return INDEXERS
        if (url.includes('/api/settings')) return SETTINGS
        if (url.includes('/api/calendar/releases')) {
          return init?.method === 'POST'
            ? { ok: true, task_id: 'rel-job-1', status: 'running', detail: 'search started' }
            : { ok: true, id: 'rel-job-1', status: 'running', detail: 'search started' }
        }
        return {}
      })
      const client = makeClient()
      mount(client, releaseModal(), true)

      fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
      expect(await screen.findByText(/Buscando releases/)).toBeInTheDocument()

      await waitFor(() =>
        expect(intervalFor(client, ['release-task', 'rel-job-1'])).toBe(false),
      )
    })

    it('turns the grab poll off', async () => {
      stubFetch((url, init) => {
        if (url.includes('/api/calendar/indexers')) return INDEXERS
        if (url.includes('/api/settings')) return SETTINGS
        if (url.includes('/api/calendar/releases')) {
          return { releases: [makeRelease()], detail: '1 releases found' }
        }
        if (url.includes('/api/calendar/grab')) {
          return init?.method === 'POST'
            ? { ok: true, task_id: 'grab-1', status: 'running', detail: 'grab started' }
            : { ok: true, id: 'grab-1', status: 'running', detail: 'grab started' }
        }
        return {}
      })
      const client = makeClient()
      mount(client, releaseModal(), true)

      fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
      await screen.findByPlaceholderText('Filtrar por título...')
      fireEvent.click(document.querySelector('.release-dest-btn') as HTMLElement)

      await waitFor(() => expect(intervalFor(client, ['grab-task', 'grab-1'])).toBe(false))
    })

    it('turns the copy task poll off', async () => {
      stubFetch((url) => {
        if (url.includes('/api/actions/copy_files')) {
          return {
            ok: true,
            task_id: 'copy-1',
            src_path: '/downloads/incoming/f.mkv',
            dst_path: '/media/movies/f.mkv',
          }
        }
        if (url.includes('/api/tasks/copy-1')) {
          return {
            ok: true,
            task_id: 'copy-1',
            status: 'running',
            src_path: '/downloads/incoming/f.mkv',
            dst_path: '/media/movies/f.mkv',
            copied_bytes: 1,
            total_bytes: 2,
            files_done: 0,
            files_total: 1,
            detail: 'copying',
          }
        }
        return {}
      })
      const client = makeClient()
      mount(client, copyActions(), true)

      fireEvent.click(await screen.findByRole('button', { name: 'Copiar archivos' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }))

      await waitFor(() => expect(intervalFor(client, ['task', 'copy-1'])).toBe(false))
    })

    it('turns the mixer tasks poll off', async () => {
      stubFetch((url) => {
        if (url.includes('/api/mixer/tasks')) return { ok: true, tasks: [] }
        if (url.includes('/api/files/roots')) return { ok: true, roots: [] }
        return {}
      })
      const client = makeClient()
      mount(client, <MediaMixer />, true)

      await waitFor(() => expect(intervalFor(client, ['mixer-tasks'])).toBe(false))
    })
  })

  describe('disconnected: today\'s intervals stay exactly as they are', () => {
    function expectTodayIntervals(client: QueryClient) {
      // Release search: 1500 until a terminal status, terminal still stops it.
      const release = todayInterval(client, ['release-task', undefined])
      expect(release({ state: { data: undefined } })).toBe(1500)
      expect(release({ state: { data: { status: 'running' } } })).toBe(1500)
      expect(release({ state: { data: { status: 'done' } } })).toBe(false)

      // Grab: same cadence, and a terminal status still stops it.
      const grab = todayInterval(client, ['grab-task', undefined])
      expect(grab({ state: { data: undefined } })).toBe(1500)
      expect(grab({ state: { data: { status: 'running' } } })).toBe(1500)
      expect(grab({ state: { data: { status: 'done' } } })).toBe(false)

      // Copy task: 1500 with or without data, terminal stops it.
      const copy = todayInterval(client, ['task', undefined])
      expect(copy({ state: { data: undefined } })).toBe(1500)
      expect(copy({ state: { data: { ok: true, status: 'running' } } })).toBe(1500)
      expect(copy({ state: { data: { ok: true, status: 'imported' } } })).toBe(false)

      // Mixer: 2000 while a task is active, 10000 when idle or without data.
      const mixer = todayInterval(client, ['mixer-tasks'])
      expect(mixer({ state: { data: undefined } })).toBe(10000)
      expect(mixer({ state: { data: { tasks: [{ status: 'running' }] } } })).toBe(2000)
      expect(mixer({ state: { data: { tasks: [{ status: 'done' }] } } })).toBe(10000)
    }

    function stubSurfaceFetch() {
      stubFetch((url) => {
        if (url.includes('/api/calendar/indexers')) return INDEXERS
        if (url.includes('/api/settings')) return SETTINGS
        if (url.includes('/api/mixer/tasks')) return { ok: true, tasks: [] }
        if (url.includes('/api/files/roots')) return { ok: true, roots: [] }
        return {}
      })
    }

    it("keeps every interval when no provider is mounted (the context's default)", () => {
      stubSurfaceFetch()
      const client = makeClient()
      mount(client, releaseModal())
      mount(client, copyActions())
      mount(client, <MediaMixer />)

      expectTodayIntervals(client)
    })

    it('keeps every interval when the provider reports disconnected', () => {
      stubSurfaceFetch()
      const client = makeClient()
      mount(client, releaseModal(), false)
      mount(client, copyActions(), false)
      mount(client, <MediaMixer />, false)

      expectTodayIntervals(client)
    })
  })

  describe('stream lifecycle drives the gate', () => {
    it(
      'open stops the polls, error resuscitates them, the next open stops them again',
      async () => {
        const tasks = [
          {
            task_id: 'mux-1',
            status: 'running',
            progress: 0.4,
            detail: 'muxing',
            output_path: '/out/f.mkv',
            created_at: 1,
          },
        ]
        const fn = stubFetch((url) => {
          if (url.includes('/api/mixer/tasks')) return { ok: true, tasks }
          if (url.includes('/api/files/roots')) return { ok: true, roots: [] }
          return {}
        })
        vi.stubGlobal('EventSource', MockEventSource)
        const client = makeClient()
        render(
          <QueryClientProvider client={client}>
            <StreamHarness>
              <MediaMixer />
            </StreamHarness>
          </QueryClientProvider>,
        )

        await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
        const source = MockEventSource.instances[MockEventSource.instances.length - 1]
        const mixerCalls = () =>
          fn.mock.calls.filter(([input]) => String(input).includes('/api/mixer/tasks'))

        // The effect opened the stream, but the first `open` event has not
        // arrived: today's interval still stands.
        expect(typeof intervalFor(client, ['mixer-tasks'])).toBe('function')

        // `open` → the gate closes: no refetch survives the 2000 ms schedule.
        act(() => source.dispatch('open'))
        await waitFor(() => expect(intervalFor(client, ['mixer-tasks'])).toBe(false))
        const connectedCalls = mixerCalls().length
        await delay(2600)
        expect(mixerCalls().length).toBe(connectedCalls)

        // `error` → the gate opens AND the poll actually fires again: the
        // fallback must be observed, not merely implied by the option.
        act(() => source.dispatch('error'))
        await waitFor(() => expect(typeof intervalFor(client, ['mixer-tasks'])).toBe('function'))
        await waitFor(() => expect(mixerCalls().length).toBeGreaterThan(connectedCalls), {
          timeout: 4000,
        })

        // The next `open` (EventSource's own resuscitation) closes the gate
        // again: no further refetch.
        const resumedCalls = mixerCalls().length
        act(() => source.dispatch('open'))
        await waitFor(() => expect(intervalFor(client, ['mixer-tasks'])).toBe(false))
        await delay(2600)
        expect(mixerCalls().length).toBe(resumedCalls)
      },
      15_000,
    )
  })
})

/**
 * B2 — the AMBIENT polls (App's own `['status']` 5 s and `['trace']` 15 s)
 * sleep while the SSE stream is connected.
 *
 * Only App owns those two options, so these tests mount the REAL App: the
 * backend now announces both surfaces (`check_all` publishes `kind:"status"`
 * after every check, the trace refresher keeps `kind:"trace"` flowing even
 * with no reader polling), which is what makes turning the polls off safe.
 * `['actions']` (60 s) has no event covering it and must stay exactly as it
 * is — the selectivity is part of the contract, not a side effect.
 */
describe('SSE gates the ambient polls (B2)', () => {
  /** Everything App asks for on the dashboard; unknown URLs answer `{}`. */
  function stubAppFetch() {
    return stubFetch((url) => {
      if (url.includes('/api/config')) {
        return { auth_required: false, encryption_ok: true, encryption_error: null, developer: false }
      }
      if (url.includes('/api/setup')) return { needs_setup: false }
      if (url.includes('/api/services')) return { services: [], configured: [] }
      if (url.includes('/api/status')) return { flow: 'running', checking: false }
      if (url.includes('/api/trace')) return { traces: [], summary: {}, updated_at: 1 }
      if (url.includes('/api/actions')) return { actions: [] }
      return {}
    })
  }

  /** Mount the real App and wait until both gated queries carry options. */
  async function mountApp(client: QueryClient) {
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(intervalFor(client, ['status'])).toBe(5000))
    await waitFor(() => expect(intervalFor(client, ['trace'])).toBe(15000))
  }

  it('turns the status and trace polls off while the stream is connected', async () => {
    stubAppFetch()
    vi.stubGlobal('EventSource', MockEventSource)
    const client = makeClient()
    await mountApp(client)

    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
    const source = MockEventSource.instances[MockEventSource.instances.length - 1]
    act(() => source.dispatch('open'))

    await waitFor(() => expect(intervalFor(client, ['status'])).toBe(false))
    await waitFor(() => expect(intervalFor(client, ['trace'])).toBe(false))
    // Triangulation: the uncovered poll must NOT be swept by the gate.
    await waitFor(() => expect(intervalFor(client, ['actions'])).toBe(60000))
  })

  it('keeps 5000/15000 when the stream never reports open', async () => {
    stubAppFetch()
    vi.stubGlobal('EventSource', MockEventSource)
    const client = makeClient()
    await mountApp(client)

    // The connection exists but no `open` arrived: disconnected → fallback.
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
    expect(intervalFor(client, ['status'])).toBe(5000)
    expect(intervalFor(client, ['trace'])).toBe(15000)
  })

  it('keeps 5000/15000 when the environment has no EventSource at all', async () => {
    // jsdom defines none (blocked browser, non-browser): the hook no-ops and
    // polling alone must cover both surfaces — today's behavior, unchanged.
    stubAppFetch()
    const client = makeClient()
    await mountApp(client)

    expect(intervalFor(client, ['status'])).toBe(5000)
    expect(intervalFor(client, ['trace'])).toBe(15000)
  })
})

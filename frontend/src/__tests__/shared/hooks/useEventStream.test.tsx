import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEventStream } from '../../../shared/hooks/useEventStream.ts'
import { forgetApiKey, rememberApiKey } from '../../../shared/api/auth.ts'

/**
 * sse-events T3/T4 — the hook that turns server events into invalidations.
 *
 * The polling fallback (`refetchInterval`) stays exactly as it is — this hook
 * is an accelerator on top, never a replacement. Four things are pinned:
 * the URL opens on `/api/events` carrying the same key `apiFetch` would; each
 * event kind invalidates the query key that surface ACTUALLY uses (grep-verified
 * keys; the dashboard's ['downloads'] card gave the downloads event its real
 * consumer); a
 * environment without `EventSource` (jsdom, a blocked browser) must leave the
 * app running on polling alone instead of crashing; and the stream NEVER
 * opens while auth is required and no key is stored — a keyless 401 retry
 * loop fills C-05's auth-failure budget (10/60s per address) and can 429 the
 * browser's other requests before the user ever types the key.
 */

type Listener = (event: MessageEvent) => void

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

  emit(kind: string, payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    for (const listener of this.listeners.get(kind) ?? []) {
      listener({ data } as MessageEvent)
    }
  }
}

function Probe({ authRequired }: { authRequired: boolean }) {
  useEventStream(authRequired)
  return null
}

function setup({ authRequired = false }: { authRequired?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  // The provider must stay in the tree across rerenders (the gating tests
  // flip authRequired on the SAME client), so the UI is a function of state.
  const ui = (required: boolean) => (
    <QueryClientProvider client={queryClient}>
      <Probe authRequired={required} />
    </QueryClientProvider>
  )
  const view = render(ui(authRequired))
  return { queryClient, invalidate, ui, ...view }
}

async function openStream(): Promise<MockEventSource> {
  await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
  return MockEventSource.instances[MockEventSource.instances.length - 1]
}

beforeEach(() => {
  MockEventSource.instances = []
  forgetApiKey()
  vi.stubGlobal('EventSource', MockEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
  forgetApiKey()
})

describe('opening the stream', () => {
  it('carries the stored key as ?key= so EventSource authenticates', async () => {
    rememberApiKey('clave-secreta')
    setup()
    const source = await openStream()
    expect(source.url).toBe('/api/events?key=clave-secreta')
  })

  it('closes the connection when the component unmounts', async () => {
    const { unmount } = setup()
    const source = await openStream()

    unmount()

    expect(source.closed).toBe(true)
  })
})

describe('auth gating', () => {
  it('never opens while auth is required and no key is stored (pre-login)', async () => {
    setup({ authRequired: true })

    // Effects flush inside render's act(), so an ungated hook would have
    // constructed the EventSource already. A second turn for good measure:
    // one keyless 401 every ~3s is exactly the budget this gate exists to
    // keep out of C-05's AUTH_FAILURE_LIMIT.
    expect(MockEventSource.instances).toHaveLength(0)
    await Promise.resolve()
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('opens when a key is stored, even though auth is required', async () => {
    rememberApiKey('clave-secreta')
    setup({ authRequired: true })

    const source = await openStream()

    expect(source.url).toBe('/api/events?key=clave-secreta')
  })

  it('opens without a key when auth is disabled', async () => {
    setup({ authRequired: false })

    const source = await openStream()

    expect(source.url).toBe('/api/events')
  })

  it('closes the stream when auth becomes required again', async () => {
    const { ui, rerender } = setup({ authRequired: false })
    const source = await openStream()

    rerender(ui(true)) // logout / rotated key: no key stored, auth back on

    expect(source.closed).toBe(true)
    // No replacement stream may open behind the closed one.
    expect(MockEventSource.instances).toHaveLength(1)
  })
})

describe('event → query invalidation', () => {
  it('invalidates the grab query for a grab task event', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('task', {
      kind: 'task',
      channel: 'grab',
      task_id: 'grab-1',
      status: 'done',
      detail: 'Release encolado',
    })

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['grab-task', 'grab-1'] }),
    )
  })

  it('invalidates the release query for a release task event', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('task', {
      kind: 'task',
      channel: 'release',
      task_id: 'rel-1',
      status: 'done',
      detail: '1 releases',
    })

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['release-task', 'rel-1'] }),
    )
  })

  it('invalidates the copy task query for a copy task event', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('task', {
      kind: 'task',
      channel: 'copy',
      task_id: 'copy-1',
      status: 'done',
      detail: 'copia completada',
    })

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task', 'copy-1'] }),
    )
  })

  it('invalidates the whole mixer task list for a mixer task event', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('task', {
      kind: 'task',
      channel: 'mixer',
      task_id: 'mux-1',
      status: 'done',
      detail: 'Starting mux...',
    })

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mixer-tasks'] }),
    )
  })

  it('invalidates the trace query for a trace event', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('trace', { kind: 'trace', version: 1728000000 })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['trace'] }))
  })

  it('invalidates the status query for a status event (B2)', async () => {
    // `check_all` announces after every tick and every /api/status/refresh —
    // this listener is what lets App's 5 s ['status'] poll sleep on the stream.
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('status', { kind: 'status', version: 1728000000 })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['status'] }))
  })

  it('invalidates the downloads query for a downloads event', async () => {
    // The dashboard card reads ['downloads'] now (Stitch 01), so the backend's
    // downloads snapshot event has a real key to accelerate.
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('downloads', { kind: 'downloads', version: 1728000000 })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] }))
  })

  it('also invalidates the activity table for a downloads event (S6)', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('downloads', { kind: 'downloads', version: 1728000000 })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['activity'] }))
  })

  it('invalidates the activity table for any task event (S6)', async () => {
    // Operations move when tasks move: the activity table follows both feeds.
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('task', { kind: 'task', channel: 'copy', task_id: 't-1', status: 'done' })

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['activity'] }))
  })

  it('skips a channel with no query key instead of inventing one', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('task', { kind: 'task', channel: 'unknown', task_id: 'x', status: 'done' })

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('survives a malformed payload without invalidating anything', async () => {
    const { invalidate } = setup()
    const source = await openStream()

    source.emit('task', 'esto no es json {{{')

    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('without EventSource', () => {
  it('no-ops and leaves the app on the polling fallback', () => {
    vi.unstubAllGlobals() // jsdom defines no EventSource at all
    expect(typeof EventSource).toBe('undefined')

    expect(() => setup()).not.toThrow()
    expect(MockEventSource.instances).toHaveLength(0)
  })
})

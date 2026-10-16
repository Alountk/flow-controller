import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../app/App.tsx'
import { forgetApiKey, setUnauthorizedHandler } from '../../shared/api/auth.ts'

/**
 * B-12 — the activity queryFn never handed React Query's abort signal to the
 * request: `queryFn: () => fetchJson('/api/activity')` dropped the context's
 * `signal`, so cancelling a refetch only cancelled React Query's *wait* — the
 * stale GET /api/activity kept running to completion. This contract pins the
 * signal end to end: the request carries an AbortSignal, and cancelling the
 * ['activity'] query aborts it.
 */

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const ok = (body: unknown = {}) =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('activity fetch abort (B-12)', () => {
  beforeEach(() => {
    forgetApiKey()
    setUnauthorizedHandler(null)
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  it('sends an AbortSignal on GET /api/activity and aborts it when the query is cancelled', async () => {
    // Auth disabled (auth_required:false) authenticates the app on its own;
    // /api/activity itself never settles, so its call stays in flight until
    // the query is cancelled.
    const fn = mockFetch((url) => {
      if (url.includes('/api/activity')) return new Promise<Response>(() => {})
      if (url.includes('/api/config')) return ok({ developer: false, auth_required: false })
      if (url.includes('/api/services')) return ok({ services: [], configured: [] })
      return ok({})
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(fn.mock.calls.some(([url]) => String(url).includes('/api/activity'))).toBe(true)
    })
    const activityCall = fn.mock.calls.find(([url]) => String(url).includes('/api/activity'))!
    const init = activityCall[1] as RequestInit | undefined

    // The request must carry the query's abort signal (B-12: fetchJson used to
    // drop init, so this was undefined and the fetch could never be aborted).
    expect(init?.signal).toBeInstanceOf(AbortSignal)

    await client.cancelQueries({ queryKey: ['activity'] })
    expect((init?.signal as AbortSignal).aborted).toBe(true)
  })
})

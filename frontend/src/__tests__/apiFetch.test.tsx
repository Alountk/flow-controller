import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../App'
import {
  apiFetch,
  forgetApiKey,
  hasStoredApiKey,
  rememberApiKey,
  setUnauthorizedHandler,
  UnauthorizedError,
} from '../api/auth'

/**
 * Central auth handling.
 *
 * Two bugs motivated this: `fetchJson` sent no auth header at all, so the
 * dashboard's own calls failed once those routes started requiring the key; and
 * the key was only validated once at boot, so a cleared or rotated key left
 * every panel failing with no way to re-enter it.
 */

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const ok = (body: unknown = {}) =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('apiFetch', () => {
  beforeEach(() => {
    forgetApiKey()
    setUnauthorizedHandler(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  it('sends the stored key as a header', async () => {
    rememberApiKey('mi-clave')
    const fn = mockFetch(() => ok())

    await apiFetch('/api/status')

    const [, init] = fn.mock.calls[0]
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe('mi-clave')
  })

  it('forgets the key and notifies on 401', async () => {
    rememberApiKey('caducada')
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockFetch(() => ({ ok: false, status: 401, json: async () => ({}) }) as Response)

    await expect(apiFetch('/api/status')).rejects.toBeInstanceOf(UnauthorizedError)

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(hasStoredApiKey()).toBe(false)
  })

  it('leaves other failures to the caller and does not notify', async () => {
    rememberApiKey('buena')
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response)

    // Only 401 is a credential problem; a 500 must not log the user out.
    const res = await apiFetch('/api/status')

    expect(res.status).toBe(500)
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(hasStoredApiKey()).toBe(true)
  })
})

describe('the app sends its auth header', () => {
  beforeEach(() => {
    forgetApiKey()
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  it('authenticates the dashboard calls, not just the page-level ones', async () => {
    // The regression: fetchJson called bare fetch, so /api/status, /api/trace
    // and /api/actions went out without the key and failed with 401.
    rememberApiKey('clave-valida')
    const fn = mockFetch((url) => {
      if (url.includes('/api/config')) return ok({ developer: false, auth_required: true })
      if (url.includes('/api/auth/check')) return ok({ ok: true })
      if (url.includes('/api/status')) return ok({ radarr: 'online:ok', sonarr: 'online:ok', amutorrent: 'online:ok', flow: 'running' })
      if (url.includes('/api/trace')) return ok({ items: [], summary: {} })
      if (url.includes('/api/actions')) return ok({ actions: {} })
      return ok({})
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )

    await waitFor(() => {
      const statusCall = fn.mock.calls.find(([url]) => String(url).includes('/api/status'))
      expect(statusCall).toBeDefined()
    })

    const statusCall = fn.mock.calls.find(([url]) => String(url).includes('/api/status'))!
    const headers = statusCall[1]?.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe('clave-valida')
  })

  it('returns to the key prompt when a call is rejected mid-session', async () => {
    // The reported bug: the key was only checked at boot, so a later rejection
    // left the app failing with no way to enter it again.
    rememberApiKey('se-invalido')
    let rejectStatus = false
    mockFetch((url) => {
      if (url.includes('/api/config')) return ok({ developer: false, auth_required: true })
      if (url.includes('/api/auth/check')) return ok({ ok: true })
      if (url.includes('/api/status')) {
        return rejectStatus
          ? ({ ok: false, status: 401, json: async () => ({}) } as Response)
          : ok({ radarr: 'online:ok', sonarr: 'online:ok', amutorrent: 'online:ok', flow: 'running' })
      }
      if (url.includes('/api/trace')) return ok({ items: [], summary: {} })
      if (url.includes('/api/actions')) return ok({ actions: {} })
      return ok({})
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )

    // Authenticated to start with: no prompt.
    await waitFor(() => expect(screen.queryByLabelText('API key')).not.toBeInTheDocument())

    // The backend starts rejecting the stored key.
    rejectStatus = true
    await client.refetchQueries({ queryKey: ['status'] })

    await waitFor(() => expect(screen.getByLabelText('API key')).toBeInTheDocument())
  })
})

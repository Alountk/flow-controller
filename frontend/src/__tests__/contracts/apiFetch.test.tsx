import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../app/App.tsx'
import {
  apiFetch,
  markSessionActive,
  resetSession,
  setUnauthorizedHandler,
  UnauthorizedError,
} from '../../shared/api/auth.ts'

/**
 * Central auth handling.
 *
 * The session lives in an HttpOnly cookie the browser sends by itself, so
 * `apiFetch` adds no credential header. What it still owns is the reaction to
 * a 401: a page that held a session goes back to the login, instead of every
 * panel failing with no way to sign in again.
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
    resetSession()
    setUnauthorizedHandler(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  it('sends no credential header: the session cookie travels by itself', async () => {
    markSessionActive()
    const fn = mockFetch(() => ok())

    await apiFetch('/api/status')

    const [, init] = fn.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('notifies once on a 401 after a session, then stops until a new one', async () => {
    markSessionActive()
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockFetch(() => ({ ok: false, status: 401, json: async () => ({}) }) as Response)

    await expect(apiFetch('/api/status')).rejects.toBeInstanceOf(UnauthorizedError)
    await expect(apiFetch('/api/status')).rejects.toBeInstanceOf(UnauthorizedError)

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('leaves other failures to the caller and does not notify', async () => {
    markSessionActive()
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response)

    // Only 401 is a credential problem; a 500 must not sign the user out.
    const res = await apiFetch('/api/status')

    expect(res.status).toBe(500)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('the app under a session', () => {
  beforeEach(() => {
    resetSession()
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  function routes(rejectStatus: () => boolean) {
    return (url: string) => {
      if (url.includes('/api/config')) return ok({ developer: false, auth_required: true })
      if (url.includes('/api/auth/me')) {
        return ok({ authenticated: true, auth_required: true, has_user: true })
      }
      if (url.includes('/api/status')) {
        return rejectStatus()
          ? ({ ok: false, status: 401, json: async () => ({}) } as Response)
          : ok({ radarr: 'online:ok', sonarr: 'online:ok', amutorrent: 'online:ok', flow: 'running' })
      }
      if (url.includes('/api/trace')) return ok({ items: [], summary: {} })
      if (url.includes('/api/actions')) return ok({ actions: {} })
      if (url.includes('/api/downloads')) return ok({ downloads: [], errors: [] })
      if (url.includes('/api/services')) {
        return ok({ services: [], configured: ['radarr', 'sonarr', 'amutorrent'] })
      }
      return ok({})
    }
  }

  function renderApp() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )
    return client
  }

  it('loads the dashboard calls with no extra credential', async () => {
    const fn = mockFetch(routes(() => false))
    renderApp()

    await waitFor(() => {
      expect(fn.mock.calls.some(([url]) => String(url).includes('/api/status'))).toBe(true)
    })
    const statusCall = fn.mock.calls.find(([url]) => String(url).includes('/api/status'))!
    expect((statusCall[1]?.headers as Record<string, string>)['X-Api-Key']).toBeUndefined()
  })

  it('returns to the login when a call is rejected mid-session', async () => {
    let rejectStatus = false
    mockFetch(routes(() => rejectStatus))
    const client = renderApp()

    // Signed in to start with: no login screen.
    await waitFor(() => expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument())
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' })

    // The session ends server-side.
    rejectStatus = true
    await client.refetchQueries({ queryKey: ['status'] })

    await waitFor(() => expect(screen.getByLabelText('Usuario')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument()
  })
})

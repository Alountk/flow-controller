import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthGate } from '../components/AuthGate'
import App from '../App'
import { forgetApiKey, hasStoredApiKey, rememberApiKey, verifyApiKey } from '../api/auth'

/**
 * The backend no longer serves the API key — handing it out anonymously let
 * anyone reaching the port bootstrap to every stored credential. The browser
 * must now supply it.
 */

function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (url.includes(fragment)) return Promise.resolve(handler())
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('AuthGate', () => {
  beforeEach(() => {
    forgetApiKey()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stores the key and continues when it is correct', async () => {
    mockFetch({ '/api/auth/check': () => ({ ok: true, json: async () => ({ ok: true }) }) as Response })
    const onAuthenticated = vi.fn()

    render(<AuthGate onAuthenticated={onAuthenticated} />)
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'buena' } })
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled())
    expect(hasStoredApiKey()).toBe(true)
  })

  it('reports a wrong key and does not continue', async () => {
    mockFetch({ '/api/auth/check': () => ({ ok: false, json: async () => ({}) }) as Response })
    const onAuthenticated = vi.fn()

    render(<AuthGate onAuthenticated={onAuthenticated} />)
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'mala' } })
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('API key incorrecta')
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(hasStoredApiKey()).toBe(false)
  })

  it('reports a transport failure instead of hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    render(<AuthGate onAuthenticated={() => {}} />)
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })
})

describe('verifyApiKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the candidate key as a header', async () => {
    const fn = mockFetch({ '/api/auth/check': () => ({ ok: true }) as Response })

    await verifyApiKey('candidata')

    const [, init] = fn.mock.calls[0]
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe('candidata')
  })

  it('is false when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))

    expect(await verifyApiKey('x')).toBe(false)
  })
})

describe('App gate', () => {
  beforeEach(() => {
    forgetApiKey()
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for the key when the backend requires one', async () => {
    mockFetch({
      '/api/config': () =>
        ({ ok: true, json: async () => ({ developer: false, auth_required: true }) }) as Response,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByLabelText('API key')).toBeInTheDocument())
  })

  it('does not ask when the backend has no key configured', async () => {
    mockFetch({
      '/api/config': () =>
        ({ ok: true, json: async () => ({ developer: false, auth_required: false }) }) as Response,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.queryByLabelText('API key')).not.toBeInTheDocument())
  })

  it('does not ask when a valid key is already remembered', async () => {
    rememberApiKey('guardada')
    mockFetch({
      '/api/config': () =>
        ({ ok: true, json: async () => ({ developer: false, auth_required: true }) }) as Response,
      '/api/auth/check': () => ({ ok: true }) as Response,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.queryByLabelText('API key')).not.toBeInTheDocument())
  })

  it('asks again when the remembered key was rotated server-side', async () => {
    rememberApiKey('obsoleta')
    mockFetch({
      '/api/config': () =>
        ({ ok: true, json: async () => ({ developer: false, auth_required: true }) }) as Response,
      '/api/auth/check': () => ({ ok: false }) as Response,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByLabelText('API key')).toBeInTheDocument())
    // A rejected key must not linger.
    expect(hasStoredApiKey()).toBe(false)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthGate } from '../../app/AuthGate.tsx'
import App from '../../app/App.tsx'
import { resetSession } from '../../shared/api/auth.ts'

/**
 * The first thing the app shows is the account: create the administrator, or
 * sign in. There is no API key prompt any more.
 */

type Handler = (init?: RequestInit) => Response | Promise<Response>

function mockFetch(handlers: Record<string, Handler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (url.includes(fragment)) return Promise.resolve(handler(init))
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

const me = (state: object) => ({ '/api/auth/me': () => json(state), '/api/config': () => json({ developer: false, auth_required: false }) })

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

beforeEach(() => {
  resetSession()
  window.location.hash = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuthGate · login', () => {
  it('signs in with the username and password and continues', async () => {
    const fn = mockFetch({ '/api/auth/login': () => json({ ok: true }) })
    const onAuthenticated = vi.fn()

    render(<AuthGate mode="login" onAuthenticated={onAuthenticated} />)
    fill('Usuario', 'raul')
    fill('Contraseña', 'correct horse')
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled())
    const [, init] = fn.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({ username: 'raul', password: 'correct horse' })
  })

  it('shows the backend message for a wrong password and does not continue', async () => {
    mockFetch({ '/api/auth/login': () => json({ detail: 'Usuario o contraseña incorrectos' }, 401) })
    const onAuthenticated = vi.fn()

    render(<AuthGate mode="login" onAuthenticated={onAuthenticated} />)
    fill('Usuario', 'raul')
    fill('Contraseña', 'wrong horse!!')
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Usuario o contraseña incorrectos')
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it('reports a transport failure instead of hanging', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))

    render(<AuthGate mode="login" onAuthenticated={() => {}} />)
    fill('Usuario', 'raul')
    fill('Contraseña', 'x')
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo conectar')
  })

  it('never asks for an API key or for a second password', () => {
    render(<AuthGate mode="login" onAuthenticated={() => {}} />)

    expect(screen.queryByLabelText('API key actual')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Repite la contraseña')).not.toBeInTheDocument()
  })
})

describe('AuthGate · create the administrator', () => {
  it('creates the account and continues', async () => {
    const fn = mockFetch({ '/api/auth/register': () => json({ ok: true }) })
    const onAuthenticated = vi.fn()

    render(<AuthGate mode="create" onAuthenticated={onAuthenticated} />)
    fill('Usuario', 'raul')
    fill('Contraseña', 'correct horse')
    fill('Repite la contraseña', 'correct horse')
    fireEvent.click(screen.getByRole('button', { name: 'Crear administrador' }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled())
    const [, init] = fn.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({ username: 'raul', password: 'correct horse' })
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBeUndefined()
  })

  it('refuses mismatched passwords without calling the backend', () => {
    const fn = mockFetch({})

    render(<AuthGate mode="create" onAuthenticated={() => {}} />)
    fill('Usuario', 'raul')
    fill('Contraseña', 'correct horse')
    fill('Repite la contraseña', 'correct horsE')
    fireEvent.click(screen.getByRole('button', { name: 'Crear administrador' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Las contraseñas no coinciden')
    expect(fn).not.toHaveBeenCalled()
  })

  it('refuses a short password without calling the backend', () => {
    const fn = mockFetch({})

    render(<AuthGate mode="create" onAuthenticated={() => {}} />)
    fill('Usuario', 'raul')
    fill('Contraseña', 'short')
    fill('Repite la contraseña', 'short')
    fireEvent.click(screen.getByRole('button', { name: 'Crear administrador' }))

    expect(screen.getByRole('alert')).toHaveTextContent('al menos 8 caracteres')
    expect(fn).not.toHaveBeenCalled()
  })

  it('asks for the old API key once, and only on an install that had one', async () => {
    const fn = mockFetch({ '/api/auth/register': () => json({ ok: true }) })
    const onAuthenticated = vi.fn()

    render(<AuthGate mode="create" needsApiKey onAuthenticated={onAuthenticated} />)
    const submit = screen.getByRole('button', { name: 'Crear administrador' })
    fill('Usuario', 'raul')
    fill('Contraseña', 'correct horse')
    fill('Repite la contraseña', 'correct horse')
    expect(submit).toBeDisabled() // the key is required to prove ownership

    fill('API key actual', 'la-clave-vieja')
    fireEvent.click(submit)

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled())
    const [, init] = fn.mock.calls[0]
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe('la-clave-vieja')
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('api_key')
  })

  it('shows the backend message when the key is wrong', async () => {
    mockFetch({ '/api/auth/register': () => json({ detail: 'API key inválida' }, 401) })

    render(<AuthGate mode="create" needsApiKey onAuthenticated={() => {}} />)
    fill('Usuario', 'raul')
    fill('Contraseña', 'correct horse')
    fill('Repite la contraseña', 'correct horse')
    fill('API key actual', 'mala')
    fireEvent.click(screen.getByRole('button', { name: 'Crear administrador' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('API key inválida')
  })
})

describe('App · what the first screen is', () => {
  it('shows «crear administrador» first when nobody has an account', async () => {
    mockFetch(me({ authenticated: true, auth_required: false, has_user: false }))
    renderApp()

    expect(await screen.findByRole('button', { name: 'Crear administrador' })).toBeInTheDocument()
    expect(screen.queryByLabelText('API key actual')).not.toBeInTheDocument()
  })

  it('also asks for the old key when the install had one but no account yet', async () => {
    mockFetch(me({ authenticated: false, auth_required: true, has_user: false }))
    renderApp()

    expect(await screen.findByLabelText('API key actual')).toBeInTheDocument()
  })

  it('shows the login when the account exists and this browser is not signed in', async () => {
    mockFetch(me({ authenticated: false, auth_required: true, has_user: true }))
    renderApp()

    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Crear administrador' })).not.toBeInTheDocument()
  })

  it('shows neither when the browser already has a session', async () => {
    mockFetch(me({ authenticated: true, auth_required: true, has_user: true }))
    renderApp()

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Entrar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Crear administrador' })).not.toBeInTheDocument()
  })

  it('goes straight into the app after creating the administrator', async () => {
    let created = false
    mockFetch({
      '/api/config': () => json({ developer: false, auth_required: false }),
      '/api/auth/me': () =>
        json({ authenticated: created, auth_required: created, has_user: created }),
      '/api/auth/register': () => {
        created = true
        return json({ ok: true })
      },
    })
    renderApp()

    await screen.findByRole('button', { name: 'Crear administrador' })
    fill('Usuario', 'raul')
    fill('Contraseña', 'correct horse')
    fill('Repite la contraseña', 'correct horse')
    fireEvent.click(screen.getByRole('button', { name: 'Crear administrador' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Crear administrador' })).not.toBeInTheDocument(),
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
  })
})

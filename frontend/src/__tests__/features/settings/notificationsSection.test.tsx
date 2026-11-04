import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'

/**
 * La tarjeta «Avisos» de Configuración → General (`odd/tasks/avisos-descargas.md`,
 * S1 y S2): el canal ntfy se configura desde el panel y se prueba con un botón
 * que envía un aviso de verdad.
 *
 * Lo que se fija y no puede aflojarse:
 *  - el token se pinta como contraseña: es una credencial, no un texto;
 *  - «Probar aviso» llama a `POST /api/notifications/test` y NO guarda nada
 *    (probar el canal no es guardarlo);
 *  - el resultado del envío se lee como texto — un fallo con su motivo, nunca
 *    un éxito optimista.
 */

const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    qbit: { url: '', user: '', password: '' },
    opensubtitles: { api_key: '' },
    amule: { url: '', ec_port: '4712', ec_password: '' },
  },
  security: { api_key: '', safe_mode: true },
  developer: false,
  paths: {
    download_amule: '/mnt/storage-6tb/shared-downloads/amule',
    download_torrent: '/mnt/storage/downloads/qbittorrent/completed',
    output_mixed: '/mnt/storage/mixed',
    allowed_roots: ['/mnt/storage'],
  },
  intervals: { check: 15, max_retries: 3, retry_delay: 2, request_timeout: 5, import_timeout: 40 },
  tracing: { limit: 25 },
  retention: { amule_days: 7 },
  notifications: {
    ntfy: { url: 'http://ntfy.test:8080', topic: 'flowcontroller', token: '****9876', enabled: true },
  },
  server: { port: 8000 },
}

type RouteHandler = (body: Record<string, unknown> | null) => unknown

function mockFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    const handler = routes[key]
    const respond = (answer: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => answer } as Response)
    if (!handler) return respond({})
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    return respond(handler(body))
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

const baseRoutes = () => ({
  'GET /api/settings': () => settings,
  'GET /api/services': () => ({ services: [] }),
  'GET /api/amule/shared-dirs': () => ({ dirs: [] }),
  'GET /api/logs': () => ({ logs: [] }),
})

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Avisos por ntfy', () => {
  it('pinta el canal con sus cuatro campos y el token como contraseña', async () => {
    const fetchMock = mockFetch(baseRoutes())
    renderSettings()

    const url = (await screen.findByDisplayValue('http://ntfy.test:8080')) as HTMLInputElement
    expect(url).toBeInTheDocument()

    const topic = screen.getByDisplayValue('flowcontroller')
    expect(topic).toBeInTheDocument()

    const token = screen.getByDisplayValue('****9876') as HTMLInputElement
    expect(token.type).toBe('password')

    expect(screen.getByRole('button', { name: /probar aviso/i })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('«Probar aviso» envía el aviso y enseña el veredicto sin guardar', async () => {
    const fetchMock = mockFetch({
      ...baseRoutes(),
      'POST /api/notifications/test': () => ({ ok: true, status: 200, elapsed_ms: 42, error: '' }),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: /probar aviso/i }))

    expect(await screen.findByText(/aviso enviado/i)).toBeInTheDocument()
    const posted = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'POST')
    expect(posted.map(([input]) => String(input))).toEqual(['/api/notifications/test'])
  })

  it('un canal caído se lee como fallo con su motivo, no como éxito', async () => {
    mockFetch({
      ...baseRoutes(),
      'POST /api/notifications/test': () => ({
        ok: false,
        status: null,
        elapsed_ms: 5001,
        error: 'ClientConnectorError: refused',
      }),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: /probar aviso/i }))

    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent(/no se pudo enviar/i)
    expect(failure).toHaveTextContent(/refused/i)
  })

  it('un canal sin configurar lo dice en vez de fingir un envío', async () => {
    mockFetch({
      ...baseRoutes(),
      'POST /api/notifications/test': () => ({
        ok: false,
        status: null,
        elapsed_ms: 0,
        error: 'not-configured',
      }),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: /probar aviso/i }))

    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent(/sin configurar/i)
  })
})

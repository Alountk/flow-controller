import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'

/**
 * «Estado de las conexiones» pasa de tarjetas a la tabla del diseño
 * (`odd/tasks/config-general-rediseno.md`, T4 / specs S2 y S4): cuatro
 * columnas —Servicio, Endpoint, Estado, Latencia—, estado en píldora y la
 * latencia medida que devuelve `/api/services/test` en `elapsed_ms`.
 *
 * Lo que se fija aquí y no puede aflojarse:
 *  - la sección NUNCA sondea al montar (S4): cinco salidas HTTP en la carga de
 *    Configuración la harían lenta y chocarían con el límite de peticiones;
 *  - las filas existen antes de sondear, con «Sin comprobar» o «No configurado»
 *    (S4: la lista sale de `/api/services`, que no toca la red);
 *  - un timeout se lee «Timeout», no un número de milisegundos.
 */

const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    qbit: { url: 'http://localhost:8080', user: 'admin', password: 'p' },
    opensubtitles: { api_key: '' },
    amule: { url: 'http://192.168.1.10', ec_port: '4712', ec_password: '****abcd' },
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

const services = {
  services: [
    { key: 'radarr', kind: 'arr', url: 'http://localhost:7878', configured: true },
    { key: 'sonarr', kind: 'arr', url: 'http://localhost:8989', configured: true },
    { key: 'prowlarr', kind: 'prowlarr', url: '', configured: false },
    { key: 'amule', kind: 'amule', url: 'http://192.168.1.10', configured: true },
  ],
  configured: ['radarr', 'sonarr', 'amule'],
}

const baseRoutes: Record<string, RouteHandler> = {
  'GET /api/settings': () => settings,
  'GET /api/logs': () => ({ logs: [] }),
  'GET /api/services': () => services,
  'GET /api/indexers': () => ({ indexers: [] }),
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

/** La tabla del diseño, no las tarjetas de «Servicios». */
async function connectionsTable(): Promise<HTMLElement> {
  const table = await screen.findByRole('table')
  return table as HTMLElement
}

async function rowOf(service: string): Promise<HTMLElement> {
  const table = await connectionsTable()
  const row = within(table).getByText(service).closest('tr')
  return row as HTMLElement
}

describe('tabla de «Estado de las conexiones» (T4/S2, S4)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists every service from /api/services without probing on mount', async () => {
    const fetchMock = mockFetch(baseRoutes)
    renderSettings()

    const table = await connectionsTable()
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Servicio',
      'Endpoint',
      'Estado',
      'Latencia',
    ])
    expect(await rowOf('Radarr')).toHaveTextContent('Sin comprobar')
    expect(await rowOf('Prowlarr')).toHaveTextContent('No configurado')
    // Sin latencia todavía, y sobre todo sin sondeo: S4 prohíbe tocar la red
    // al abrir la página.
    expect(await rowOf('Radarr')).toHaveTextContent('—')
    // A 380px la tabla no cabe: el contenedor scrollea, porque recortar la
    // píldora «Sin comprobar» esconde el estado que la fila viene a mostrar.
    expect(table.parentElement).toHaveClass('connections-table-wrap')
    const probed = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/services/test'))
    expect(probed).toHaveLength(0)

    // aMule responde por EC (TCP), no por HTTP: el botón no lo sondeará nunca,
    // así que la fila no puede quedarse en «Sin comprobar» para siempre.
    const amule = await rowOf('aMule')
    expect(amule).toHaveTextContent('Sin sonda')
    expect(within(amule).getByTitle(/EC \(TCP\)/)).toBeInTheDocument()
  })

  it('fills the same row with the status and the measured latency after probing', async () => {
    mockFetch({
      ...baseRoutes,
      'GET /api/services/test': () => ({
        ok: false,
        results: [
          { key: 'radarr', kind: 'arr', url: 'http://localhost:7878', ok: true, version: 'v5', detail: 'Conectado (v5)', elapsed_ms: 42 },
          { key: 'sonarr', kind: 'arr', url: 'http://localhost:8989', ok: false, detail: 'sonarr: no respondió a tiempo', error_kind: 'timeout', elapsed_ms: 5000 },
        ],
      }),
    })
    renderSettings()
    await connectionsTable()

    fireEvent.click(screen.getByRole('button', { name: /Probar conexiones/ }))

    await waitFor(async () => expect(await rowOf('Radarr')).toHaveTextContent('Conectado'))
    expect(await rowOf('Radarr')).toHaveTextContent('42ms')
    // Un timeout se lee «Timeout»: los milisegundos que tardó en rendirse no
    // son una latencia que nadie quiera leer.
    expect(await rowOf('Sonarr')).toHaveTextContent('Alerta')
    expect(await rowOf('Sonarr')).toHaveTextContent('Timeout')
    // Los que no se sondearon conservan su estado previo, no uno inventado.
    // aMule sigue en «Sin sonda»: es EC sobre TCP, no lo toca este botón.
    expect(await rowOf('aMule')).toHaveTextContent('Sin sonda')
  })

  it('reports a rejected API key as a failed alert, not as a connection', async () => {
    mockFetch({
      ...baseRoutes,
      'GET /api/services/test': () => ({
        ok: false,
        results: [
          { key: 'radarr', kind: 'arr', url: 'http://localhost:7878', ok: false, detail: 'radarr: API key rechazada (HTTP 401)', error_kind: 'auth', elapsed_ms: 7 },
        ],
      }),
    })
    renderSettings()
    await connectionsTable()

    fireEvent.click(screen.getByRole('button', { name: /Probar conexiones/ }))

    await waitFor(async () => expect(await rowOf('Radarr')).toHaveTextContent('Alerta'))
    expect(await rowOf('Radarr')).toHaveTextContent('7ms')
  })

  it('does not invent a latency for a row that was never measured', async () => {
    // El backend devuelve un resultado también para lo no configurado (con
    // `elapsed_ms: 0`). Pintar «0ms» ahí sería una medida que no ocurrió.
    mockFetch({
      ...baseRoutes,
      'GET /api/services/test': () => ({
        ok: false,
        results: [
          { key: 'prowlarr', kind: 'prowlarr', url: '', ok: false, detail: 'prowlarr: no está configurado', error_kind: 'auth', elapsed_ms: 0 },
        ],
      }),
    })
    renderSettings()
    await connectionsTable()

    fireEvent.click(screen.getByRole('button', { name: /Probar conexiones/ }))

    const prowlarr = await rowOf('Prowlarr')
    await waitFor(() => expect(prowlarr).toHaveTextContent('No configurado'))
    expect(prowlarr).toHaveTextContent('—')
    expect(prowlarr).not.toHaveTextContent('0ms')
  })
})

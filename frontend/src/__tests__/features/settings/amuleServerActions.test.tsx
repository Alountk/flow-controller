import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import { AmuleServerActions } from '../../../features/settings/AmuleServerActions.tsx'
import type { AmuleServerRow } from '../../../shared/api/services.ts'

/**
 * amule-control T4 (S1 + S5): la tercera pestaña «aMule» del rail (la config de
 * aMule se muda allí, S1) y el bloque «Control de aMule» (listado con estado,
 * añadir/conectar/quitar servidores, enlaces ed2k/magnet, S5). Las acciones
 * escriben por su cuenta (nunca «Guardar cambios»); todo veredicto queda a la
 * vista en español, y un fetch lanzado nunca deja un botón colgado.
 *
 * Mock al mismo seam que el resto de tests de settings: `fetch` global.
 */

// Mirrors the backend DEFAULTS: the settings page reads these paths directly,
// so a partial fixture makes the component throw rather than test anything.
const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: '****7890' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    qbit: { url: 'http://111.111.111.111:8080', user: 'chan', password: '****wxyz' },
    opensubtitles: { api_key: '' },
    amule: { url: 'http://192.168.1.10', ec_port: '4712', ec_password: '****abcd' },
  },
  security: { api_key: '', safe_mode: true },
  developer: false,
  paths: {
    download_amule: '/mnt/storage-6tb/shared-downloads/amule',
    download_torrent: '/mnt/storage/downloads/qbittorrent/completed',
    output_mixed: '/mnt/storage/mixed',
    allowed_roots: ['/mnt/storage', '/mnt/storage-6tb'],
  },
  intervals: { check: 15, max_retries: 3, retry_delay: 2, request_timeout: 5, import_timeout: 40 },
  tracing: { limit: 25 },
  retention: { amule_days: 7 },
  server: { port: 8000 },
}

type Reply = { status: number; body: unknown } | Error
type Route = () => Reply | Promise<Reply>

interface Call {
  method: string
  url: string
  body: Record<string, unknown> | null
}

function toResponse(reply: Reply): Promise<Response> {
  if (reply instanceof Error) return Promise.reject(reply)
  return Promise.resolve({
    ok: reply.status < 400,
    status: reply.status,
    json: async () => reply.body,
  } as Response)
}

/** Dispatch on `METHOD /path` (the configSubmenu mold); unknown routes answer
 *  `{}` — exactly what the other settings fixtures do. */
function mockFetch(routes: Record<string, Route>) {
  const calls: Call[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ method, url, body })
    const route = routes[`${method} ${url}`]
    const reply = route ? route() : { status: 200, body: {} }
    return reply instanceof Promise ? reply.then(toResponse) : toResponse(reply)
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

function renderActions() {
  return render(<AmuleServerActions />)
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

function listGets(calls: Call[]) {
  return calls.filter((c) => c.method === 'GET' && c.url === '/api/amule/servers')
}

function postTo(calls: Call[], path: string) {
  return calls.filter((c) => c.method === 'POST' && c.url === path)
}

const settingsRoutes: Record<string, Route> = {
  'GET /api/settings': () => ({ status: 200, body: settings }),
  'POST /api/settings': () => ({ status: 200, body: { ok: true, restart_required: [] } }),
  'GET /api/logs': () => ({ status: 200, body: { logs: [] } }),
  'GET /api/amule/health': () => ({
    status: 200,
    body: {
      state: 'sano',
      detail: 'Último canario OK',
      checked_at: 1761700000.0,
      consecutive_failures: 0,
      restart_attempts: 0,
      last_restart_at: null,
    },
  }),
  'GET /api/amule/servers': () => ({ status: 200, body: { ok: true, servers: [], detail: '' } }),
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('S1 — la tercera pestaña «aMule» del rail', () => {
  it('adds the rail tab with the aria id pairing and switches to the config panel', async () => {
    mockFetch(settingsRoutes)
    renderSettings()

    const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' })
    const tabs = within(nav).getByRole('tablist')
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3)

    const tab = within(tabs).getByRole('tab', { name: 'aMule' })
    expect(tab).toHaveAttribute('id', 'settings-tab-amule')
    expect(tab).toHaveAttribute('aria-controls', 'settings-panel-amule')
    expect(tab).toHaveAttribute('aria-selected', 'false')

    // Mountado pero oculto mientras no se conmuta (patrón de paneles).
    const panel = document.getElementById('settings-panel-amule') as HTMLElement
    expect(panel).toHaveAttribute('role', 'tabpanel')
    expect(panel).toHaveAttribute('aria-labelledby', 'settings-tab-amule')
    expect(panel).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(document.getElementById('settings-panel-general')).toHaveAttribute('aria-hidden', 'true')

    // La config mudada (mismos campos y valores) y el bloque de acciones.
    const host = within(panel).getByLabelText('Host / URL')
    expect(host).toBeVisible()
    expect(host).toHaveValue('http://192.168.1.10')
    expect(within(panel).getByLabelText('Puerto')).toHaveAttribute('placeholder', '4712')
    expect(within(panel).getByLabelText('Contraseña EC')).toHaveValue('****abcd')
    expect(within(panel).getByText(/aMule — conexión directa \(EC\)/)).toBeVisible()
    expect(within(panel).getByText('Control de aMule')).toBeVisible()
  })

  it('keeps the watchdog poll alive while the panel is still hidden', async () => {
    const { calls } = mockFetch(settingsRoutes)
    renderSettings()

    await screen.findByRole('tab', { name: 'aMule' })
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/amule/health')).toBe(true),
    )
  })
})

describe('listado de servidores (S5)', () => {
  it('renders name, address and the estado the payload supports per row', async () => {
    mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: {
          ok: true,
          servers: [
            { name: 'Servidor A', address: '1.2.3.4:4662', failed: true },
            { name: 'Servidor B', address: '5.6.7.8:4662' },
            { name: 'Servidor C', address: '9.9.9.9:4662', failed: false },
          ] satisfies AmuleServerRow[],
          detail: '',
        },
      }),
    })
    renderActions()

    await screen.findByText('Servidor A')
    expect(screen.getByText('1.2.3.4:4662')).toBeVisible()

    // `failed` truthy = con fallo; presente y falso = sin fallos; AUSENTE =
    // desconocido — jamás se inventa un estado que el payload no da.
    const rowA = screen.getByText('Servidor A').closest('.amule-actions-row') as HTMLElement
    expect(within(rowA).getByText('Con fallo')).toBeVisible()
    const rowB = screen.getByText('Servidor B').closest('.amule-actions-row') as HTMLElement
    expect(within(rowB).getByText('Desconocido')).toBeVisible()
    const rowC = screen.getByText('Servidor C').closest('.amule-actions-row') as HTMLElement
    expect(within(rowC).getByText('Sin fallos')).toBeVisible()

    expect(within(rowA).getByRole('button', { name: 'Conectar' })).toBeVisible()
    expect(within(rowA).getByRole('button', { name: 'Quitar' })).toBeVisible()
  })

  it('shows the honest empty state when the list is empty', async () => {
    mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers: [], detail: '' },
      }),
    })
    renderActions()

    expect(await screen.findByText('Sin servidores en la lista')).toBeVisible()
  })

  it('shows the detail when the list answers ok:false, claiming no empty list', async () => {
    mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: false, servers: [], detail: 'aMuled no responde por EC.' },
      }),
    })
    renderActions()

    expect(await screen.findByText('aMuled no responde por EC.')).toBeVisible()
    expect(screen.queryByText('Sin servidores en la lista')).toBeNull()
  })
})

describe('acciones de servidores (S5)', () => {
  it('add posts address + name and refreshes the list', async () => {
    let servers: AmuleServerRow[] = []
    const { calls } = mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers, detail: '' },
      }),
      'POST /api/amule/servers/add': () => {
        servers = [{ name: 'Nuevo', address: '10.0.0.1:4662' }]
        return { status: 200, body: { ok: true, detail: 'Servidor añadido a la lista.' } }
      },
    })
    renderActions()

    await screen.findByText('Sin servidores en la lista')
    fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: '10.0.0.1:4662' } })
    fireEvent.change(screen.getByLabelText('Nombre (opcional)'), { target: { value: 'Nuevo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir servidor' }))

    expect(await screen.findByText('Servidor añadido a la lista.')).toBeVisible()
    expect(postTo(calls, '/api/amule/servers/add')[0].body).toEqual({
      address: '10.0.0.1:4662',
      name: 'Nuevo',
    })
    // refreshed: the new row is listed now
    expect(await screen.findByText('Nuevo')).toBeVisible()
    expect(listGets(calls)).toHaveLength(2)
  })

  it('an empty Nombre is omitted from the body (the contract has name?)', async () => {
    const { calls } = mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers: [], detail: '' },
      }),
      'POST /api/amule/servers/add': () => ({
        status: 200,
        body: { ok: true, detail: 'Servidor añadido a la lista.' },
      }),
    })
    renderActions()

    await screen.findByText('Sin servidores en la lista')
    fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: '10.0.0.1:4662' } })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir servidor' }))

    await screen.findByText('Servidor añadido a la lista.')
    expect(postTo(calls, '/api/amule/servers/add')[0].body).toEqual({ address: '10.0.0.1:4662' })
  })

  it('connect posts the address and refreshes the list', async () => {
    let servers: AmuleServerRow[] = [{ name: 'Uno', address: '1.1.1.1:4662' }]
    const { calls } = mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers, detail: '' },
      }),
      'POST /api/amule/servers/connect': () => {
        servers = [{ name: 'Uno', address: '1.1.1.1:4662' }]
        return { status: 200, body: { ok: true, detail: 'Conectando al servidor Uno.' } }
      },
    })
    renderActions()

    const row = (await screen.findByText('Uno')).closest('.amule-actions-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Conectar' }))

    expect(await screen.findByText('Conectando al servidor Uno.')).toBeVisible()
    expect(postTo(calls, '/api/amule/servers/connect')[0].body).toEqual({ address: '1.1.1.1:4662' })
    expect(listGets(calls)).toHaveLength(2)
  })

  it('remove posts the address and refreshes the list', async () => {
    let servers: AmuleServerRow[] = [{ name: 'Uno', address: '1.1.1.1:4662' }]
    const { calls } = mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers, detail: '' },
      }),
      'POST /api/amule/servers/remove': () => {
        servers = []
        return { status: 200, body: { ok: true, detail: 'Servidor eliminado de la lista.' } }
      },
    })
    renderActions()

    const row = (await screen.findByText('Uno')).closest('.amule-actions-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Quitar' }))

    expect(await screen.findByText('Servidor eliminado de la lista.')).toBeVisible()
    expect(postTo(calls, '/api/amule/servers/remove')[0].body).toEqual({ address: '1.1.1.1:4662' })
    expect(listGets(calls)).toHaveLength(2)
    // refreshed: the row is gone and the empty state is honest again
    expect(await screen.findByText('Sin servidores en la lista')).toBeVisible()
    expect(screen.queryByText('Uno')).toBeNull()
  })

  it('an ok:false verdict renders its detail and skips the refresh', async () => {
    const { calls } = mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: {
          ok: true,
          servers: [{ name: 'Uno', address: '1.1.1.1:4662' }],
          detail: '',
        },
      }),
      'POST /api/amule/servers/connect': () => ({
        status: 200,
        body: { ok: false, detail: 'aMuled rechazó la conexión al servidor.' },
      }),
    })
    renderActions()

    const row = (await screen.findByText('Uno')).closest('.amule-actions-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Conectar' }))

    const verdict = await screen.findByRole('alert')
    expect(verdict).toHaveTextContent('aMuled rechazó la conexión al servidor.')
    expect(listGets(calls)).toHaveLength(1)
  })

  it('a 422 (missing field) surfaces the backend detail', async () => {
    mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers: [], detail: '' },
      }),
      'POST /api/amule/servers/add': () => ({
        status: 422,
        body: { detail: 'Falta la dirección del servidor.' },
      }),
    })
    renderActions()

    await screen.findByText('Sin servidores en la lista')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir servidor' }))

    const verdict = await screen.findByRole('alert')
    expect(verdict).toHaveTextContent('Falta la dirección del servidor.')
    expect(verdict).toBeVisible()
  })
})

describe('formulario de enlaces (S5)', () => {
  it('posts the link and shows the returned detail', async () => {
    const { calls } = mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers: [], detail: '' },
      }),
      'POST /api/amule/links': () => ({
        status: 200,
        body: { ok: true, detail: 'Enlace añadido a la cola de aMule.' },
      }),
    })
    renderActions()

    await screen.findByText('Sin servidores en la lista')
    fireEvent.change(screen.getByLabelText('Enlace ed2k o magnet'), {
      target: { value: 'ed2k://|file|peli.mkv|123|abc|/' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir a la cola' }))

    expect(await screen.findByText('Enlace añadido a la cola de aMule.')).toBeVisible()
    expect(postTo(calls, '/api/amule/links')[0].body).toEqual({
      link: 'ed2k://|file|peli.mkv|123|abc|/',
    })
  })

  it('shows the backend rejection (ok:false) honestly', async () => {
    mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers: [], detail: '' },
      }),
      'POST /api/amule/links': () => ({
        status: 200,
        body: { ok: false, detail: 'El esquema del enlace no es ni ed2k ni magnet.' },
      }),
    })
    renderActions()

    await screen.findByText('Sin servidores en la lista')
    fireEvent.change(screen.getByLabelText('Enlace ed2k o magnet'), {
      target: { value: 'https://ejemplo.com/falso' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir a la cola' }))

    const verdict = await screen.findByRole('alert')
    expect(verdict).toHaveTextContent('El esquema del enlace no es ni ed2k ni magnet.')
  })
})

describe('estados honestos (S5)', () => {
  it('a thrown fetch leaves an honest failure message and frees the buttons', async () => {
    mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers: [], detail: '' },
      }),
      'POST /api/amule/servers/add': () => new Error('network down'),
    })
    renderActions()

    await screen.findByText('Sin servidores en la lista')
    const button = screen.getByRole('button', { name: 'Añadir servidor' })
    fireEvent.click(button)

    expect(await screen.findByText('No se pudo probar la conexión con el backend.')).toBeVisible()
    await waitFor(() => expect(button).toBeEnabled())
  })

  it('a thrown list fetch is reported, not shown as an empty list', async () => {
    mockFetch({
      'GET /api/amule/servers': () => new Error('network down'),
    })
    renderActions()

    expect(await screen.findByText('No se pudo probar la conexión con el backend.')).toBeVisible()
    expect(screen.queryByText('Sin servidores en la lista')).toBeNull()
  })

  it('buttons are disabled while a request is in flight', async () => {
    let resolveAdd!: (reply: Reply) => void
    const addPending = new Promise<Reply>((r) => {
      resolveAdd = r
    })
    const { calls } = mockFetch({
      'GET /api/amule/servers': () => ({
        status: 200,
        body: { ok: true, servers: [], detail: '' },
      }),
      'POST /api/amule/servers/add': () => addPending,
    })
    renderActions()

    await screen.findByText('Sin servidores en la lista')
    fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: '10.0.0.1:4662' } })
    const add = screen.getByRole('button', { name: 'Añadir servidor' })
    const link = screen.getByRole('button', { name: 'Añadir a la cola' })
    fireEvent.click(add)
    fireEvent.click(add)

    await waitFor(() => expect(add).toBeDisabled())
    expect(link).toBeDisabled()

    resolveAdd({ status: 200, body: { ok: true, detail: 'Servidor añadido a la lista.' } })
    expect(await screen.findByText('Servidor añadido a la lista.')).toBeVisible()
    await waitFor(() => expect(add).toBeEnabled())
    expect(postTo(calls, '/api/amule/servers/add')).toHaveLength(1)
  })
})

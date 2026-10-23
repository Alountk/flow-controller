import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'

/**
 * Configuración con submenú (config-submenu T3/S1-S2): la página deja de ser
 * una pila única y pasa a doble raíl — «General» (por defecto) e «Indexadores»
 * — con la tarjeta «aMule — conexión directa (EC)» en General. El diseño fuente
 * es `odd/tasks/config-submenu/stitch-12-general.html` (Engram 1453: HTML, no
 * screenshots).
 *
 * Cero pérdidas: los tests de Settings existentes no se tocan; aquí sólo se
 * fija el comportamiento nuevo del submenú, de la tarjeta EC y de su sonda.
 */

const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    opensubtitles: { api_key: '' },
    // GET /api/settings devuelve la contraseña EC SIEMPRE enmascarada (S2).
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

type RouteHandler = (body: Record<string, unknown> | null) => unknown

/** Dispatch on `METHOD /path` the way the page calls the API (as #222 does). */
function mockFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`
    const handler = routes[key]
    const respond = (answer: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => answer } as Response)
    if (!handler) return respond({})
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const answer = handler(body)
    if (answer instanceof Error) return Promise.reject(answer)
    if (answer instanceof Promise) return answer.then(respond)
    return respond(answer)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const baseRoutes: Record<string, RouteHandler> = {
  'GET /api/settings': () => settings,
  'POST /api/settings': () => ({ ok: true, restart_required: [] }),
  'GET /api/logs': () => ({ logs: [] }),
  'GET /api/services/test': () => ({ results: [], ok: true }),
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

/** The distinctive aMule (EC) card — scoped queries avoid the page's
 *  pre-existing "Puerto" label (Servidor). */
async function amuleCard(): Promise<HTMLElement> {
  const title = await screen.findByText(/aMule — conexión directa \(EC\)/)
  return title.closest('.settings-section') as HTMLElement
}

describe('config sub-menú — doble raíl General | Indexadores (S1)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('renders the sub-nav with both items, General active by default', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' })
    within(nav).getByRole('button', { name: 'General' })
    within(nav).getByRole('button', { name: 'Indexadores' })

    // Default: General is the visible panel, Indexadores is mounted but hidden.
    await screen.findByText('Servicios')
    expect(screen.getByText('Servicios')).toBeVisible()
    const indexadores = await screen.findByText(/No hay indexadores/)
    expect(indexadores).not.toBeVisible()
  })

  it('General keeps every existing section and adds the aMule (EC) card', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    for (const title of [
      'Servicios',
      'Estado de las conexiones',
      'Seguridad',
      'Rutas',
      'Intervalos',
      'Seguimiento',
      'Servidor',
      'Logs del Sistema',
    ]) {
      expect(await screen.findByText(title)).toBeVisible()
    }

    const card = await amuleCard()
    // Los tres campos de la tarjeta, según stitch-12-general.html.
    const host = within(card).getByLabelText('Host / URL')
    expect(host).toHaveValue('http://192.168.1.10')
    const port = within(card).getByLabelText('Puerto')
    expect(port).toHaveAttribute('placeholder', '4712')
    const password = within(card).getByLabelText('Contraseña EC')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveValue('****abcd')

    // La nota literal del diseño.
    expect(
      within(card).getByText(
        /Es la conexión al daemon aMule por el protocolo EC \(eD2k\/Kad\)\./,
      ),
    ).toBeInTheDocument()
    expect(
      within(card).getByText(
        /No es un indexador Torznab: los indexadores se configuran en la pestaña Indexadores\./,
      ),
    ).toBeInTheDocument()
  })

  it('switching to Indexadores shows IndexadoresSection and hides General', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const indexadores = await screen.findByText(/No hay indexadores/)
    expect(indexadores).not.toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Indexadores' }))
    expect(indexadores).toBeVisible()
    expect(screen.getByText('Servicios')).not.toBeVisible()
    expect(screen.getByRole('heading', { name: 'Indexadores' })).toBeVisible()

    // And back: General returns, Indexadores hides again.
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    expect(screen.getByText('Servicios')).toBeVisible()
    expect(indexadores).not.toBeVisible()
  })
})

describe('aMule (EC) card — «Probar conexión EC» (S2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('shows a successful probe as an ok toast with the returned detail', async () => {
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => ({ ok: true, detail: 'aMule 2.3.3 (EC0x0307)' }),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'aMule 2.3.3 (EC0x0307)', tone: 'ok' }),
      ),
    )
  })

  it('shows a refused probe as an error toast with the returned detail', async () => {
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => ({
        ok: false,
        detail: 'AmuleAuthError: contraseña EC rechazada',
      }),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({
          message: 'AmuleAuthError: contraseña EC rechazada',
          tone: 'error',
        }),
      ),
    )
  })

  it('reports a transport failure as an error toast, not silence', async () => {
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => new Error('network down'),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts().some((t) => t.tone === 'error')).toBe(true),
    )
  })

  it('does not double-fire while a probe is pending', async () => {
    let resolveProbe!: (value: unknown) => void
    const pending = new Promise((r) => {
      resolveProbe = r
    })
    const fn = mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => pending,
    })
    renderSettings()

    const button = await screen.findByRole('button', { name: 'Probar conexión EC' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(
      fn.mock.calls.filter(([input]) => String(input).includes('/api/amule/test')),
    ).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Probando…' })).toBeVisible()

    resolveProbe({ ok: true, detail: 'conectado' })
    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    expect(
      screen.getByRole('button', { name: 'Probar conexión EC' }),
    ).toBeVisible()
  })

  it('flows the EC fields into the saved payload through update()', async () => {
    let saved: Record<string, unknown> | null = null
    mockFetch({
      ...baseRoutes,
      'POST /api/settings': (body) => {
        saved = body
        return { ok: true, restart_required: [] }
      },
    })
    renderSettings()

    const card = await amuleCard()
    fireEvent.change(within(card).getByLabelText('Host / URL'), {
      target: { value: 'http://10.0.0.5' },
    })
    fireEvent.change(within(card).getByLabelText('Puerto'), {
      target: { value: '4713' },
    })
    // Borrar la contraseña deja la cadena vacía: la semántica «vacío/máscara
    // = conservar la guardada» la aplica el backend (S2), aquí se comprueba
    // que el frontend no inventa ni retiene valores.
    fireEvent.change(within(card).getByLabelText('Contraseña EC'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Guardar configuración/ }))

    await waitFor(() => expect(saved).not.toBeNull())
    expect((saved as unknown as { services: { amule: unknown } }).services.amule).toEqual({
      url: 'http://10.0.0.5',
      ec_port: '4713',
      ec_password: '',
    })
  })

  it('posts the masked EC password back untouched when the field is left alone', async () => {
    let saved: Record<string, unknown> | null = null
    mockFetch({
      ...baseRoutes,
      'POST /api/settings': (body) => {
        saved = body
        return { ok: true, restart_required: [] }
      },
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: /Guardar configuración/ }))

    await waitFor(() => expect(saved).not.toBeNull())
    expect(
      (saved as unknown as { services: { amule: { ec_password: string } } }).services.amule
        .ec_password,
    ).toBe('****abcd')
  })
})

describe('«Probar conexión EC» — sonda de lo ESCRITO (config-1x1 S1/T2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('probes the values just typed in the card, not the stored ones', async () => {
    let sent: unknown = 'sin llamada'
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': (body) => {
        sent = body
        return { ok: true, detail: 'conectado' }
      },
    })
    renderSettings()

    const card = await amuleCard()
    fireEvent.change(within(card).getByLabelText('Host / URL'), {
      target: { value: 'http://10.0.0.5' },
    })
    fireEvent.change(within(card).getByLabelText('Puerto'), {
      target: { value: '4713' },
    })
    fireEvent.change(within(card).getByLabelText('Contraseña EC'), {
      target: { value: 'clave-nueva-1' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    expect(sent).toEqual({
      url: 'http://10.0.0.5',
      ec_port: '4713',
      ec_password: 'clave-nueva-1',
    })
  })

  it('never sends the masked password as a candidate: omitted, stored wins', async () => {
    let sent: unknown = 'sin llamada'
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': (body) => {
        sent = body
        return { ok: true, detail: 'conectado' }
      },
    })
    renderSettings()

    // Sin tocar el form: la contraseña del campo es la máscara que devolvió GET.
    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    expect(sent).toEqual({ url: 'http://192.168.1.10', ec_port: '4712' })
    expect(sent).not.toHaveProperty('ec_password')
  })

  it('omits empty fields entirely so the probe falls back to the stored config', async () => {
    let sent: unknown = 'sin llamada'
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': (body) => {
        sent = body
        return { ok: true, detail: 'conectado' }
      },
    })
    renderSettings()

    const card = await amuleCard()
    fireEvent.change(within(card).getByLabelText('Host / URL'), { target: { value: '' } })
    fireEvent.change(within(card).getByLabelText('Puerto'), { target: { value: '' } })
    fireEvent.change(within(card).getByLabelText('Contraseña EC'), { target: { value: '' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    // Nada escrito → SIN body: la sonda usa la config guardada, como siempre.
    expect(sent).toBeNull()
  })
})

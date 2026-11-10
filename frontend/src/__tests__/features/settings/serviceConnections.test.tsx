import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import type { ServiceTestResult } from '../../../shared/api/services.ts'

/**
 * The connection tester exists mainly for the proxy migration: when the
 * services move off localhost, it must show WHICH URL was attempted and WHY it
 * failed. A rejected key reported as success would defeat the purpose.
 */

const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    amuleapi: { url: 'http://localhost:4713', password: 'clave-amule' },
    qbit: { url: 'http://localhost:8080', user: 'admin', password: 'p' },
    opensubtitles: { api_key: '' },
  },
  security: { api_key: '', safe_mode: true },
  developer: false,
  // Mirrors the backend DEFAULTS: the settings page reads these directly, so a
  // partial fixture makes the component throw rather than test anything.
  paths: {
    download_amule: '/mnt/storage-6tb/shared-downloads/amule',
    download_torrent: '/mnt/storage/downloads/qbittorrent/completed',
    output_mixed: '/mnt/storage/mixed',
    allowed_roots: ['/mnt/storage', '/mnt/storage-6tb'],
  },
  intervals: { check: 15, max_retries: 3, retry_delay: 2, request_timeout: 5, import_timeout: 40, sweep: 600 },
  tracing: { limit: 25 },
  // Backend DEFAULTS again: the retention window the settings page reads
  // directly (`backend/settings.py`: retention.amule_days = 7).
  retention: { amule_days: 7 },
  server: { port: 8000 },
}

function result(overrides: Partial<ServiceTestResult> = {}): ServiceTestResult {
  return {
    key: 'radarr',
    kind: 'arr',
    url: 'http://localhost:7878',
    ok: true,
    version: '6.4.4',
    detail: 'Conectado (6.4.4)',
    ...overrides,
  }
}

function mockFetch(results: ServiceTestResult[] | 'error') {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void init
    const url = String(input)
    if (url.includes('/api/services/test')) {
      if (results === 'error') return Promise.resolve({ ok: false, status: 500 } as Response)
      return Promise.resolve({
        ok: true,
        json: async () => ({ results, ok: results.every((r) => r.ok) }),
      } as Response)
    }
    if (url.includes('/api/services')) {
      // T4/S4: la tabla se siembra desde /api/services (que no sondea) y el
      // sondeo sólo rellena sus filas. Derivar la lista del fixture mantiene
      // el escenario —«estos servicios existen»— sin inventar otros.
      const services = (results === 'error' ? [] : results).map((r) => ({
        key: r.key,
        kind: r.kind,
        url: r.url,
        configured: true,
      }))
      return Promise.resolve({
        ok: true,
        json: async () => ({ services, configured: services.map((s) => s.key) }),
      } as Response)
    }
    if (url.includes('/api/settings')) {
      return Promise.resolve({ ok: true, json: async () => settings } as Response)
    }
    if (url.includes('/api/logs')) {
      // LogsSection reads `.logs` and renders it; a bare {} would crash it.
      return Promise.resolve({ ok: true, json: async () => ({ logs: [] }) } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
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

const clickTest = async () => {
  const button = await screen.findByRole('button', { name: /Probar conexiones/ })
  fireEvent.click(button)
}

describe('service connection tester', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers a button on the settings page', async () => {
    mockFetch([result()])
    renderSettings()

    expect(await screen.findByRole('button', { name: /Probar conexiones/ })).toBeInTheDocument()
  })

  it('lists every service with its result', async () => {
    mockFetch([
      result(),
      result({ key: 'sonarr', url: 'http://localhost:8989', detail: 'Conectado (4.0.20)' }),
      result({ key: 'amutorrent', kind: 'qbit', url: 'http://localhost:4000', detail: 'Conectado (v5.1.4)' }),
    ])
    renderSettings()
    await clickTest()

    // ADAPTADO (T4/S2, sin aflojar): la sección es ahora la tabla del diseño, y
    // las filas se siembran con /api/services; los tres servicios siguen
    // apareciendo, cada uno con su estado.
    const table = await screen.findByRole('table')
    await waitFor(() => expect(within(table).getByText('Radarr')).toBeInTheDocument())
    expect(within(table).getByText('Sonarr')).toBeInTheDocument()
    expect(within(table).getByText('aMuTorrent')).toBeInTheDocument()
    expect(within(table).getAllByText('Conectado')).toHaveLength(3)
  })

  it('shows the qbit row when the backend returns it', async () => {
    // qbit-nativo T3/S3: the section iterates the API list dynamically, so the
    // new service must surface with its key and attempted URL like the rest.
    mockFetch([
      result({
        key: 'qbit',
        kind: 'qbittorrent',
        url: 'http://111.111.111.111:8080',
        detail: 'Conectado (v5.1.4)',
      }),
    ])
    renderSettings()
    await clickTest()

    const table = await screen.findByRole('table')
    await waitFor(() => expect(within(table).getByText('qBittorrent')).toBeInTheDocument())
    expect(within(table).getByText('http://111.111.111.111:8080')).toBeInTheDocument()
  })

  it('shows the URL that was attempted', async () => {
    // The whole point during a proxy migration: which host did we actually hit?
    // La fila muestra la URL del SONDEO, no la guardada, justo por esto.
    mockFetch([result({ url: 'http://192.168.1.50:7878' })])
    renderSettings()
    await clickTest()

    const table = await screen.findByRole('table')
    await waitFor(() => expect(within(table).getByText('http://192.168.1.50:7878')).toBeInTheDocument())
  })

  it('surfaces a rejected key as a failure, not a success', async () => {
    mockFetch([
      result({
        ok: false,
        detail: 'radarr: API key rechazada (HTTP 401)',
        error_kind: 'auth',
      }),
    ])
    renderSettings()
    await clickTest()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('API key rechazada')
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Alerta')).toBeInTheDocument()
  })

  it('surfaces an unreachable service with its reason', async () => {
    mockFetch([
      result({
        ok: false,
        detail: 'sonarr: no se pudo conectar (ClientError)',
        error_kind: 'unreachable',
      }),
    ])
    renderSettings()
    await clickTest()

    await waitFor(() =>
      expect(screen.getByText(/no se pudo conectar/)).toBeInTheDocument(),
    )
  })

  it('reports a backend failure without pretending it succeeded', async () => {
    mockFetch('error')
    renderSettings()
    await clickTest()

    await waitFor(() =>
      expect(screen.getByText(/No se pudo completar la comprobación/)).toBeInTheDocument(),
    )
  })

  it('probes amuleapi with its url and password', async () => {
    // amule-32 T2: the aMule API card probes the official REST daemon of
    // aMule 3.x, anonymous version check — password travels with the URL.
    const fn = mockFetch([
      result({ key: 'amuleapi', kind: 'amuleapi', url: 'http://localhost:4713', detail: 'Conectado (3.2.0)' }),
    ])
    renderSettings()
    // T10 (elección del usuario): la card vive en la pestaña aMule, junto a EC.
    fireEvent.click(await screen.findByRole('tab', { name: 'aMule' }))

    const card = (await screen.findByRole('heading', { name: 'aMule API' })).closest(
      '.amule-ec-card',
    ) as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Probar conexión' }))

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/services/test') && init?.method === 'POST',
      )
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post![1]?.body))).toEqual({
        service: 'amuleapi',
        url: 'http://localhost:4713',
        password: 'clave-amule',
      })
    })
  })

  it('the aMuTorrent card carries the rollback hint and the aMule API card is unaffected', async () => {
    // amule-32 T5/S2: la tarjeta aMuTorrent es sólo el rollback — la pista lo
    // dice bajo el <h4>, y la tarjeta aMule API (T2) sigue intacta.
    mockFetch([])
    renderSettings()

    const card = (await screen.findByRole('heading', { name: 'aMuTorrent' })).closest(
      '.settings-group',
    ) as HTMLElement
    expect(within(card).getByText(/Ruta de rollback/)).toHaveTextContent('AMULE_EC_DIRECT=0')

    // T10: cambio de pestaña — la API es del dominio aMule, no de Servicios.
    fireEvent.click(await screen.findByRole('tab', { name: 'aMule' }))
    const apiCard = (await screen.findByRole('heading', { name: 'aMule API' })).closest(
      '.amule-ec-card',
    ) as HTMLElement
    expect(within(apiCard).getByRole('button', { name: 'Probar conexión' })).toBeInTheDocument()
  })

  it('lives in the aMule tab next to the EC config, not in Servicios (user pick)', async () => {
    // Design decision: same form, same domain — the aMule API card sits with
    // the EC config; Servicios keeps the arr endpoints.
    mockFetch([])
    renderSettings()

    // After load, on the default General panel: the card must NOT be there.
    await screen.findByRole('heading', { name: 'Servicios' })
    expect(screen.queryByRole('heading', { name: 'aMule API' })).toBeNull()

    fireEvent.click(await screen.findByRole('tab', { name: 'aMule' }))
    expect(await screen.findByRole('heading', { name: 'aMule API' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'aMule — conexión directa (EC)' }),
    ).toBeInTheDocument()
  })

  it('marks each healthy service so a mixed result is readable', async () => {
    mockFetch([
      result({ key: 'radarr', ok: true }),
      result({ key: 'sonarr', ok: false, detail: 'sonarr: no respondió a tiempo', error_kind: 'timeout' }),
    ])
    renderSettings()
    await clickTest()

    // ADAPTADO (T4/S2, sin aflojar): las marcas viven ahora en la píldora de
    // estado de cada fila (antes, una tarjeta `.service-test` por servicio).
    await waitFor(() => expect(document.querySelectorAll('.connections-pill')).toHaveLength(2))
    const pills = [...document.querySelectorAll('.connections-pill')]
    expect(pills.filter((p) => p.classList.contains('ok'))).toHaveLength(1)
    expect(pills.filter((p) => p.classList.contains('fail'))).toHaveLength(1)
    expect(pills[1] as HTMLElement).toHaveTextContent('Alerta')
    expect(screen.getByText(/no respondió a tiempo/)).toBeInTheDocument()
  })
})

describe('aMule retention window', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the window as a plain number without a restart badge and saves it under retention', async () => {
    const fn = mockFetch([])
    renderSettings()

    // The backend default of 7 days, straight from the settings payload.
    const field = await screen.findByLabelText('Días antes de poder borrar una descarga')
    expect(field).toHaveValue(7)

    // config.rebuild() reads this live, so unlike server.port it must NOT
    // carry the "Requiere reinicio" badge.
    expect(
      (field.closest('.settings-field') as HTMLElement).querySelector('.settings-restart-badge'),
    ).toBeNull()

    // Changing the window has to reach the backend as retention.amule_days —
    // the group the endpoint reads (config: RETENTION_AMULE_DAYS).
    fireEvent.change(field, { target: { value: '14' } })
    // ADAPTADO (config-1x1 T3/S3, sin aflojar): el mismo guardado se llama
    // ahora «Guardar cambios» y vive en la cabecera del panel (antes
    // «Guardar configuración», abajo). Sólo cambia el literal por el del
    // diseño; la aserción sobre el payload es idéntica.
    // ADAPTADO (config-1x1 T6/S4, sin aflojar): la tarjeta aMule añade un
    // segundo «Guardar cambios» (enmienda S4) y la búsqueda sin acotar
    // colisiona; se acota a la CABECERA del panel — mismo botón, misma aserción.
    const header = screen
      .getByRole('heading', { name: 'General', level: 2 })
      .closest('.settings-panel-header') as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: /Guardar cambios/ }))

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/settings') && init?.method === 'POST',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(String(post![1]?.body)) as {
        retention?: { amule_days?: number }
      }
      expect(body.retention).toEqual({ amule_days: 14 })
    })
  })
})

describe('barrido automático — el mando del intervalo (S4/T7b)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the knob as a plain number without a restart badge and saves it under intervals.sweep', async () => {
    const fn = mockFetch([])
    renderSettings()

    // The backend default of 600 s, straight from the settings payload. The
    // label carries the units and the 0 = off semantics like its neighbours.
    const field = await screen.findByLabelText('Barrido automático (segundos; 0 = apagado)')
    expect(field).toHaveValue(600)

    // The tick re-reads the knob at call time (T7a), so a save applies live:
    // no "Requiere reinicio" badge.
    expect(
      (field.closest('.settings-field') as HTMLElement).querySelector('.settings-restart-badge'),
    ).toBeNull()

    // 0 is the off switch — it must reach the backend as intervals.sweep, the
    // group the scheduler reads (config: SWEEP_INTERVAL).
    fireEvent.change(field, { target: { value: '0' } })
    const header = screen
      .getByRole('heading', { name: 'General', level: 2 })
      .closest('.settings-panel-header') as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: /Guardar cambios/ }))

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/settings') && init?.method === 'POST',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(String(post![1]?.body)) as {
        intervals?: { sweep?: number }
      }
      expect(body.intervals?.sweep).toBe(0)
    })
  })
})

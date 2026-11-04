import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'

/**
 * T5 del rediseño de General (`odd/tasks/config-general-rediseno.md`, S2/S4):
 * el diseño abre por «Estado de las conexiones» y cada tarjeta lleva cabecera
 * con icono, título y subtítulo explicativo separada por borde inferior.
 *
 * El orden no es cosmético: la tabla de conexiones es lo primero que alguien
 * viene a mirar cuando algo no responde, y hoy está detrás de cinco tarjetas
 * de credenciales. Lo que el diseño no trae (Calidad de biblioteca, Logs,
 * Carpetas compartidas) se conserva (S4) en la posición ya acordada.
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

function mockFetch() {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const respond = (answer: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => answer } as Response)
    if (url.includes('/api/settings')) return respond(settings)
    if (url.includes('/api/logs')) return respond({ logs: [] })
    if (url.includes('/api/services')) return respond({ services: [], configured: [] })
    if (url.includes('/api/indexers')) return respond({ indexers: [] })
    // La tarjeta de carpetas compartidas vive de su propia query; sin
    // respuesta se queda en «Cargando…» y no llega a pintar su cabecera.
    if (url.includes('/api/amule/shared-dirs')) {
      return respond({ recursive: [], explicit: [], candidates: [] })
    }
    return respond({})
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

async function sectionTitles(): Promise<string[]> {
  await screen.findByRole('heading', { name: 'General', level: 2 })
  // Las tarjetas que cargan por su cuenta (carpetas compartidas) tienen que
  // resolver antes de leer la lista, o el orden sale incompleto.
  await screen.findByText('Carpetas compartidas de aMule')
  return [...document.querySelectorAll('#settings-panel-general .settings-section-title')].map(
    (el) => (el.textContent ?? '').trim(),
  )
}

describe('cabeceras y orden de las tarjetas de General (T5/S2, S4)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens with the connection table and keeps what the design lacks', async () => {
    mockFetch()
    renderSettings()

    expect(await sectionTitles()).toEqual([
      // El diseño abre aquí: es lo que se mira cuando algo no responde.
      'Estado de las conexiones',
      'Servicios',
      'Seguridad',
      'Rutas',
      // S4: fuera del diseño, conservadas en el orden acordado.
      'Carpetas compartidas de aMule',
      'Intervalos',
      'Calidad de biblioteca',
      'Seguimiento',
      // C-01: lo que se sigue y, justo después, cómo te enteras.
      'Avisos',
      'Servidor',
      'Logs del Sistema',
    ])
  })

  it('gives every card a header with icon, title and the design subtitle', async () => {
    mockFetch()
    renderSettings()
    await sectionTitles()

    const sections = [...document.querySelectorAll('#settings-panel-general .settings-section')]
    expect(sections.length).toBeGreaterThan(8)
    for (const section of sections) {
      const icon = section.querySelector('.settings-section-icon')
      const title = section.querySelector('.settings-section-title')
      const subtitle = section.querySelector('.settings-section-subtitle')
      expect(icon, `sin icono: ${title?.textContent ?? '?'}`).not.toBeNull()
      // Decorativo: el título ya dice qué es; el lector de pantalla no debe
      // oír «🔄».
      expect(icon?.getAttribute('aria-hidden')).toBe('true')
      expect(subtitle, `sin subtítulo: ${title?.textContent ?? '?'}`).not.toBeNull()
      expect((subtitle?.textContent ?? '').trim().length).toBeGreaterThan(10)
    }
  })

  it('copies the design subtitles verbatim', async () => {
    mockFetch()
    renderSettings()
    await sectionTitles()

    const subtitleOf = (title: string) => {
      const heading = [...document.querySelectorAll('#settings-panel-general .settings-section-title')]
        .find((el) => (el.textContent ?? '').trim() === title)
      return heading?.parentElement?.parentElement?.querySelector('.settings-section-subtitle')?.textContent?.trim()
    }

    expect(subtitleOf('Servicios')).toBe('Endpoints y tokens de autenticación para la orquestación arr.')
    expect(subtitleOf('Seguridad')).toBe('Autenticación del propio panel FlowController y políticas de integridad.')
    expect(subtitleOf('Rutas')).toBe('Mapeo de almacenamiento en disco, librerías y puntos de montaje ZFS/RAID.')
    expect(subtitleOf('Intervalos')).toBe('Temporizadores de sondeo, reintentos de red y límites de procesamiento.')
    expect(subtitleOf('Seguimiento')).toBe('Políticas de retención y limpieza automatizada.')
    expect(subtitleOf('Avisos')).toBe('Cuándo avisar y por dónde: el canal ntfy que recibe los mensajes.')
    expect(subtitleOf('Servidor')).toBe('Control del daemon HTTP central de FlowController.')
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'

/**
 * Masking the secret fields (stitch-delta T4): every API key on the Ajustes
 * page renders as `type="password"` — Setup already masks the same kind of
 * field, and a key sitting in plain text on screen is a shoulder-surf leak.
 * Non-secret fields (URLs, the username) keep their readable type: masking
 * them would hide what the user is reviewing, not protect anything.
 */

// Mirrors the backend DEFAULTS: the settings page reads these paths directly,
// so a partial fixture makes the component throw rather than test anything.
const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'radarr-key' },
    sonarr: { url: 'http://localhost:8989', api_key: 'sonarr-key' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'amule-key', user: 'admin', password: 'p' },
    qbit: { url: 'http://localhost:8080', user: 'admin', password: 'p' },
    opensubtitles: { api_key: 'os-key' },
  },
  security: { api_key: 'own-key', safe_mode: true },
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

function mockFetch() {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void init
    const url = String(input)
    if (url.includes('/api/settings')) {
      return Promise.resolve({ ok: true, json: async () => settings } as Response)
    }
    if (url.includes('/api/logs')) {
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

describe('settings API key masking', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders every service API key and the app key as password inputs', async () => {
    mockFetch()
    renderSettings()

    // The four services that HAVE a key share the label "API Key" (qBittorrent
    // logs in with user/password and adds none); the app's own key is
    // "API Key propia". All five must be masked.
    // ADAPTADO (config-1x1 T4, sin aflojar): el formulario «Nuevo indexador»
    // del panel Indexadores usa ahora los literales cortos del diseño
    // («URL»/«API Key») y el panel oculto sigue montado en jsdom — la query se
    // ACOTA al panel «General» (contenedor de los cuatro servicios). Mismo
    // conteo (4), misma aserción por campo.
    const general = await screen.findByRole('tabpanel', { name: 'General' })
    const serviceKeys = await within(general).findAllByLabelText('API Key')
    expect(serviceKeys).toHaveLength(4)
    for (const key of serviceKeys) {
      expect(key).toHaveAttribute('type', 'password')
    }
    expect(screen.getByLabelText('API Key propia')).toHaveAttribute('type', 'password')
  })

  it('keeps the non-secret fields readable', async () => {
    mockFetch()
    renderSettings()

    // ADAPTADO (config-1x1 T4, sin aflojar): escopado al panel «General» por
    // la misma colisión de literales cortos («URL» en el formulario de
    // Indexadores; panel oculto montado en jsdom).
    // ADAPTADO (qbit-nativo T3/S3, sin aflojar): la tarjeta qBittorrent añade
    // una cuarta «URL» (3 → 4); misma aserción por campo, conteo actualizado.
    const general = await screen.findByRole('tabpanel', { name: 'General' })
    const urls = await within(general).findAllByLabelText('URL')
    expect(urls).toHaveLength(4)
    for (const url of urls) {
      expect(url).toHaveAttribute('type', 'text')
    }
    // ADAPTADO (qbit-nativo T3/S3, sin aflojar): qBittorrent también usa
    // «Usuario» (1 → 2); misma aserción por campo, conteo actualizado.
    const users = screen.getAllByLabelText('Usuario')
    expect(users).toHaveLength(2)
    for (const user of users) {
      expect(user).toHaveAttribute('type', 'text')
    }
  })

  it('links the auto-refresh toggle through label for/id/name (labels-wrap S2)', async () => {
    mockFetch()
    renderSettings()

    const general = await screen.findByRole('tabpanel', { name: 'General' })
    const toggle = general.querySelector('#settings-auto-refresh') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.name).toBe('settings-auto-refresh')
    const label = toggle.closest('label')
    expect(label).not.toBeNull()
    expect(label!.getAttribute('for')).toBe('settings-auto-refresh')
  })
})

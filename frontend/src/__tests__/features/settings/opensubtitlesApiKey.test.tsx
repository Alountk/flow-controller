import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'

/**
 * Clave de OpenSubtitles (mixer-redesign T6 / S6): el mockup la manda a
 * Configuración → Servicios y el mixer la usa para buscar los `.srt` que no
 * se pudieron extraer. El campo va enmascarado (es una credencial) y escribe
 * a través de `update(...)` como sus vecinos: lo que se guarda es
 * `services.opensubtitles.api_key`.
 */

// Mirrors the backend DEFAULTS: the settings page reads these paths directly,
// so a partial fixture makes the component throw rather than test anything.
const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    opensubtitles: { api_key: 'os-key-123' },
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

function mockFetch() {
  const saved: unknown[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/settings')) {
      if ((init?.method ?? 'GET') === 'POST') {
        saved.push(JSON.parse(String(init?.body)))
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, restart_required: [] }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => settings } as Response)
    }
    if (url.includes('/api/logs')) {
      return Promise.resolve({ ok: true, json: async () => ({ logs: [] }) } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return saved
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

describe('OpenSubtitles API key in settings', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the stored key bound to services.opensubtitles.api_key, masked', async () => {
    mockFetch()
    renderSettings()

    const field = await screen.findByPlaceholderText('Clave API de OpenSubtitles')
    expect(field).toHaveValue('os-key-123')
    expect(field).toHaveAttribute('type', 'password')
  })

  it('writes through update() into the saved payload', async () => {
    const saved = mockFetch()
    renderSettings()

    const field = await screen.findByPlaceholderText('Clave API de OpenSubtitles')
    fireEvent.change(field, { target: { value: 'nueva-clave' } })
    // ADAPTADO (config-1x1 T3/S3, sin aflojar): el mismo guardado se llama
    // ahora «Guardar cambios» y vive en la cabecera del panel (antes
    // «Guardar configuración», abajo). Sólo cambia el literal por el del
    // diseño; la aserción sobre el payload es idéntica.
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect((saved[0] as typeof settings).services.opensubtitles.api_key).toBe('nueva-clave')
    // And the changed field stays bound to the form state, not the fixture.
    expect(field).toHaveValue('nueva-clave')
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'

/**
 * «Probar conexión» en cada tarjeta de Servicios (usuario, post-qbit-nativo):
 * la descarga se intentó con `http://…:8088/` escrito en la tarjeta y volvió
 * «HTTP 404» — el botón existe para que ese MISMO veredicto esté a un clic SIN
 * disparar una descarga. Sondea LO QUE EL FORM CONTIENE AHORA (patrón
 * candidato de `POST /api/services/test`): los campos vacíos o enmascarados
 * (`****…`, lo que GET devuelve para un secreto guardado) se omiten para que
 * mande el valor guardado.
 */

// Mirrors the backend DEFAULTS: the settings page reads these paths directly,
// so a partial fixture makes the component throw rather than test anything.
const settings = {
  services: {
    // api_key arrives MASKED from GET — the card must never probe with it.
    radarr: { url: 'http://localhost:7878', api_key: '****7890' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    qbit: { url: 'http://111.111.111.111:8080', user: 'chan', password: '****wxyz' },
    opensubtitles: { api_key: '' },
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

/** Every `POST /api/services/test` body the buttons send, in order. */
function mockFetch() {
  const probed: Array<Record<string, unknown>> = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/settings')) {
      if ((init?.method ?? 'GET') === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, restart_required: [] }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => settings } as Response)
    }
    if (url.includes('/api/services/test') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      probed.push(body)
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [
            {
              key: body.service,
              kind: body.service === 'qbit' ? 'qbittorrent' : 'arr',
              url: body.url ?? '',
              ok: false,
              detail: 'qBittorrent (http://111.111.111.111:8088/) no aceptó la descarga: HTTP 404: Not Found',
            },
          ],
          ok: false,
        }),
      } as Response)
    }
    if (url.includes('/api/logs')) {
      return Promise.resolve({ ok: true, json: async () => ({ logs: [] }) } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return probed
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

/** The card of the given service heading inside the «Servicios» section. */
function serviceCard(name: string): HTMLElement {
  const section = screen
    .getByRole('heading', { name: 'Servicios' })
    .closest('.settings-section') as HTMLElement
  return within(section)
    .getByRole('heading', { name })
    .closest('.settings-group') as HTMLElement
}

describe('«Probar conexión» on every Servicios card', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('exposes one button per service card in the section', async () => {
    mockFetch()
    renderSettings()

    const section = (await screen.findByRole('heading', { name: 'Servicios' })).closest(
      '.settings-section',
    ) as HTMLElement

    const buttons = within(section).getAllByRole('button', { name: 'Probar conexión' })
    expect(buttons).toHaveLength(5)
  })

  it('probes the current form values and never sends the masked password', async () => {
    const probed = mockFetch()
    renderSettings()

    const card = await screen
      .findByRole('heading', { name: 'qBittorrent' })
      .then(() => serviceCard('qBittorrent'))
    fireEvent.click(within(card).getByRole('button', { name: 'Probar conexión' }))

    await waitFor(() => expect(probed).toHaveLength(1))
    expect(probed[0]).toEqual({
      service: 'qbit',
      url: 'http://111.111.111.111:8080',
      user: 'chan',
    })
    expect(probed[0]).not.toHaveProperty('password')
    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({
          message:
            'qBittorrent (http://111.111.111.111:8088/) no aceptó la descarga: HTTP 404: Not Found',
          tone: 'error',
        }),
      ),
    )
  })

  it('never sends a masked API key as the candidate either', async () => {
    const probed = mockFetch()
    renderSettings()

    const card = await screen
      .findByRole('heading', { name: 'Radarr' })
      .then(() => serviceCard('Radarr'))
    fireEvent.click(within(card).getByRole('button', { name: 'Probar conexión' }))

    await waitFor(() => expect(probed).toHaveLength(1))
    expect(probed[0]).toEqual({ service: 'radarr', url: 'http://localhost:7878' })
    expect(probed[0]).not.toHaveProperty('api_key')
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import type { ServiceKey, ServiceStatus } from '../../../shared/types.ts'

/**
 * qBittorrent card (qbit-nativo T3/S3): the native download target is
 * configurable from Configuración → Servicios, mirroring the aMuTorrent card
 * exactly — URL/Usuario/Contraseña bound through `update()` into
 * `services.qbit.*`, and the password masked. The GET payload carries the
 * password as a masking sentinel; an untouched field must round-trip it
 * byte-for-byte so `_restore_masked_secrets` keeps the real secret (an altered
 * sentinel deletes the stored key — a credentials regression).
 */

// Mirrors the backend DEFAULTS: the settings page reads these paths directly,
// so a partial fixture makes the component throw rather than test anything.
const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    // GET /api/settings returns the qbit password ALWAYS masked (sentinel).
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

/** The qbit card inside the «Servicios» section, scoped like the neighbours. */
function qbitCard(): HTMLElement {
  const section = screen
    .getByRole('heading', { name: 'Servicios' })
    .closest('.settings-section') as HTMLElement
  const card = within(section)
    .getByRole('heading', { name: 'qBittorrent' })
    .closest('.settings-group') as HTMLElement
  return card
}

describe('qBittorrent service card', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders url/user/password in the Servicios section, password masked', async () => {
    mockFetch()
    renderSettings()

    const card = await screen
      .findByRole('heading', { name: 'qBittorrent' })
      .then(() => qbitCard())
    const url = within(card).getByLabelText('URL')
    expect(url).toHaveValue('http://111.111.111.111:8080')
    expect(url).toHaveAttribute('type', 'text')
    const user = within(card).getByLabelText('Usuario')
    expect(user).toHaveValue('chan')
    expect(user).toHaveAttribute('type', 'text')
    const password = within(card).getByLabelText('Contraseña')
    expect(password).toHaveValue('****wxyz')
    expect(password).toHaveAttribute('type', 'password')
  })

  it('writes services.qbit.* through update() into the saved payload', async () => {
    const saved = mockFetch()
    renderSettings()

    const card = await screen
      .findByRole('heading', { name: 'qBittorrent' })
      .then(() => qbitCard())
    fireEvent.change(within(card).getByLabelText('URL'), {
      target: { value: 'http://192.168.1.10:8080' },
    })
    fireEvent.change(within(card).getByLabelText('Usuario'), { target: { value: 'admin' } })
    fireEvent.change(within(card).getByLabelText('Contraseña'), { target: { value: 'nueva' } })
    // Same save as the neighbouring cards: «Guardar cambios» lives in the
    // panel header (a second one exists on the aMule card).
    const header = screen
      .getByRole('heading', { name: 'General', level: 2 })
      .closest('.settings-panel-header') as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: /Guardar cambios/ }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect((saved[0] as typeof settings).services.qbit).toEqual({
      url: 'http://192.168.1.10:8080',
      user: 'admin',
      password: 'nueva',
    })
  })

  it('round-trips the masked password sentinel untouched when not edited', async () => {
    const saved = mockFetch()
    renderSettings()

    const card = await screen
      .findByRole('heading', { name: 'qBittorrent' })
      .then(() => qbitCard())
    // Touch a non-secret field only: the password must leave as the exact
    // sentinel the backend sent, or the stored secret gets deleted.
    fireEvent.change(within(card).getByLabelText('URL'), {
      target: { value: 'http://111.111.111.111:8080' },
    })
    const header = screen
      .getByRole('heading', { name: 'General', level: 2 })
      .closest('.settings-panel-header') as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: /Guardar cambios/ }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect((saved[0] as typeof settings).services.qbit.password).toBe('****wxyz')
    expect((saved[0] as typeof settings).services.qbit.user).toBe('chan')
  })

  it('ServiceKey accepts qbit (type-level via usage)', () => {
    // Compile-time contract: widening ServiceKey is what lets every keyed
    // consumer address the new service. Vitest does not typecheck, so tsc -b
    // is the gate that observes this assertion RED before the union widens.
    const key: ServiceKey = 'qbit'
    const status: ServiceStatus = { key, label: 'qBittorrent', state: 'unknown', reason: '' }
    expect(status.key).toBe('qbit')
  })
})

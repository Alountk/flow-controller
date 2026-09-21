import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../components/Settings'
import type { ServiceTestResult } from '../api/services'

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
  intervals: { check: 15, max_retries: 3, retry_delay: 2, request_timeout: 5, import_timeout: 40 },
  tracing: { limit: 25 },
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
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/services/test')) {
      if (results === 'error') return Promise.resolve({ ok: false, status: 500 } as Response)
      return Promise.resolve({
        ok: true,
        json: async () => ({ results, ok: results.every((r) => r.ok) }),
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

    await waitFor(() => expect(screen.getByText(/radarr/)).toBeInTheDocument())
    expect(screen.getByText(/sonarr/)).toBeInTheDocument()
    expect(screen.getByText(/amutorrent/)).toBeInTheDocument()
  })

  it('shows the URL that was attempted', async () => {
    // The whole point during a proxy migration: which host did we actually hit?
    mockFetch([result({ url: 'http://192.168.1.50:7878' })])
    renderSettings()
    await clickTest()

    await waitFor(() => expect(screen.getByText('http://192.168.1.50:7878')).toBeInTheDocument())
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

  it('marks each healthy service so a mixed result is readable', async () => {
    mockFetch([
      result({ key: 'radarr', ok: true }),
      result({ key: 'sonarr', ok: false, detail: 'sonarr: no respondió a tiempo', error_kind: 'timeout' }),
    ])
    renderSettings()
    await clickTest()

    await waitFor(() => expect(document.querySelectorAll('.service-test')).toHaveLength(2))
    const rows = [...document.querySelectorAll('.service-test')]
    expect(rows.filter((r) => r.classList.contains('ok'))).toHaveLength(1)
    expect(rows.filter((r) => r.classList.contains('fail'))).toHaveLength(1)
    expect(within(rows[1] as HTMLElement).getByText(/no respondió a tiempo/)).toBeInTheDocument()
  })
})

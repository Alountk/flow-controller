import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import { clearToasts } from '../../../shared/utils/toast.ts'
import type { AmuleHealth } from '../../../shared/api/services.ts'

/**
 * aMule watchdog state in the aMule card (amule-watchdog S6): `GET /api/amule/health`
 * polled on mount and every 30 s, badge + detail rendered next to the probe UI.
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

function snapshot(state: AmuleHealth['state'], detail: string): AmuleHealth {
  return {
    state,
    detail,
    checked_at: 1761700000.0,
    consecutive_failures: state === 'colgado' ? 2 : 0,
    restart_attempts: 0,
    last_restart_at: null,
  }
}

/** The health answer is mutable so a test can flip it between polls. */
function mockFetch(health: { next: AmuleHealth | Error }) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/amule/health')) {
      if (health.next instanceof Error) return Promise.reject(health.next)
      return Promise.resolve({ ok: true, status: 200, json: async () => health.next } as Response)
    }
    if (url.includes('/api/settings')) {
      if ((init?.method ?? 'GET') === 'POST') {
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

async function amuleCard(): Promise<HTMLElement> {
  const title = await screen.findByText(/aMule — conexión directa \(EC\)/)
  return title.closest('.amule-ec-card') as HTMLElement
}

/** Synchronous card lookup for the fake-timer test (no waitFor there). */
function amuleCardSync(): HTMLElement {
  const title = screen.getByText(/aMule — conexión directa \(EC\)/)
  return title.closest('.amule-ec-card') as HTMLElement
}

const LABELS: Array<[AmuleHealth['state'], string]> = [
  ['sano', 'Sano'],
  ['colgado', 'Colgado'],
  ['reiniciando', 'Reiniciando…'],
  ['recuperado', 'Recuperado'],
  ['alerta', 'Alerta'],
  ['sin-datos', 'Sin datos'],
  ['sin-configurar', 'Sin configurar'],
]

describe('watchdog health in the aMule card (amule-watchdog S6)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it.each(LABELS)(
    'fetches /api/amule/health on mount and renders «%s» as the badge «%s»',
    async (state, label) => {
      const health = { next: snapshot(state, `detalle de ${state}`) }
      const fn = mockFetch(health)
      renderSettings()

      const card = await amuleCard()
      await within(card).findByText(label)
      expect(
        fn.mock.calls.some(([input]) => String(input) === '/api/amule/health'),
      ).toBe(true)
      expect(within(card).getByText('Estado del watchdog:')).toBeVisible()
    },
  )

  it('shows the reason as visible status text when the watchdog reports colgado', async () => {
    const detail = 'El canario EC no responde: 2 fallos consecutivos'
    mockFetch({ next: snapshot('colgado', detail) })
    renderSettings()

    const card = await amuleCard()
    await within(card).findByText('Colgado')
    const status = within(card).getByRole('status')
    expect(status).toHaveTextContent(detail)
    expect(status).toBeVisible()
  })

  it('refetches every 30 s and flips the badge to «Colgado» on a later hung snapshot', async () => {
    const health = { next: snapshot('sano', 'Último canario OK') }
    mockFetch(health)
    vi.useFakeTimers()
    try {
      renderSettings()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const card = amuleCardSync()
      expect(within(card).getByText('Sano')).toBeInTheDocument()

      health.next = snapshot('colgado', 'Búsqueda EC sin respuesta tras el timeout')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_999)
      })
      expect(within(card).getByText('Sano')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(within(card).getByText('Colgado')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives a failing health fetch: no crash and no state is claimed', async () => {
    const fn = mockFetch({ next: new Error('network down') })
    renderSettings()

    const card = await amuleCard()
    await waitFor(() =>
      expect(fn.mock.calls.some(([input]) => String(input) === '/api/amule/health')).toBe(true),
    )
    // Honest absence: the section is there but the card claims no state at all.
    expect(within(card).getByText('Estado del watchdog:')).toBeVisible()
    for (const [, label] of LABELS) {
      expect(within(card).queryByText(label)).toBeNull()
    }
    expect(within(card).queryByRole('status')).toBeNull()
    expect(within(card).getByRole('button', { name: 'Probar conexión EC' })).toBeVisible()
  })
})

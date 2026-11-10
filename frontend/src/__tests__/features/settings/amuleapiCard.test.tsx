import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import { clearToasts } from '../../../shared/utils/toast.ts'

/**
 * «aMule API» card (amule-api-card): anatomy copied from the EC card —
 * Host/URL + Puerto + Contraseña apart, probe, its own «Guardar cambios» and
 * a status line that polls THIS service (the user's pick: status-api, not the
 * daemon watchdog badge of the card above).
 */

/** Builds the settings payload with a given amuleapi group so the unconfigured
 *  case is a fixture, not a mutation halfway through a test. */
function fixtures(amuleapi: { url: string; port: string; password: string }) {
  return {
    services: {
      radarr: { url: 'http://localhost:7878', api_key: '****7890' },
      sonarr: { url: 'http://localhost:8989', api_key: 'k' },
      amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
      qbit: { url: 'http://111.111.111.111:8080', user: 'chan', password: '****wxyz' },
      amuleapi,
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
    intervals: { check: 15, max_retries: 7, retry_delay: 2, request_timeout: 5, import_timeout: 40 },
    tracing: { limit: 25 },
    retention: { amule_days: 7 },
    server: { port: 8000 },
  }
}

const CONFIGURED = { url: 'http://amulehost', port: '4711', password: '****wxyz' }
const UNCONFIGURED = { url: '', port: '', password: '' }

type Verdict = { ok: boolean; detail: string }

/** Mutable so a test can flip the verdict between polls. */
function mockFetch(state: {
  settings: ReturnType<typeof fixtures>
  verdict: Verdict | 'reject'
}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services/test')) {
      if (state.verdict === 'reject') return Promise.reject(new Error('network down'))
      if ((init?.method ?? 'GET') === 'GET') {
        if (!url.includes('service=amuleapi')) {
          return Promise.resolve({ ok: true, json: async () => ({ results: [], ok: true }) } as Response)
        }
        const v = state.verdict
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [{ key: 'amuleapi', kind: 'amuleapi', url: 'http://amulehost:4711', ...v }],
            ok: v.ok,
          }),
        } as Response)
      }
      // POST = the probe: same verdict shape, and the body is assertable.
      const v = state.verdict
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [{ key: 'amuleapi', kind: 'amuleapi', url: 'http://amulehost:4711', ...v }],
          ok: v.ok,
        }),
      } as Response)
    }
    if (url.includes('/api/settings')) {
      if ((init?.method ?? 'GET') === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, restart_required: [] }) } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => state.settings } as Response)
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

async function apiCard(): Promise<HTMLElement> {
  // Wait for the loaded shell first: while «Cargando…» renders, no tab and no
  // panel exist yet — then the click makes role queries see the panel.
  const tab = await screen.findByRole('tab', { name: 'aMule' })
  fireEvent.click(tab)
  const title = await screen.findByRole('heading', { name: 'aMule API' })
  return title.closest('.amule-ec-card') as HTMLElement
}

const CALLS_TO = (fn: ReturnType<typeof mockFetch>, needle: string) =>
  fn.mock.calls.filter(([input]) => String(input).includes(needle))

describe('the aMule API card (amule-api-card)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('shows Host / URL, Puerto and Contraseña like the EC card', async () => {
    mockFetch({ settings: fixtures(CONFIGURED), verdict: { ok: true, detail: 'Conectado (3.2.0)' } })
    renderSettings()

    const card = await apiCard()
    const host = within(card).getByLabelText('Host / URL')
    expect(host).toHaveAttribute('value', 'http://amulehost')
    expect(within(card).getByLabelText('Puerto')).toHaveAttribute('value', '4711')
    expect(within(card).getByLabelText('Contraseña')).toHaveAttribute('type', 'password')
  })

  it('carries its own «Guardar cambios» that posts the port to the backend', async () => {
    const fn = mockFetch({ settings: fixtures(CONFIGURED), verdict: { ok: true, detail: 'Conectado (3.2.0)' } })
    renderSettings()

    const card = await apiCard()
    fireEvent.click(within(card).getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => {
      const posts = fn.mock.calls.filter(
        ([, init]) => (init?.method ?? 'GET') === 'POST' && String(fn.mock.calls.find(() => true)?.[0]).includes(''),
      )
      const settingsPost = fn.mock.calls.find(
        ([input, init]) => String(input).includes('/api/settings') && (init?.method ?? 'GET') === 'POST',
      )
      expect(settingsPost).toBeTruthy()
      const body = JSON.parse(String((settingsPost as [unknown, RequestInit | undefined])[1]?.body))
      expect(body.services.amuleapi.port).toBe('4711')
      expect(body.services.amuleapi.url).toBe('http://amulehost')
      expect(posts).toBeTruthy()
    })
  })

  it('polls the service and renders «Vivo» with the backend detail', async () => {
    const fn = mockFetch({ settings: fixtures(CONFIGURED), verdict: { ok: true, detail: 'Conectado (3.2.0)' } })
    renderSettings()

    const card = await apiCard()
    await within(card).findByText('Vivo')
    expect(within(card).getByText('Estado del servicio:')).toBeVisible()
    const status = within(card).getByRole('status')
    expect(status).toHaveTextContent('Conectado (3.2.0)')
    expect(CALLS_TO(fn, 'service=amuleapi').length).toBeGreaterThan(0)
  })

  it('renders «Caído» with the reason when the probe answers down', async () => {
    mockFetch({ settings: fixtures(CONFIGURED), verdict: { ok: false, detail: 'amuleapi (http://amulehost:4711): Connection refused' } })
    renderSettings()

    const card = await apiCard()
    await within(card).findByText('Caído')
    expect(within(card).getByRole('status')).toHaveTextContent('Connection refused')
  })

  it('claims no state at all when the poll fails', async () => {
    const fn = mockFetch({ settings: fixtures(CONFIGURED), verdict: 'reject' })
    renderSettings()

    const card = await apiCard()
    await waitFor(() => expect(CALLS_TO(fn, 'service=amuleapi').length).toBeGreaterThan(0))
    expect(within(card).getByText('Estado del servicio:')).toBeVisible()
    expect(within(card).queryByText('Vivo')).toBeNull()
    expect(within(card).queryByText('Caído')).toBeNull()
    expect(within(card).queryByRole('status')).toBeNull()
  })

  it('shows «Sin configurar» without polling while url or password are empty', async () => {
    const fn = mockFetch({ settings: fixtures(UNCONFIGURED), verdict: { ok: true, detail: 'Conectado (3.2.0)' } })
    renderSettings()

    const card = await apiCard()
    await within(card).findByText('Sin configurar')
    expect(CALLS_TO(fn, 'service=amuleapi')).toHaveLength(0)
    expect(within(card).queryByRole('status')).toBeNull()
  })

  it('the probe sends the port field with the candidate', async () => {
    const fn = mockFetch({ settings: fixtures(CONFIGURED), verdict: { ok: true, detail: 'Conectado (3.2.0)' } })
    renderSettings()

    const card = await apiCard()
    fireEvent.click(await within(card).findByRole('button', { name: 'Probar conexión' }))

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([input, init]) => String(input).includes('/api/services/test') && (init?.method ?? 'GET') === 'POST',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(String((post as [unknown, RequestInit | undefined])[1]?.body))
      expect(body.service).toBe('amuleapi')
      expect(body.url).toBe('http://amulehost')
      expect(body.port).toBe('4711')
    })
  })

  it('refetches every 30 s and flips the badge on a later answer', async () => {
    const state = { settings: fixtures(CONFIGURED), verdict: { ok: true, detail: 'Conectado (3.2.0)' } }
    mockFetch(state)
    vi.useFakeTimers()
    try {
      renderSettings()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const panel = document.getElementById('settings-panel-amule') as HTMLElement
      const title = within(panel).getByText('aMule API')
      const card = title.closest('.amule-ec-card') as HTMLElement
      expect(within(card).getByText('Vivo')).toBeInTheDocument()

      state.verdict = { ok: false, detail: 'amuleapi (http://amulehost:4711): HTTP 503' }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_999)
      })
      expect(within(card).getByText('Vivo')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(within(card).getByText('Caído')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

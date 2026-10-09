import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../../pages/Peliculas.tsx'
import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'

/**
 * C-09: the mass missing search asks BEFORE it launches.
 *
 * One careless `POST /api/wanted/search` fired grabs for 24 movies at once
 * (2026-10-07) with no way to stop them. The backend now answers a probe
 * (confirm=false) with `needs_confirm` and launches nothing; only an explicit
 * confirm=true carries the launch. This test drives the Wanted UI the way the
 * operator does — press the bulk trigger, read the count, accept — and pins
 * the contract: confirm=true must not leave the browser before acceptance.
 *
 * Driven through Películas · Faltantes — the sub-view the retired Faltantes
 * page became (PR 7 of F-08), where the wanted listing lives.
 */

interface FetchOptions {
  /** The missing list's total — what the dialog must state. */
  total?: number
  /** What the probe (confirm=false) answers. */
  probe?: Record<string, unknown>
  /** What the confirmed launch (confirm=true) answers. */
  launch?: Record<string, unknown>
  /** What the cancel endpoint answers. */
  cancel?: Record<string, unknown>
}

function movieItems(total: number) {
  return Array.from({ length: total }, (_, i) => ({
    id: i + 1,
    title: `Película ${i + 1}`,
    year: 2020,
    overview: '',
    remotePoster: '',
    has_file: false,
    altTitles: [],
  }))
}

/** Stubs fetch and records every mass-search body that reaches the wire. */
function mockFetch(opts: FetchOptions = {}) {
  const total = opts.total ?? 0
  const searchCalls: Record<string, unknown>[] = []
  const cancelCalls: Record<string, unknown>[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>
    const ok = (payload: unknown) =>
      Promise.resolve({ ok: true, json: async () => payload } as Response)
    // Before the search check: the cancel URL shares its prefix.
    if (url.includes('/api/wanted/search/cancel')) {
      cancelCalls.push(body)
      return ok(opts.cancel ?? { ok: true, detail: 'Comando 42 cancelado' })
    }
    if (url.includes('/api/wanted/search')) {
      searchCalls.push(body)
      return body.confirm === true
        ? ok(opts.launch ?? { ok: true, detail: 'encolado', command_id: 42 })
        : ok(
            opts.probe ?? {
              ok: false,
              needs_confirm: true,
              command: 'MissingMoviesSearch',
              detail: 'Búsqueda masiva no lanzada: reenvía con confirm=true',
            },
          )
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [], total: 0, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted')) {
      return ok({
        wanted: {
          radarr: { items: movieItems(total), total },
          sonarr: { items: [], total: 0 },
        },
        updated_at: 0,
      })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return { searchCalls, cancelCalls }
}

/** Películas · Faltantes: where the missing listing lives since PR 7. */
function renderFaltantes() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Peliculas />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Faltantes \(/ }))
}

describe('bulk wanted search asks for confirmation with the count', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('shows the count dialog and only sends confirm=true after acceptance', async () => {
    const { searchCalls } = mockFetch({ total: 24 })

    renderFaltantes()

    // The trigger exists and becomes actionable once the list total is known.
    const trigger = await screen.findByRole('button', { name: /Buscar todas las faltantes/ })
    await waitFor(() => expect(trigger).toBeEnabled())
    fireEvent.click(trigger)

    // The dialog states the count the list is holding...
    await screen.findByText('24 resultados — ¿lanzar búsqueda?')

    // ...and nothing but the probe has been sent: no launch without consent.
    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0].confirm).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
    await waitFor(() => expect(searchCalls).toHaveLength(2))
    expect(searchCalls[1].confirm).toBe(true)

    // Accepted: the dialog leaves and the backend's ack arrives as a toast.
    await waitFor(() =>
      expect(screen.queryByText('24 resultados — ¿lanzar búsqueda?')).not.toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(getToasts().map((t) => t.message)).toContain('encolado'),
    )
  })

  it('cancel in the dialog sends nothing beyond the probe', async () => {
    const { searchCalls } = mockFetch({ total: 24 })

    renderFaltantes()

    const trigger = await screen.findByRole('button', { name: /Buscar todas las faltantes/ })
    await waitFor(() => expect(trigger).toBeEnabled())
    fireEvent.click(trigger)
    await screen.findByText('24 resultados — ¿lanzar búsqueda?')

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    // No confirmation dialog, no second request, no launch of any kind.
    await waitFor(() =>
      expect(screen.queryByText('24 resultados — ¿lanzar búsqueda?')).not.toBeInTheDocument(),
    )
    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0].confirm).toBe(false)
    expect(getToasts()).toHaveLength(0)
  })

  it('hands the command id to the cancel endpoint after the launch', async () => {
    const { searchCalls, cancelCalls } = mockFetch({ total: 24 })

    renderFaltantes()

    const trigger = await screen.findByRole('button', { name: /Buscar todas las faltantes/ })
    await waitFor(() => expect(trigger).toBeEnabled())
    fireEvent.click(trigger)
    await screen.findByText('24 resultados — ¿lanzar búsqueda?')
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
    await waitFor(() => expect(searchCalls).toHaveLength(2))

    // The launched step surfaces the handle the backend returned.
    await screen.findByText('Búsqueda lanzada')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar búsqueda' }))

    await waitFor(() => expect(cancelCalls).toHaveLength(1))
    expect(cancelCalls[0]).toMatchObject({ source: 'radarr', command_id: 42 })
    await waitFor(() =>
      expect(screen.queryByText('Búsqueda lanzada')).not.toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(getToasts().map((t) => t.message)).toContain('Comando 42 cancelado'),
    )
  })

  it('reports a failed probe as an error toast without opening the dialog', async () => {
    const { searchCalls } = mockFetch({
      total: 5,
      probe: { ok: false, error: 'radarr: no respondió a tiempo' },
    })

    renderFaltantes()

    const trigger = await screen.findByRole('button', { name: /Buscar todas las faltantes/ })
    await waitFor(() => expect(trigger).toBeEnabled())
    fireEvent.click(trigger)

    await waitFor(() =>
      expect(
        getToasts().some((t) => t.tone === 'error' && t.message === 'radarr: no respondió a tiempo'),
      ).toBe(true),
    )
    expect(screen.queryByText(/¿lanzar búsqueda\?/)).not.toBeInTheDocument()
    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0].confirm).toBe(false)
  })

  it('blocks the trigger while a text filter narrows the count', async () => {
    mockFetch({ total: 24 })

    renderFaltantes()

    const trigger = await screen.findByRole('button', { name: /Buscar todas las faltantes/ })
    await waitFor(() => expect(trigger).toBeEnabled())

    // A filtered total would understate what the launch actually sweeps.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar películas' }), {
      target: { value: 'star' },
    })
    expect(trigger).toBeDisabled()

    // Clearing the filter hands the trigger back.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar películas' }), {
      target: { value: '' },
    })
    expect(trigger).toBeEnabled()
  })
})

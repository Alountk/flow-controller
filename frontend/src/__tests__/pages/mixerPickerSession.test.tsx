import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'

/**
 * S8 F2: semántica de sesión del picker del mixer (patrón F1) — reabrir
 * «Examinar…» retoma la última carpeta visitada, no vuelve a la raíz.
 */

type Handler = () => { status?: number; body: unknown }
type Route = [string, Handler]

function mockFetch(handlers: Route[]) {
  const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    for (const [match, handler] of handlers) {
      if (url.includes(match)) {
        const r = handler()
        const status = r.status ?? 200
        return Promise.resolve({
          ok: status < 400,
          status,
          json: async () => r.body,
        } as Response)
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function handlers(): Route[] {
  return [
    ['/api/files/roots', () => ({ body: { roots: [{ path: '/mnt', name: 'Media' }] } })],
    ['/api/files/browse', () => ({
      body: {
        ok: true,
        path: '/mnt',
        items: [{ path: '/mnt/Pelis', name: 'Pelis', is_dir: true }],
      },
    })],
    ['/api/mixer/tasks', () => ({ body: { tasks: [] } })],
  ]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mixer — el picker recuerda la última carpeta al reabrir', () => {
  it('reabre en la carpeta donde se quedó, con el filtro vacío', async () => {
    mockFetch(handlers())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MediaMixer />
      </QueryClientProvider>,
    )

    const open = (await screen.findAllByRole('button', { name: 'Examinar…' }))[0]
    fireEvent.click(open)
    fireEvent.click(await screen.findByText(/Pelis/))
    expect(await screen.findByText('/mnt/Pelis')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Buscar carpeta o archivo…')).not.toBeInTheDocument()

    // Two slots render one «Examinar…» each; reopen the first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Examinar…' })[0])
    expect(await screen.findByText('/mnt/Pelis')).toBeInTheDocument()
  })
})

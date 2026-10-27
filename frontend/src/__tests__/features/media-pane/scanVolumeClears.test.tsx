import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ScanModal, type ScanItem } from '../../../features/media-pane/components/ScanModal.tsx'

/**
 * S9 F2: cambiar de volumen invalida los resultados del escaneo — era el
 * comportamiento previo a la migración (handleVolumeChange) y el refactor a
 * FileNavigator no debe perderlo.
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
    ['/api/files/roots', () => ({
      body: {
        roots: [
          { path: '/mnt/storage', name: 'storage' },
          { path: '/mnt/otro', name: 'otro' },
        ],
      },
    })],
    ['/api/files/browse', () => ({
      body: {
        ok: true,
        path: '/mnt/storage',
        items: [{ path: '/mnt/storage/peliculas', name: 'peliculas', is_dir: true }],
      },
    })],
    ['/api/wanted/scan', () => ({
      body: {
        ok: true,
        matches: [
          {
            file_path: '/mnt/storage/peliculas/Ronin.1998.mkv',
            file_name: 'Ronin.1998.mkv',
            movie_id: 7,
            movie_title: 'Ronin',
            movie_year: 1998,
            target_path: '',
            score: 0.9,
            matched_title: 'Ronin',
          },
        ],
        scanned_files: 1,
        detail: '1 archivo coincide',
      },
    })],
  ]
}

const item: ScanItem = { type: 'movie', id: 7, title: 'Ronin', source: 'radarr' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ScanModal — cambiar de volumen limpia los resultados del escaneo', () => {
  it('descarta resultados y selección al cambiar de volumen', async () => {
    mockFetch(handlers())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ScanModal item={item} onClose={() => {}} />
      </QueryClientProvider>,
    )

    // Options must exist before setting the value (jsdom drops it otherwise).
    await screen.findByRole('option', { name: 'storage' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/mnt/storage' } })
    fireEvent.click(await screen.findByRole('button', { name: /Buscar/ }))
    expect((await screen.findAllByText(/Ronin\.1998\.mkv/)).length).toBeGreaterThan(0)
    expect(screen.getByText('1 archivo coincide')).toBeInTheDocument()

    // Volume change: the results point into the old tree and must go away.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/mnt/otro' } })

    expect(screen.queryAllByText(/Ronin\.1998\.mkv/)).toHaveLength(0)
    expect(screen.queryByText('1 archivo coincide')).not.toBeInTheDocument()
  })
})

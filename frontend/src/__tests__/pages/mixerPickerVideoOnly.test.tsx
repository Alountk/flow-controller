import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'

/**
 * Fix del 500 «Cotejar archivos»: el picker del mixer sólo ofrece archivos
 * de vídeo (`is_video: false` oculto). `is_video` ausente = desconocido
 * (payload antiguo/stub) y se muestra — nunca se lee como «no vídeo».
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
        items: [
          { path: '/mnt/Pelis', name: 'Pelis', is_dir: true },
          { path: '/mnt/peli.mkv', name: 'peli.mkv', is_dir: false, size: 1000, is_video: true },
          { path: '/mnt/001.part', name: '001.part', is_dir: false, size: 3749893957, is_video: false },
          { path: '/mnt/notas.txt', name: 'notas.txt', is_dir: false, size: 10 },
        ],
      },
    })],
    ['/api/mixer/tasks', () => ({ body: { tasks: [] } })],
  ]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mixer — el picker sólo ofrece archivos de vídeo', () => {
  it('oculta is_video:false, conserva vídeo y respeta is_video ausente', async () => {
    mockFetch(handlers())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MediaMixer />
      </QueryClientProvider>,
    )

    fireEvent.click((await screen.findAllByRole('button', { name: 'Examinar…' }))[0])
    await screen.findByText('peli.mkv')

    expect(screen.getByText('peli.mkv')).toBeInTheDocument()
    expect(screen.queryByText('001.part')).not.toBeInTheDocument()
    // Absent classification = unknown, never "not a video" (shared/types.ts).
    expect(screen.getByText('notas.txt')).toBeInTheDocument()
    expect(screen.getByText(/Pelis/)).toBeInTheDocument()
  })
})

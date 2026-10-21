import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'

/**
 * Filtro del picker del mixer — «Buscar carpeta o archivo…» (decisión del
 * usuario 2026-10-21): el input filtra al vuelo las carpetas y los archivos
 * del directorio visible, el mismo patrón que ya usa Archivos (ScanModal).
 */

type Handler = () => { status?: number; body: unknown }
type Route = [string, Handler]

function mockFetch(handlers: Route[]) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url, body })
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
  return calls
}

function pickerHandlers(): Route[] {
  return [
    ['/api/files/roots', () => ({ body: { roots: [{ path: '/mnt', name: 'Media' }] } })],
    ['/api/files/browse', () => ({
      body: {
        ok: true,
        path: '/mnt',
        items: [
          { path: '/mnt/Pelis', name: 'Pelis', is_dir: true },
          { path: '/mnt/Series', name: 'Series', is_dir: true },
          { path: '/mnt/alpha.mkv', name: 'alpha.mkv', is_dir: false, size: 1_000 },
          { path: '/mnt/beta.mp4', name: 'beta.mp4', is_dir: false, size: 2_000 },
        ],
      },
    })],
    ['/api/mixer/tasks', () => ({ body: { tasks: [] } })],
  ]
}

function renderMixer() {
  mockFetch(pickerHandlers())
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MediaMixer />
    </QueryClientProvider>,
  )
}

async function openPicker() {
  const browseButtons = await screen.findAllByRole('button', { name: 'Examinar…' })
  fireEvent.click(browseButtons[0])
  // The file row is the reliable anchor (single text node); folders render
  // `📁 {name}` as split text, so they always need a regex matcher.
  await screen.findByText('alpha.mkv')
}

function filterInput(): HTMLInputElement {
  return screen.getByPlaceholderText('Buscar carpeta o archivo…') as HTMLInputElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mixer — filtro del picker (carpetas y archivos del directorio visible)', () => {
  it('filtra las carpetas por nombre sin distinguir mayúsculas', async () => {
    renderMixer()
    await openPicker()

    fireEvent.change(filterInput(), { target: { value: 'PELI' } })

    expect(await screen.findByText(/Pelis/)).toBeInTheDocument()
    expect(screen.queryByText(/Series/)).not.toBeInTheDocument()
    expect(screen.queryByText('alpha.mkv')).not.toBeInTheDocument()
  })

  it('filtra los archivos por nombre sin distinguir mayúsculas', async () => {
    renderMixer()
    await openPicker()

    fireEvent.change(filterInput(), { target: { value: 'ALP' } })

    expect(await screen.findByText('alpha.mkv')).toBeInTheDocument()
    expect(screen.queryByText('beta.mp4')).not.toBeInTheDocument()
    expect(screen.queryByText(/Pelis/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Series/)).not.toBeInTheDocument()
  })

  it('vaciar el filtro restaura la lista completa', async () => {
    renderMixer()
    await openPicker()

    fireEvent.change(filterInput(), { target: { value: 'zzz' } })
    expect(screen.queryByText(/Pelis/)).not.toBeInTheDocument()
    expect(screen.queryByText('alpha.mkv')).not.toBeInTheDocument()

    fireEvent.change(filterInput(), { target: { value: '' } })
    expect(await screen.findByText(/Pelis/)).toBeInTheDocument()
    expect(await screen.findByText(/Series/)).toBeInTheDocument()
    expect(await screen.findByText('alpha.mkv')).toBeInTheDocument()
    expect(await screen.findByText('beta.mp4')).toBeInTheDocument()
  })

  it('muestra «Sin coincidencias» cuando el filtro no encuentra nada', async () => {
    renderMixer()
    await openPicker()

    fireEvent.change(filterInput(), { target: { value: 'zzz' } })

    expect(await screen.findByText('Sin coincidencias')).toBeInTheDocument()
    expect(screen.queryByText('Sin subcarpetas')).not.toBeInTheDocument()
  })
})

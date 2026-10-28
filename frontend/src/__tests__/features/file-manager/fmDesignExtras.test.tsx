import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileManager } from '../../../features/file-manager/FileManager.tsx'
import type { RootsResponse } from '../../../shared/types.ts'

/**
 * F3 design extras (S11) — RED-first pinning for the Stitch «page Archivos»
 * affordances: clickable breadcrumb, column headers, the new filter
 * placeholder + «/» shortcut, and the POSIX copy-path row action.
 *
 * The 13 anchor tests stay untouched; these fail until T9 implements.
 */

interface BrowseItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
}

const dir = (name: string): BrowseItem => ({
  name,
  path: `/mnt/storage/${name}`,
  is_dir: true,
  size: 0,
  modified: 0,
})

const file = (name: string, size = 1_500_000_000): BrowseItem => ({
  name,
  path: `/mnt/storage/${name}`,
  is_dir: false,
  size,
  modified: 0,
})

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function mockFetch(listings: Record<string, BrowseItem[]>): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/files/roots')) {
      const roots: RootsResponse['roots'] = [
        { path: '/mnt/storage', name: 'storage', role: 'navigation', label: 'storage' },
      ]
      return ok({ roots, detail: '' })
    }
    if (url.includes('/api/files/browse')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, items: listings[path] ?? [] })
    }
    if (url.includes('/api/files/retention')) {
      return ok({ ok: true, path: '', days: 7, files: [] })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function browseCountFor(fn: ReturnType<typeof vi.fn>, path: string): number {
  return fn.mock.calls.filter(([input]) => {
    if (!String(input).includes('/api/files/browse')) return false
    return new URL(String(input), 'http://x').searchParams.get('path') === path
  }).length
}

function renderFileManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileManager />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('F3 breadcrumb clicable (S11a)', () => {
  it('segment buttons navigate to the clicked ancestor inside the volume', async () => {
    const fetchMock = mockFetch({
      '/mnt/storage': [dir('descargas')],
      '/mnt/storage/descargas': [file('A.mkv')],
    })
    renderFileManager()
    await screen.findByText('descargas')

    fireEvent.dblClick(screen.getByText('descargas'))
    await screen.findByText('A.mkv')

    const storageSegment = screen.queryByRole('button', { name: 'storage' })
    expect(storageSegment).toBeInTheDocument() // RED: path is plain text today

    fireEvent.click(storageSegment as HTMLElement)
    await waitFor(() => expect(browseCountFor(fetchMock, '/mnt/storage')).toBeGreaterThanOrEqual(2))
  })
})

describe('F3 cabeceras de columna (S11b)', () => {
  it('renders the design header row: Nombre/Procedencia/Retención/Tamaño/Modificado/Acciones', async () => {
    mockFetch({ '/mnt/storage': [file('A.mkv')] })
    renderFileManager()
    await screen.findByText('A.mkv')

    for (const header of ['Nombre', 'Procedencia', 'Retención', 'Tamaño', 'Modificado', 'Acciones']) {
      expect(screen.getAllByText(header).length).toBeGreaterThan(0) // RED: no headers today
    }
  })
})

describe('F3 placeholder del filtro (S11c)', () => {
  it('shows the exact design placeholder', async () => {
    mockFetch({ '/mnt/storage': [file('A.mkv')] })
    renderFileManager()
    await screen.findByText('A.mkv')

    expect(
      screen.getByPlaceholderText('Buscar carpeta o archivo... [ / ]'),
    ).toBeInTheDocument() // RED: «Filtrar archivos...» today
  })
})

describe('F3 atajo «/» (S11c)', () => {
  it('pressing «/» focuses the filter input', async () => {
    mockFetch({ '/mnt/storage': [file('A.mkv')] })
    renderFileManager()
    await screen.findByText('A.mkv')

    const filter = screen.getByRole('searchbox', { name: 'Filtrar archivos' })
    ;(filter as HTMLElement).blur()

    fireEvent.keyDown(document.body, { key: '/' })

    expect(document.activeElement).toBe(filter) // RED: no shortcut today
  })

  it('pressing «/» keeps typing inside an inline create/rename input', async () => {
    mockFetch({ '/mnt/storage': [file('A.mkv')] })
    renderFileManager()
    await screen.findByText('A.mkv')

    fireEvent.click(screen.getByTitle('Renombrar'))
    const inputs = Array.from(document.querySelectorAll('input'))
    const filter = screen.getByRole('searchbox', { name: 'Filtrar archivos' })
    const inline = inputs.find((i) => i !== filter)
    expect(inline).toBeTruthy()
    ;(inline as HTMLInputElement).focus()

    fireEvent.keyDown(inline as HTMLElement, { key: '/' })

    expect(document.activeElement).toBe(inline) // RED: shortcut not implemented yet
  })
})

describe('F3 copiar ruta POSIX (S11d)', () => {
  it('copies item.path to the clipboard and shows feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    mockFetch({ '/mnt/storage': [file('A.mkv')] })
    renderFileManager()
    await screen.findByText('A.mkv')

    const copyPath = screen.getByRole('button', { name: 'Copiar ruta absoluta POSIX' })
    fireEvent.click(copyPath)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/mnt/storage/A.mkv'))
    await screen.findByText('Ruta copiada')
  })
})

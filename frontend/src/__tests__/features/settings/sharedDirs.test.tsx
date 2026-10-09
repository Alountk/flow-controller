import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SharedDirsSection } from '../../../features/settings/SharedDirsSection.tsx'

/**
 * What this panel has to get right, in order of how badly it fails otherwise:
 *
 * 1. a path outside `allowed_roots` never reaches the backend — publishing a
 *    folder to the ED2K network cannot be undone from here;
 * 2. a reload that failed is reported as *pending*, not as saved — the files
 *    are written but aMule has not seen them;
 * 3. save sends BOTH lists, because replacing one file and leaving the other
 *    would leave aMule sharing something the user just removed.
 */

const sharedDirs = {
  config_dir: '/mnt/storage/amule/config',
  recursive: ['/mnt/storage/movies', '/mnt/storage-6tb/shared-media'],
  explicit: [],
  allowed_roots: ['/mnt/storage', '/mnt/storage-6tb'],
}

function mockFetch(saveResult?: { ok: boolean; reload: { ok: boolean; detail: string } }) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/amule/shared-dirs') && init?.method === 'PUT') {
      if (saveResult === undefined) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: saveResult.ok, recursive: [], explicit: [], reload: saveResult.reload }),
      } as Response)
    }
    if (url.includes('/api/amule/shared-dirs')) {
      return Promise.resolve({ ok: true, json: async () => sharedDirs } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SharedDirsSection />
    </QueryClientProvider>,
  )
}

const addPath = async (path: string, button: RegExp) => {
  const input = await screen.findByLabelText('Ruta a compartir')
  fireEvent.change(input, { target: { value: path } })
  fireEvent.click(screen.getByRole('button', { name: button }))
}

describe('aMule shared folders panel', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('shows what aMule has configured today', async () => {
    mockFetch()
    renderSection()

    expect(await screen.findByText('/mnt/storage/movies')).toBeInTheDocument()
    expect(screen.getByText('/mnt/storage-6tb/shared-media')).toBeInTheDocument()
    expect(screen.getByText(/\/mnt\/storage\/amule\/config/)).toBeInTheDocument()
  })

  it('refuses a path outside allowed_roots without sending it', async () => {
    const fn = mockFetch()
    renderSection()

    await addPath('/etc', /Añadir recursiva/)

    expect(await screen.findByText(/Fuera de las raíces permitidas/)).toBeInTheDocument()
    expect(screen.queryByText('/etc')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Guardar y recargar aMule/ }))
    await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(0))

    const put = fn.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/api/amule/shared-dirs') && init?.method === 'PUT',
    )
    const body = JSON.parse(String(put![1]?.body)) as { recursive: string[] }
    expect(body.recursive).not.toContain('/etc')
  })

  it('refuses a relative path before it ever gets near the backend', async () => {
    mockFetch()
    renderSection()

    await addPath('etc/passwd', /Añadir recursiva/)

    expect(await screen.findByText(/debe ser absoluta/)).toBeInTheDocument()
  })

  it('sends both lists, so removing one file does not leave the other stale', async () => {
    const fn = mockFetch()
    renderSection()

    // Two roots are loaded, so there are two "Quitar" buttons — take the first.
    const removes = await screen.findAllByRole('button', { name: 'Quitar' })
    fireEvent.click(removes[0])
    expect(screen.queryByText('/mnt/storage/movies')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Guardar y recargar aMule/ }))

    await waitFor(() => {
      const put = fn.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/amule/shared-dirs') && init?.method === 'PUT',
      )
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put![1]?.body)) as {
        recursive: string[]
        explicit: string[]
      }
      expect(body.recursive).toEqual(['/mnt/storage-6tb/shared-media'])
      expect(body.explicit).toEqual([])
    })
  })

  it('reports a failed reload as pending, never as saved', async () => {
    mockFetch({
      ok: false,
      reload: { ok: false, detail: 'HTTP 500: boom' },
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: /Guardar y recargar aMule/ }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/recarga falló/))
    expect(screen.getByRole('status')).toHaveTextContent('boom')
  })

  it('adds a path under both roots when it is inside one of them', async () => {
    mockFetch()
    renderSection()

    await addPath('/mnt/storage-6tb/shared-media/movies/4k/', /Añadir recursiva/)

    // Trailing slash stripped and de-duplicated against the loaded list.
    expect(await screen.findByText('/mnt/storage-6tb/shared-media/movies/4k')).toBeInTheDocument()
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * The fourth destination, «Carpeta»: the row opens a folder navigator over
 * the allowed roots (`GET /api/files/roots`) and drills with
 * `GET /api/files/browse`, and «Elegir esta carpeta» fires the SAME grab the
 * other three buttons fire — `destination` rides the POST, `library` stays
 * absent. The backend's existing `path_is_allowed` validates the pick.
 */

const release: Release = {
  title: 'Película 2020 1080p',
  guid: 'g-1',
  link: 'magnet:?xt=urn:btih:aa',
  size: 1,
  indexer: 'Sitio Uno',
  source: 'torznab',
  seeders: 5,
}

const ROOTS = {
  roots: [
    { path: '/mnt/storage-6tb', name: 'storage', role: 'navigation' },
    { path: '/mnt/biblioteca', name: 'biblioteca', role: 'library' },
  ],
}

const BROWSE: Record<string, { name: string; path: string; is_dir: boolean }[]> = {
  '/mnt/storage-6tb': [
    { name: 'peliculas', path: '/mnt/storage-6tb/peliculas', is_dir: true },
    { name: 'series', path: '/mnt/storage-6tb/series', is_dir: true },
    { name: 'nota.txt', path: '/mnt/storage-6tb/nota.txt', is_dir: false },
  ],
  '/mnt/storage-6tb/peliculas': [],
}

function mockFetch(opts: { grabDetail?: string; grabOk?: boolean } = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/files/roots')) {
      return Promise.resolve({ ok: true, json: async () => ROOTS } as Response)
    }
    if (url.includes('/api/files/browse')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '')
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, items: BROWSE[path] ?? [], path }),
      } as Response)
    }
    if (url.includes('/api/calendar/grab')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ok: opts.grabOk ?? true,
          detail: opts.grabDetail ?? 'Descarga añadida en qBittorrent',
        }),
      } as Response)
    }
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => ({ indexers: [] }) } as Response)
    }
    if (url.includes('/api/indexers')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          indexers: [{ id: 1, name: 'Sitio Uno', url: 'http://u1', api_key: '***', categories: '', enabled: 1 }],
        }),
      } as Response)
    }
    if (url.includes('/api/settings')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ paths: { path_4k: '', path_3d: '' } }),
      } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases: [release], detail: '1 releases' }),
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof mockFetch>

function grabBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(
      ([input, init]) =>
        String(input).includes('/api/calendar/grab') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

function renderModal(onClose: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 411, title: 'Everything Everywhere', source: 'radarr' }}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
}

/** Search → results step (the sync POST answer carries the rows). */
async function showResults() {
  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
  await waitFor(() => expect(document.querySelector('.calendar-releases')).not.toBeNull())
}

describe('Carpeta destination (folder navigator)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers «→ Carpeta» as the row\'s fourth destination button', async () => {
    mockFetch()
    renderModal()
    await showResults()
    expect(await screen.findByRole('button', { name: /^→ Carpeta$/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Biblioteca/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^→ 4K$/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^→ 3D$/ })).toBeDisabled()
  })

  it('opens the navigator on the allowed roots with no folder chosen yet', async () => {
    mockFetch()
    renderModal()
    await showResults()
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    expect(await screen.findByRole('button', { name: 'storage' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'biblioteca' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Elegir esta carpeta' })).toBeDisabled()
  })

  it('drills from a root into its subfolders, listing directories only', async () => {
    mockFetch()
    renderModal()
    await showResults()
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'storage' }))
    expect(await screen.findByRole('button', { name: 'peliculas' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'series' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'nota.txt' })).toBeNull()
    expect(screen.getByText('/mnt/storage-6tb')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Elegir esta carpeta' })).toBeEnabled()
  })

  it('grabs with the chosen folder as destination and no library flag', async () => {
    const fn = mockFetch()
    renderModal()
    await showResults()
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'storage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'peliculas' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir esta carpeta' }))
    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    const body = grabBodies(fn)[0]
    expect(body.destination).toBe('/mnt/storage-6tb/peliculas')
    expect(body).not.toHaveProperty('library')
    expect(body.guid).toBe('g-1')
    await waitFor(() =>
      expect(document.querySelector('.folder-picker')).toBeNull(),
    )
  })

  it('closes without grabbing when the pick is cancelled', async () => {
    const fn = mockFetch()
    renderModal()
    await showResults()
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'storage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }))
    expect(document.querySelector('.folder-picker')).toBeNull()
    expect(grabBodies(fn)).toHaveLength(0)
  })

  it('reopens at the last folder visited in this modal session', async () => {
    mockFetch()
    renderModal()
    await showResults()
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'storage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }))
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    expect(await screen.findByRole('button', { name: 'peliculas' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Elegir esta carpeta' })).toBeEnabled()
  })

  it('closes the navigator on Escape before it ends the whole dialog', async () => {
    const onClose = vi.fn()
    mockFetch()
    renderModal(onClose)
    await showResults()
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'storage' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.folder-picker')).toBeNull()
    expect(document.querySelector('.calendar-releases')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces the backend refusal for a destination outside the allowed roots', async () => {
    mockFetch({ grabOk: false, grabDetail: 'Destino no permitido: /fuera' })
    renderModal()
    await showResults()
    fireEvent.click(await screen.findByRole('button', { name: /^→ Carpeta$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'storage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'peliculas' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir esta carpeta' }))
    expect(await screen.findByText('Destino no permitido: /fuera')).toBeVisible()
  })
})

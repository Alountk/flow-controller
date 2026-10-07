import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ReleaseSearchModal } from '../../components/ReleaseSearchModal'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Release } from '../../api/calendar'

/**
 * Regression tests for grab error feedback — the per-row grab (F-12).
 *
 * A failed grab must surface the backend's REAL reason (`detail`), never a
 * count or a shrug: "no funciona" is not an answer. The batch endpoint used
 * to collapse per-release failures into "0 OK, N errores"; the batch and its
 * per-release error list are gone — one button presses one grab, and one grab
 * carries one reason.
 */

const release: Release = {
  guid: 'guid-1',
  title: 'Everything Everywhere All at Once 2022 1080p BluRay',
  size: 10_000_000_000,
  quality: 'Bluray-1080p',
  indexer: 'aMuTorrent',
  indexerId: 1,
  indexerFlags: '',
  seeders: 10,
  leechers: 1,
  protocol: 'torrent',
  releaseGroup: '',
  languages: ['English'],
}

const indexers = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

/** The real Radarr message that surfaces when its release cache expires. */
const CACHE_ERROR = "Couldn't find requested release in cache, try searching again"

function mockFetch(grab: () => Response | Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => indexers } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases: [release], detail: '1 releases encontrados' }),
      } as Response)
    }
    if (url.includes('/api/settings')) {
      // No configured folders: only the library button is offered.
      return Promise.resolve({
        ok: true,
        json: async () => ({ paths: { path_4k: '', path_3d: '' } }),
      } as Response)
    }
    if (url.includes('/api/calendar/grab')) {
      return Promise.resolve(grab())
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

// The modal reads the indexer list through react-query, so it needs a client.
function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 411, title: 'Everything Everywhere All at Once', source: 'radarr' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

async function openAndPress() {
  renderModal()

  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
  await screen.findByPlaceholderText('Filtrar por título...')
  fireEvent.click(screen.getByRole('button', { name: /Biblioteca/ }))
}

describe('grab error feedback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the real failure reason, not a shrug', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ ok: false, detail: CACHE_ERROR }),
    } as Response))

    await openAndPress()

    await waitFor(() => expect(screen.getByText(CACHE_ERROR)).toBeInTheDocument())
  })

  it('tells the user to re-enter the key when it is rejected', async () => {
    // apiFetch handles the 401 centrally (it clears the key and prompts for it),
    // so the client reports what to do instead of the raw response body.
    mockFetch(() => ({ ok: false, status: 401, json: async () => ({}) } as Response))

    await openAndPress()

    await waitFor(() =>
      expect(screen.getByText(/API key rechazada/)).toBeInTheDocument(),
    )
  })

  it('reports a transport failure instead of hanging on "Descargando"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/calendar/indexers')) {
          return Promise.resolve({ ok: true, json: async () => indexers } as Response)
        }
        if (url.includes('/api/calendar/releases')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ releases: [release], detail: 'ok' }),
          } as Response)
        }
        if (url.includes('/api/settings')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ paths: { path_4k: '', path_3d: '' } }),
          } as Response)
        }
        return Promise.reject(new TypeError('Failed to fetch'))
      }),
    )

    await openAndPress()

    await waitFor(() =>
      expect(screen.getByText(/No se pudo contactar con el servidor/)).toBeInTheDocument(),
    )
  })

  it('lets the user get back to the results after a failure', async () => {
    let failing = true
    mockFetch(() =>
      failing
        ? ({
            ok: true,
            json: async () => ({ ok: false, detail: CACHE_ERROR }),
          } as Response)
        : ({
            ok: true,
            json: async () => ({ ok: true, detail: 'Release encolado para descarga' }),
          } as Response),
    )

    await openAndPress()
    await waitFor(() => expect(screen.getByText(CACHE_ERROR)).toBeInTheDocument())

    // A failed grab must not leave the user stuck on the error screen.
    fireEvent.click(screen.getByRole('button', { name: /Volver a los resultados/ }))
    await waitFor(() => expect(screen.getByPlaceholderText('Filtrar por título...')).toBeInTheDocument())

    failing = false
    fireEvent.click(screen.getByRole('button', { name: /Biblioteca/ }))
    await waitFor(() =>
      expect(screen.getByText('Release encolado para descarga')).toBeInTheDocument(),
    )
  })
})

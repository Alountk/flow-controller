import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ReleaseSearchModal } from '../components/ReleaseSearchModal'
import type { Release } from '../api/calendar'

/**
 * Regression tests for grab error feedback.
 *
 * The batch endpoint used to collapse every per-release failure into a count
 * ("0 OK, 1 errores"), so the UI hid the actual reason. The real reason lives in
 * `errors[]` and must reach the user: without it "no funciona" is all anyone can
 * say.
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

function mockFetch(grabBatch: () => Response | Promise<Response>) {
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
    if (url.includes('/api/calendar/grab-batch')) {
      return Promise.resolve(grabBatch())
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

async function openAndSelect() {
  render(
    <ReleaseSearchModal
      item={{ type: 'movie', id: 411, title: 'Everything Everywhere All at Once', source: 'radarr' }}
      onClose={() => {}}
    />,
  )

  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
  const selectAll = await screen.findByRole('checkbox', { name: /1 releases encontrados/ })
  fireEvent.click(selectAll)
  fireEvent.click(screen.getByRole('button', { name: /Descargar \(1\)/ }))
}

describe('grab batch error feedback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the real per-release reason, not just a count', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        ok: false,
        detail: `0 OK, 1 errores: ${CACHE_ERROR}`,
        downloaded: [],
        errors: [{ guid: 'guid-1', detail: CACHE_ERROR }],
      }),
    }) as Response)

    await openAndSelect()

    await waitFor(() => expect(screen.getByText(CACHE_ERROR)).toBeInTheDocument())
  })

  it('lists every failed release when several fail', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        ok: false,
        detail: '0 OK, 2 errores',
        downloaded: [],
        errors: [
          { guid: 'a', detail: 'Primer motivo' },
          { guid: 'b', detail: 'Segundo motivo' },
        ],
      }),
    }) as Response)

    await openAndSelect()

    await waitFor(() => expect(screen.getByText('Primer motivo')).toBeInTheDocument())
    expect(screen.getByText('Segundo motivo')).toBeInTheDocument()
  })

  it('caps a long error list and reports the remainder', async () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({ guid: `g${i}`, detail: `motivo ${i}` }))
    mockFetch(() => ({
      ok: true,
      json: async () => ({ ok: false, detail: '0 OK, 8 errores', downloaded: [], errors }),
    }) as Response)

    await openAndSelect()

    await waitFor(() => expect(screen.getByText('motivo 0')).toBeInTheDocument())
    expect(screen.queryByText('motivo 7')).not.toBeInTheDocument()
    expect(screen.getByText('…y 3 más')).toBeInTheDocument()
  })

  it('tells the user to re-enter the key when it is rejected', async () => {
    // apiFetch handles the 401 centrally (it clears the key and prompts for it),
    // so the client reports what to do instead of the raw response body.
    mockFetch(() => ({ ok: false, status: 401, json: async () => ({}) }) as Response)

    await openAndSelect()

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
        return Promise.reject(new TypeError('Failed to fetch'))
      }),
    )

    await openAndSelect()

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
            json: async () => ({
              ok: false,
              detail: '0 OK, 1 errores',
              downloaded: [],
              errors: [{ guid: 'guid-1', detail: CACHE_ERROR }],
            }),
          } as Response)
        : ({
            ok: true,
            json: async () => ({ ok: true, detail: '1 descargados', downloaded: ['guid-1'], errors: [] }),
          } as Response),
    )

    await openAndSelect()
    await waitFor(() => expect(screen.getByText(CACHE_ERROR)).toBeInTheDocument())

    // A failed grab must not leave the user stuck on the error screen.
    fireEvent.click(screen.getByRole('button', { name: /Volver a los resultados/ }))
    await waitFor(() => expect(screen.getByPlaceholderText('Filtrar por título...')).toBeInTheDocument())

    failing = false
    fireEvent.click(screen.getByRole('button', { name: /Refrescar/ }))
    await waitFor(() => expect(screen.queryByText(CACHE_ERROR)).not.toBeInTheDocument())
  })
})

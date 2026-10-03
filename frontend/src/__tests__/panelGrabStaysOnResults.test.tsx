import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal, type ReleaseSearchItem } from '../components/ReleaseSearchModal'
import type { Release } from '../api/calendar'

/**
 * The maintainer's complaint, pinned: "puse uno a descargar y no me deja
 * coger otro" — after a grab the panel used to leave the results for a done
 * step, and the only way back dropped the cache and re-asked the indexer for
 * data it had answered seconds ago.
 *
 * What is pinned here, PANEL ONLY:
 *   1. a successful grab (BOTH paths: batch button and row click) STAYS on
 *      the results — the ack rides above the list that never left;
 *   2. the exit that used to discard the list ("Nueva búsqueda") is gone;
 *   3. a re-open restores the results WITHOUT a new search (PR B's guard);
 *   4. a plain results render has no status box and no stale search text;
 *   5. the error path returns to the same list with zero network calls;
 *   6. the overlay keeps its dialog ending byte for byte (done + Cerrar).
 */

const release: Release = {
  guid: 'rel-panel-1',
  title: 'Alpha.2024.1080p.BluRay.x264-GRP',
  size: 5_000_000_000,
  quality: 'Bluray-1080p',
  indexer: 'aMuTorrent',
  indexerId: 1,
  indexerFlags: '',
  seeders: 12,
  leechers: 1,
  protocol: 'torrent',
  releaseGroup: '',
  languages: ['Spanish'],
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** Every endpoint the inline search can reach. `batchOk` flips only the grab
 *  answer, so the failure path is one argument away. */
function stubFetch(batchOk = true) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return ok({
        indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
      })
    }
    if (url.includes('/api/calendar/releases')) {
      return ok({ releases: [release], detail: '1 releases encontrados' })
    }
    // grab-batch BEFORE grab: the single path's URL is a substring of it.
    if (url.includes('/api/calendar/grab-batch')) {
      return batchOk
        ? ok({ ok: true, detail: '1 descargados', downloaded: [release.guid], errors: [] })
        : ok({
            ok: false,
            detail: '0 OK, 1 errores: boom',
            downloaded: [],
            errors: [{ guid: release.guid, detail: 'boom' }],
          })
    }
    if (url.includes('/api/calendar/grab')) {
      return ok({ ok: true, detail: 'Descarga iniciada' })
    }
    if (url.includes('/api/calendar/destinations')) {
      return ok({ folders: [], arr_available: true, detail: '' })
    }
    if (url.includes('/api/settings')) {
      return ok({ paths: { path_4k: '', path_3d: '' } })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof stubFetch>

/** Searches the panel actually asked the indexer for. */
function searchCalls(fn: FetchMock): number {
  return fn.mock.calls.filter(([input]) => String(input).includes('/api/calendar/releases')).length
}

/** A distinct id per test: the results cache is module-level and keyed by
 *  source/type/id, so each test must meet a cache of its own. */
function item(id: number): ReleaseSearchItem {
  return { type: 'movie', id, title: 'Película de prueba', source: 'radarr', has_file: false }
}

function renderPanel(id: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal presentation="panel" item={item(id)} />
    </QueryClientProvider>,
  )
}

function renderOverlay(id: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal item={item(id)} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

const resultsReady = () => screen.findByPlaceholderText('Filtrar por título...')

const selectAll = () => screen.findByRole('checkbox', { name: /1 releases encontrados/ })

async function openResultsAndGrabBatch(fn: FetchMock) {
  await resultsReady()
  expect(searchCalls(fn)).toBe(1)
  fireEvent.click(await selectAll())
  fireEvent.click(screen.getByRole('button', { name: /Descargar \(1\)/ }))
}

describe('panel · a grab leaves the results alone', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stays on the results after a batch grab, ack above the list, exit gone', async () => {
    const fn = stubFetch()
    renderPanel(7101)
    await openResultsAndGrabBatch(fn)

    // The ack lands ABOVE a list that never left — in that order.
    await screen.findByText('1 descargados')
    expect(screen.getByText(release.title)).toBeInTheDocument()
    const status = document.querySelector('.calendar-modal-status')
    const list = document.querySelector('.calendar-releases')
    expect(status).not.toBeNull()
    expect(list).not.toBeNull()
    expect(
      (status as Node).compareDocumentPosition(list as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    // The exit that used to trade this list for a re-search is gone…
    expect(screen.queryByRole('button', { name: 'Nueva búsqueda' })).toBeNull()
    // …and so is the selection it used to reset: the next tick starts clean.
    expect(screen.queryByRole('button', { name: /Descargar \(/ })).toBeNull()

    // The grab returned: nothing is processing any more.
    expect(screen.getByRole('button', { name: /Refrescar/ })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: /Indexador/ })).toBeEnabled()
  })

  it('does the same on the row-click grab — the common path', async () => {
    stubFetch()
    renderPanel(7102)
    await resultsReady()

    fireEvent.click(document.querySelector('.release-content') as HTMLElement)

    await screen.findByText(/Descarga iniciada/)
    expect(screen.getByText(release.title)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Nueva búsqueda' })).toBeNull()
    expect(screen.getByRole('button', { name: /Refrescar/ })).toBeEnabled()
  })

  it('restores the results on a re-open WITHOUT asking the indexer again', async () => {
    const fn = stubFetch()
    const first = renderPanel(7103)
    await openResultsAndGrabBatch(fn)
    await screen.findByText('1 descargados')

    // The view unmounts (a tab switch) and comes back around the SAME item.
    first.unmount()
    renderPanel(7103)

    await resultsReady()
    expect(screen.getByText('1 releases encontrados')).toBeInTheDocument()
    expect(screen.getByText(release.title)).toBeInTheDocument()
    // PR B's guard keys off step === 'initial'; a restored mount lands on
    // 'results', so the search that already returned must not run again.
    expect(searchCalls(fn)).toBe(1)
  })

  it('renders a plain results with no status box and no stale search text', async () => {
    stubFetch()
    renderPanel(7104)
    await resultsReady()

    expect(document.querySelector('.calendar-modal-status')).toBeNull()
    expect(screen.queryByText(/Buscando releases/)).toBeNull()
    expect(screen.getByText('1 releases encontrados')).toBeInTheDocument()
  })

  it('takes the ack away again when a refresh replaces the list it described', async () => {
    const fn = stubFetch()
    renderPanel(7107)
    await openResultsAndGrabBatch(fn)
    await screen.findByText('1 descargados')

    fireEvent.click(screen.getByRole('button', { name: /Refrescar/ }))
    await waitFor(() => expect(searchCalls(fn)).toBe(2))
    await resultsReady()

    expect(screen.queryByText('1 descargados')).toBeNull()
    expect(screen.queryByText(/Buscando releases/)).toBeNull()
    expect(screen.getByText('1 releases encontrados')).toBeInTheDocument()
  })
})

describe('panel · the error path still offers the list, without a search', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns to the same list after a failed grab, zero network calls', async () => {
    const fn = stubFetch(false)
    renderPanel(7105)
    await openResultsAndGrabBatch(fn)

    // The failure reaches the user on the error step…
    fireEvent.click(await screen.findByRole('button', { name: /Volver a los resultados/ }))
    // …and the way back is the SAME list: no search, no stale error box.
    await resultsReady()
    expect(screen.getByText(release.title)).toBeInTheDocument()
    expect(searchCalls(fn)).toBe(1)
    expect(screen.queryByText('boom')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Nueva búsqueda' })).toBeNull()
  })
})

describe('overlay · the dialog keeps its own ending, byte for byte', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ends on the done step with Cerrar and the list behind it gone', async () => {
    stubFetch()
    renderOverlay(7106)

    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    fireEvent.click(await selectAll())
    fireEvent.click(screen.getByRole('button', { name: /Descargar \(1\)/ }))

    await screen.findByText('1 descargados')
    expect(screen.getByRole('button', { name: 'Cerrar' })).toBeInTheDocument()
    // The dialog traded the list for the done step, as it always has.
    expect(screen.queryByText(release.title)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Nueva búsqueda' })).toBeNull()
  })
})

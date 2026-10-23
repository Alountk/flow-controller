import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IndexadoresSection } from '../../../features/settings/IndexadoresSection.tsx'
import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'

/**
 * The unified search box («indexadores-directos» T6/S5-S6, the L6 amendment):
 * one query over Torznab + aMule + Prowlarr, per-source honest states, and a
 * «Descargar» that goes to `POST /api/indexers/download` — NEVER
 * `POST /api/calendar/grab`, which needs an arr service and a movieId the
 * free-search rows do not have.
 *
 * Honesty rules pinned here:
 * - a skipped source always names itself AND its reason («{fuente}: {razón}»),
 *   never a silent empty;
 * - «Sin resultados» only when every selected source really answered;
 * - a total failure says «Error: …», never «Sin resultados»;
 * - the download button cannot double-fire (jsdom clicks disabled buttons,
 *   so the guard is `onClick={pending ? undefined : fn}`).
 */

type RouteHandler = (body: Record<string, unknown> | null) => unknown

function mockFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const handler = routes[`${method} ${url}`]
    if (!handler) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    return Promise.resolve({ ok: true, status: 200, json: async () => handler(body) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <IndexadoresSection />
    </QueryClientProvider>,
  )
}

async function runSearch(query = 'matrix') {
  fireEvent.change(await screen.findByLabelText('Texto a buscar'), { target: { value: query } })
  fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const HAPPY = {
  ok: true,
  results: [
    { source: 'torznab', indexer: 'NoNaMe', name: 'Matrix 1999 1080p', size: 1000, seeders: 5, link: 'ed2k://|file|Matrix|1000|AAAA|/' },
    { source: 'torznab', indexer: 'NoNaMe', name: 'Matrix Reloaded 2003', size: 2000, guid: '32hexguid' },
    { source: 'amule', name: 'Matrix Revolutions', size: 3000, sources: 4, guid: 'aa'.repeat(16), link: 'ed2k://|file|Revolutions|3000|BBBB|/' },
    { source: 'prowlarr', name: 'Matrix Resurrections', size: 4000, link: 'magnet:?xt=urn:btih:cafe' },
  ],
  skipped: [],
}

describe('unified indexer search box', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('offers all three sources selected by default and searches the selection', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => HAPPY,
    })
    renderSection()

    for (const source of ['torznab', 'amule', 'prowlarr']) {
      expect(await screen.findByRole('button', { name: source })).toHaveAttribute('aria-pressed', 'true')
    }

    await runSearch('matrix')

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers/search' && init?.method === 'POST',
      )
      expect(post).toBeTruthy()
    })
    const post = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers/search' && init?.method === 'POST',
    )
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      query: 'matrix',
      sources: ['torznab', 'amule', 'prowlarr'],
    })
  })

  it('groups results with per-source counts', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => HAPPY,
    })
    renderSection()

    await runSearch()

    // Count chips per source…
    expect(await screen.findByText('torznab (2)')).toBeInTheDocument()
    expect(screen.getByText('amule (1)')).toBeInTheDocument()
    expect(screen.getByText('prowlarr (1)')).toBeInTheDocument()
    expect(screen.getByText('Todas (4)')).toBeInTheDocument()
    // …and grouped rows with their own counts (exact texts: the count chips
    // above share the `amule (1)` substring with the group headers).
    expect(await screen.findByText('🌐 NoNaMe (2)')).toBeInTheDocument()
    expect(screen.getByText('🌐 amule (1)')).toBeInTheDocument()
    expect(screen.getByText('🌐 prowlarr (1)')).toBeInTheDocument()
    expect(screen.getByText('Matrix 1999 1080p')).toBeInTheDocument()
    expect(screen.getByText(/4 fuentes/)).toBeInTheDocument()
  })

  it('renders every skipped source with its reason, never a silent empty', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => ({
        ok: true,
        results: [],
        skipped: [
          { source: 'prowlarr', reason: 'Prowlarr no está configurado' },
          { source: 'amule', reason: 'aMule no responde' },
        ],
      }),
    })
    renderSection()

    await runSearch()

    expect(await screen.findByText('prowlarr: Prowlarr no está configurado')).toBeInTheDocument()
    expect(screen.getByText('amule: aMule no responde')).toBeInTheDocument()
    // The source that DID answer says so instead of hiding behind the skips.
    expect(screen.getByText('torznab: Sin resultados')).toBeInTheDocument()
  })

  it('shows «Sin resultados» when every source answered and none had rows', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => ({ ok: true, results: [], skipped: [] }),
    })
    renderSection()

    await runSearch()

    expect(await screen.findByText('Sin resultados')).toBeInTheDocument()
  })

  it('reports a total failure as Error, never as «Sin resultados»', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => ({
        ok: false,
        results: [],
        skipped: [{ source: 'torznab', reason: 'sin indexadores habilitados' }],
        detail: 'todas las fuentes seleccionadas fallaron — torznab: sin indexadores habilitados',
      }),
    })
    renderSection()

    await runSearch()

    expect(await screen.findByRole('alert')).toHaveTextContent(/Error: todas las fuentes/)
    expect(screen.queryByText('Sin resultados')).not.toBeInTheDocument()
  })

  it('download sends link ?? guid and reports the outcome as a toast', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => HAPPY,
      'POST /api/indexers/download': (body) => {
        // The guid-only row («Matrix Reloaded 2003») proves `link ?? guid`.
        if (body?.guid) return { ok: true, detail: 'Descarga añadida' }
        return { ok: false, detail: 'aMuTorrent no aceptó la descarga: rechazada' }
      },
    })
    renderSection()

    await runSearch()
    const buttons = await screen.findAllByRole('button', { name: 'Descargar' })

    // Row 0 has a link: it must travel as `link`.
    fireEvent.click(buttons[0])
    await waitFor(() => expect(getToasts()).toHaveLength(1))
    const linkCall = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers/download' && init?.method === 'POST',
    )
    expect(JSON.parse(String(linkCall![1]?.body))).toEqual({ link: HAPPY.results[0].link })
    expect(getToasts()[0]).toMatchObject({ message: 'aMuTorrent no aceptó la descarga: rechazada', tone: 'error' })

    // Row 1 has no link: the guid is the target.
    fireEvent.click(buttons[1])
    await waitFor(() => expect(getToasts()).toHaveLength(2))
    const guidCall = fn.mock.calls.filter(
      ([input]) => String(input) === '/api/indexers/download',
    )[1]
    expect(JSON.parse(String(guidCall![1]?.body))).toEqual({ guid: '32hexguid' })
    expect(getToasts()[1]).toMatchObject({ message: 'Descarga añadida', tone: 'ok' })
  })

  it('the download button cannot double-fire', async () => {
    const gate = deferred<Record<string, unknown>>()
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => HAPPY,
      'POST /api/indexers/download': () => gate.promise,
    })
    renderSection()

    await runSearch()
    const button = (await screen.findAllByRole('button', { name: 'Descargar' }))[0]

    fireEvent.click(button)
    fireEvent.click(button)

    // While pending the handler is GONE (not `disabled` — jsdom still fires
    // clicks on disabled buttons) and the label says what is happening.
    await waitFor(() => expect(button).toHaveTextContent('Descargando…'))
    expect(
      fn.mock.calls.filter(([input]) => String(input) === '/api/indexers/download'),
    ).toHaveLength(1)

    gate.resolve({ ok: true, detail: 'Descarga añadida' })
    await waitFor(() => expect(getToasts()).toHaveLength(1))
  })
})

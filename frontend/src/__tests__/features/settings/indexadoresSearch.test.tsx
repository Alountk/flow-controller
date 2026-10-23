import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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
 * config-1x1 T4 (S2) lleva la tarjeta a fidelidad ESTRICTA con
 * `stitch-13-indexadores.html`: campo con placeholder del diseño, chips de
 * fuente con conteos, resultados agrupados por FUENTE con los títulos del
 * diseño y los estados honestos al pie. Comportamiento INTACTO: mismo
 * endpoint, mismos skipped con su motivo, mismo doble-guard.
 *
 * Adaptaciones documentadas (S3 — sólo por el cambio estructural, SIN aflojar):
 *  - el campo de búsqueda se nombra por el literal del diseño (antes label
 *    «Texto a buscar»): mismo input, misma cadena de búsqueda;
 *  - los conteos de los chips viven ahora en su badge del diseño
 *    («torznab 2», antes texto «torznab (2)»): mismo número, misma fuente;
 *  - los grupos son por FUENTE con los títulos del diseño (antes por
 *    indexador, «🌐 NoNaMe (2)»); el indexador de cada fila viaja ahora en su
 *    badge — misma información, más la agrupación que pide el diseño;
 *  - el pie del diseño separa la fuente en negrita del motivo y añade
 *    «(fuente omitida)»: la cadena completa se reafirma sobre textContent
 *    (mismo patrón que la nota de la tarjeta aMule de T3), SIN aflojar.
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
  // ADAPTADO (config-1x1 T4/S3): el campo lleva el literal del diseño
  // («Buscar en todas las fuentes…») como placeholder y nombre accesible.
  fireEvent.change(await screen.findByLabelText('Buscar en todas las fuentes…'), {
    target: { value: query },
  })
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

    // Count chips per source — ADAPTADO (T4/S3): el conteo vive en el badge
    // del chip del diseño (nombre accesible «torznab 2», antes texto
    // «torznab (2)»): mismo número por fuente, más el total de «Todas».
    expect(await screen.findByRole('button', { name: 'torznab 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'amule 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'prowlarr 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Todas 4' })).toBeInTheDocument()
    // …and grouped rows with their own counts — ADAPTADO (T4/S3): los grupos
    // son por FUENTE con los títulos del diseño (antes por indexador,
    // «🌐 NoNaMe (2)»); el indexador de cada fila viaja ahora en su badge.
    const torznabGroup = (await screen.findByText('Resultados Torznab directos')).closest(
      '.indexadores-group',
    ) as HTMLElement
    expect(within(torznabGroup).getByText('2')).toBeInTheDocument()
    const amuleGroup = screen
      .getByText('Resultados daemon aMule (eD2k/Kad)')
      .closest('.indexadores-group') as HTMLElement
    expect(within(amuleGroup).getByText('1')).toBeInTheDocument()
    const prowlarrGroup = screen
      .getByText('Resultados de Prowlarr')
      .closest('.indexadores-group') as HTMLElement
    expect(within(prowlarrGroup).getByText('1')).toBeInTheDocument()
    expect(screen.getAllByText('NoNaMe')).toHaveLength(2)
    expect(screen.getByText('Matrix 1999 1080p')).toBeInTheDocument()
    // ADAPTADO (T4/S3): la métrica del diseño nombra primero la fuente
    // («fuentes: 4», antes «4 fuentes»): mismo número, mismo concepto.
    expect(screen.getByText('fuentes: 4')).toBeInTheDocument()
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

    // ADAPTADO (config-1x1 T4/S3): el pie del diseño separa la fuente en
    // negrita del motivo y añade «(fuente omitida)»; la cadena completa se
    // reafirma sobre textContent (mismo patrón que T3, sin aflojar): fuente
    // Y motivo siguen siendo obligatorios.
    const skipLine = await screen.findByText('prowlarr:')
    const foot = skipLine.closest('.indexadores-search-statuses') as HTMLElement
    expect(foot).toHaveTextContent('prowlarr: Prowlarr no está configurado — (fuente omitida)')
    expect(foot).toHaveTextContent('amule: aMule no responde — (fuente omitida)')
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

describe('búsqueda unificada — estructura del diseño (config-1x1 T4/S2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('renders the design search field, «Buscar» and the source chips with counts', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers/search': () => HAPPY,
    })
    renderSection()

    await screen.findByLabelText('Buscar en todas las fuentes…')
    expect(screen.getByRole('button', { name: 'Buscar' })).toBeInTheDocument()

    // Chips de fuente con conteos — literal del diseño (emoji decorativo, sin
    // contaminar el nombre accesible) y label «Fuentes:».
    const chips = document.querySelector('.indexadores-source-chips') as HTMLElement
    expect(chips).not.toBeNull()
    within(chips).getByText('Fuentes:')
    within(chips).getByText('🌐')
    within(chips).getByText('📥')
    within(chips).getByText('🔍')
    for (const source of ['torznab', 'amule', 'prowlarr']) {
      expect(within(chips).getByRole('button', { name: source })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    }

    await runSearch()

    // Los conteos son los RESULTADOS de esta búsqueda (esperar a que lleguen).
    await screen.findByRole('button', { name: 'torznab 2' })

    // El pie de estados honestos del diseño, al final de la tarjeta.
    expect(document.querySelector('.indexadores-search-statuses')).not.toBeNull()
  })
})

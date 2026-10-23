import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IndexadoresSection } from '../../../features/settings/IndexadoresSection.tsx'

/**
 * «Categorías» as a checkbox grid («config-submenu» T4/S3, verbatim L2: «las
 * caegorias delos idnexadores deberia deberia ser un seleccionable con
 * checkbox»). The contract this file pins:
 *
 * 1. «Todas (sin filtro)» is checked by default and is EXCLUSIVE: checking it
 *    unchecks every specific box; checking any specific one unchecks «Todas»;
 *    unchecking the last specific one returns to «Todas» — and there is NO
 *    state where nothing is checked;
 * 2. the submit shape is UNCHANGED: `categories` stays a comma-joined csv
 *    string (POST/PUT, backend untouched). Only «Todas» → `''`; a subset →
 *    csv in the fixed list order (stable, not click order);
 * 3. edit-load round-trips with NO data loss: csv ids become checked boxes,
 *    and ids outside the standard list (custom 100xxx) SURVIVE — rendered as
 *    «{id} (personalizada)» and kept in the submitted csv. Dropping a user's
 *    stored id would be data loss;
 * 4. «Probar»/«Guardar cambios» flows keep working and the save payload still
 *    carries `{categories}`.
 *
 * config-1x1 T4 (S2): la rejilla conserva esta lógica BYTE a BYTE y sólo
 * cambia de presentación — clases en `Settings.css` (4 columnas, casilla +
 * nombre + id), CERO inline styles. Adaptaciones documentadas (S3, sin
 * aflojar): la cabecera del panel trae otro botón «Añadir indexador» (el del
 * diseño), así que el submit se acota a la tarjeta «Nuevo indexador».
 */

type RouteHandler = (body: Record<string, unknown> | null) => unknown

/** Dispatch on `METHOD /path` exactly the way the section calls the API. */
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

/** The 12 standard boxes — name + id visible on every label (S3). */
const STANDARD = [
  'Películas 2000',
  'Películas HD 2010',
  '3D 2020',
  'Remux 2045',
  'Series 5000',
  'Series HD 5010',
  'Anime 5070',
  'Documentales 5040',
  'Música 3000',
  'Audiolibros 3030',
  'Libros 4000',
  'Consola 1000',
]

function box(name: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name }) as HTMLInputElement
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: 'NoNaMe',
    url: 'http://indexer.test/torznab/api',
    api_key: '****9876',
    categories: '',
    enabled: 1,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

/** ADAPTADO (config-1x1 T4/S3): el submit del formulario vive dentro de la
 *  tarjeta «Nuevo indexador» (la cabecera del panel trae otro botón con el
 *  mismo nombre). Misma acción, mismo payload. */
function clickSubmit(name: 'Añadir indexador' | 'Guardar cambios') {
  const card = screen
    .getByRole('heading', { name: /Nuevo indexador|Editar indexador/ })
    .closest('.indexadores-card') as HTMLElement
  fireEvent.click(within(card).getByRole('button', { name }))
}

describe('indexadores — «Categorías» checkbox grid (T4/S3)', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to «Todas (sin filtro)» checked with every specific box unchecked', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    expect(await screen.findByRole('group', { name: 'Categorías' })).toBeInTheDocument()
    expect(box('Todas (sin filtro)')).toBeChecked()
    for (const name of STANDARD) {
      expect(box(name)).not.toBeChecked()
    }
  })

  it('checking a specific category unchecks «Todas»', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Películas 2000' }))
    expect(box('Películas 2000')).toBeChecked()
    expect(box('Todas (sin filtro)')).not.toBeChecked()
  })

  it('checking «Todas» unchecks every specific one', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Películas 2000' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Series 5000' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Consola 1000' }))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Todas (sin filtro)' }))
    expect(box('Todas (sin filtro)')).toBeChecked()
    for (const name of ['Películas 2000', 'Series 5000', 'Consola 1000']) {
      expect(box(name)).not.toBeChecked()
    }
  })

  it('unchecking the last specific category returns to «Todas»', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Anime 5070' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Música 3000' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Anime 5070' }))
    expect(box('Música 3000')).toBeChecked()
    expect(box('Todas (sin filtro)')).not.toBeChecked()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Música 3000' }))
    expect(box('Todas (sin filtro)')).toBeChecked()
    expect(box('Música 3000')).not.toBeChecked()
  })

  it('cannot reach a state where nothing is checked — clicking checked «Todas» keeps it', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Todas (sin filtro)' }))
    expect(box('Todas (sin filtro)')).toBeChecked()
  })

  it('renders the grid as design CSS classes — 4 columnas, casilla + nombre + id', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    const group = await screen.findByRole('group', { name: 'Categorías' })
    expect(group).toHaveClass('indexadores-category-grid')
    // «casilla + nombre + id» en cada etiqueta (ya pinneado arriba por nombre).
    expect(box('Películas 2000')).toBeInTheDocument()
    expect(box('Consola 1000')).toBeInTheDocument()
    // CERO inline styles en la tarjeta nueva (la rejilla deja de ser plan B).
    const card = group.closest('.indexadores-card') as HTMLElement
    expect(card.querySelector('[style]')).toBeNull()
  })

  it('submitting with only «Todas» sends categories: ""', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers': () => ({ ok: true, indexer: row({ id: 3 }) }),
    })
    renderSection()

    clickSubmit('Añadir indexador')

    const post = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers' && init?.method === 'POST',
    )
    expect(post).toBeTruthy()
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      name: '',
      url: '',
      api_key: '',
      categories: '',
    })
  })

  it('submitting a subset sends a stable csv in list order, not click order', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: [] }),
      'POST /api/indexers': () => ({ ok: true, indexer: row({ id: 3 }) }),
    })
    renderSection()

    // Clicked in reverse list order on purpose — the csv must not care.
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Consola 1000' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Anime 5070' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Películas 2000' }))
    clickSubmit('Añadir indexador')

    const post = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers' && init?.method === 'POST',
    )
    expect(post).toBeTruthy()
    expect((JSON.parse(String(post![1]?.body)) as { categories: string }).categories).toBe(
      '2000,5070,1000',
    )
  })

  it('edit load checks the csv ids and renders unknown ids as «{id} (personalizada)»', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: [row({ categories: '2000,5070,100000' })] }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar NoNaMe' }))

    expect(box('Películas 2000')).toBeChecked()
    expect(box('Anime 5070')).toBeChecked()
    expect(box('Todas (sin filtro)')).not.toBeChecked()
    // The custom id is NOT dropped: it gets its own checked entry.
    expect(box('100000 (personalizada)')).toBeChecked()
  })

  it('a custom id survives the round-trip — the save keeps it in the csv', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: [row({ categories: '2000,5070,100000' })] }),
      'PUT /api/indexers/1': () => ({ ok: true, indexer: row({ categories: '2000,5070,100000' }) }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar NoNaMe' }))
    // Re-checking another box and saving must not evict the custom id.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Series 5000' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    const put = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
    )
    expect(put).toBeTruthy()
    expect(JSON.parse(String(put![1]?.body))).toEqual({
      name: 'NoNaMe',
      url: 'http://indexer.test/torznab/api',
      api_key: '',
      categories: '2000,5000,5070,100000',
    })
  })

  it('an empty csv loads as «Todas» checked', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [row({ categories: '' })] }) })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar NoNaMe' }))

    expect(box('Todas (sin filtro)')).toBeChecked()
    expect(box('Películas 2000')).not.toBeChecked()
  })

  it('«Probar» still probes and «Guardar cambios» sends {categories} from the grid', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: [row({ categories: '2000' })] }),
      'POST /api/indexers/1/test': () => ({
        ok: true,
        caps: { searches: { search: { available: true } }, categories: [{ id: 2000, name: 'Movies' }] },
      }),
      'PUT /api/indexers/1': () => ({ ok: true, indexer: row({ categories: '2000,5000' }) }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar NoNaMe' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Series 5000' }))

    fireEvent.click(screen.getByRole('button', { name: 'Probar NoNaMe' }))
    expect(await screen.findByText(/capabilities recibidas/)).toBeInTheDocument()
    expect(
      fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers/1/test' && init?.method === 'POST',
      ),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    const put = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
    )
    expect(put).toBeTruthy()
    expect(JSON.parse(String(put![1]?.body))).toEqual({
      name: 'NoNaMe',
      url: 'http://indexer.test/torznab/api',
      api_key: '',
      categories: '2000,5000',
    })
  })
})

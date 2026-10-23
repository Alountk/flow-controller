import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IndexadoresSection } from '../../../features/settings/IndexadoresSection.tsx'

/**
 * «Indexadores» — the CRUD half of the section («indexadores-directos» T6/S5).
 *
 * What this panel has to get right, in order of how badly it fails otherwise:
 *
 * 1. the api_key renders MASKED and an empty edit field keeps the stored key —
 *    the backend contract (`routes/indexers.py` S3) and the historic bug of
 *    saving the mask back over the real credential;
 * 2. «Probar» reports the probe's own truth — caps on success, the Spanish
 *    `detail` on failure — never a silent button;
 * 3. delete asks for confirmation before anything leaves (repo pattern),
 *    because a deleted indexer silently shrinks every future search.
 */

const LIST = [
  {
    id: 1,
    name: 'NoNaMe',
    url: 'http://indexer.test/torznab/api',
    api_key: '****9876',
    categories: '2000,100000',
    enabled: 1,
    created_at: 1700000000,
    updated_at: 1700000000,
  },
  {
    id: 2,
    name: 'Elite',
    url: 'http://elite.test/torznab/api',
    api_key: '****1234',
    categories: '',
    enabled: 0,
    created_at: 1700000000,
    updated_at: 1700000000,
  },
]

type RouteHandler = (body: Record<string, unknown> | null) => unknown

/** Dispatch on `METHOD /path` exactly the way the section calls the API. */
function mockFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`
    const handler = routes[key]
    if (!handler) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const answer = handler(body)
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve({ ok: true, status: 200, json: async () => answer } as Response)
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

describe('indexers section — the registry', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('renders the list with masked keys and an honest empty state', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    expect(await screen.findByText('NoNaMe')).toBeInTheDocument()
    expect(screen.getByText('Elite')).toBeInTheDocument()
    // The masked key — the only shape a response may ever carry.
    expect(screen.getByText('****9876')).toBeInTheDocument()
    expect(screen.getByText('http://indexer.test/torznab/api')).toBeInTheDocument()
    // Enabled state is visible per row.
    expect(screen.getByRole('button', { name: 'Habilitado de NoNaMe' })).toHaveTextContent('Sí')
    expect(screen.getByRole('button', { name: 'Habilitado de Elite' })).toHaveTextContent('No')
  })

  it('says so plainly when there are no indexers at all', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    expect(await screen.findByText(/No hay indexadores/)).toBeInTheDocument()
  })

  it('the add form posts a new indexer', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'POST /api/indexers': () => ({ ok: true, indexer: { ...LIST[0], id: 3, name: 'Ivy' } }),
    })
    renderSection()

    fireEvent.change(await screen.findByLabelText('Nombre del indexador'), {
      target: { value: 'Ivy' },
    })
    fireEvent.change(screen.getByLabelText('URL del indexador'), {
      target: { value: 'http://ivy.test/torznab/api' },
    })
    fireEvent.change(screen.getByLabelText('API Key del indexador'), {
      target: { value: 'secret-key' },
    })
    fireEvent.change(screen.getByLabelText('Categorías (separadas por coma)'), {
      target: { value: '2000,100000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir indexador' }))

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers' && init?.method === 'POST',
      )
      expect(post).toBeTruthy()
    })
    const post = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers' && init?.method === 'POST',
    )
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      name: 'Ivy',
      url: 'http://ivy.test/torznab/api',
      api_key: 'secret-key',
      categories: '2000,100000',
    })
    expect(await screen.findByRole('status')).toHaveTextContent(/añadido/i)
  })

  it('toggling enabled sends a PUT with the flipped flag', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'PUT /api/indexers/1': () => ({ ok: true, indexer: { ...LIST[0], enabled: 0 } }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Habilitado de NoNaMe' }))

    await waitFor(() => {
      const put = fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
      )
      expect(put).toBeTruthy()
      expect(JSON.parse(String(put![1]?.body))).toEqual({ enabled: false })
    })
  })

  it('«Probar» shows the caps on success and the detail on failure', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'POST /api/indexers/1/test': () => ({
        ok: true,
        caps: { searches: { search: { available: true } }, categories: [{ id: 2000, name: 'Movies' }] },
      }),
      'POST /api/indexers/2/test': () => ({
        ok: false,
        detail: 'timeout leyendo las capabilities',
      }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar NoNaMe' }))
    expect(await screen.findByText(/capabilities recibidas/)).toBeInTheDocument()
    expect(screen.getByText(/Movies/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Probar Elite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/timeout leyendo las capabilities/)
  })

  it('editing keeps the stored key when the field is left empty', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'PUT /api/indexers/1': () => ({ ok: true, indexer: LIST[0] }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar NoNaMe' }))

    // The secret is never pre-filled: «(sin cambio)» means keep.
    const keyInput = screen.getByPlaceholderText('(sin cambio)')
    expect(keyInput).toHaveValue('')
    expect(screen.getByLabelText('Nombre del indexador')).toHaveValue('NoNaMe')

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => {
      const put = fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
      )
      expect(put).toBeTruthy()
    })
    const put = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
    )
    const body = JSON.parse(String(put![1]?.body)) as { api_key: string; name: string }
    // Empty api_key = keep the stored one — the backend reads it that way.
    expect(body.api_key).toBe('')
    expect(body.name).toBe('NoNaMe')
  })

  it('delete asks for confirmation and only deletes when accepted', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'DELETE /api/indexers/1': () => ({ ok: true }),
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Eliminar NoNaMe' }))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('NoNaMe'))
    expect(
      fn.mock.calls.find(([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'DELETE'),
    ).toBeUndefined()

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar NoNaMe' }))
    await waitFor(() => {
      expect(
        fn.mock.calls.find(
          ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'DELETE',
        ),
      ).toBeTruthy()
    })
    confirmSpy.mockRestore()
  })
})

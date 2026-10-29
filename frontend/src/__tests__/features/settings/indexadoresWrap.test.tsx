import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IndexadoresSection } from '../../../features/settings/IndexadoresSection.tsx'

/** labels-wrap T1 (family B): Nombre/URL/API Key wrap their input; in API Key
 *  the «Mostrar» toggle stays OUTSIDE the label — one labelable control only. */

function mockFetch(routes: Record<string, () => unknown>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    const handler = routes[key]
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (handler ? handler() : {}),
    } as Response)
  })
  vi.stubGlobal('fetch', fn)
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <IndexadoresSection onOpenGeneral={() => {}} />
    </QueryClientProvider>,
  )
}

describe('indexadores — the label wraps its input', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('Nombre and URL: the input is a descendant of its label with the exact text', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    const nombre = await screen.findByLabelText('Nombre')
    const nombreLabel = nombre.closest('label')
    expect(nombreLabel).not.toBeNull()
    expect(nombreLabel).toContainElement(nombre)
    expect(within(nombreLabel!).getByText('Nombre')).toBeInTheDocument()

    const url = screen.getByLabelText('URL')
    const urlLabel = url.closest('label')
    expect(urlLabel).not.toBeNull()
    expect(urlLabel).toContainElement(url)
    expect(within(urlLabel!).getByText('URL')).toBeInTheDocument()
  })

  it('API Key: the masked input hangs off the label and the toggle stays outside', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    const input = await screen.findByLabelText('API Key')
    expect(input).toHaveAttribute('type', 'password')
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(within(label!).getByText('API Key')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Mostrar' })
    expect(label).not.toContainElement(toggle)
  })

  it('«Buscar en todas las fuentes…»: the search input is inside a label', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    const input = await screen.findByPlaceholderText('Buscar en todas las fuentes…')
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(within(label!).getByText('Buscar en todas las fuentes…')).toBeInTheDocument()
    expect(screen.getByLabelText('Buscar en todas las fuentes…')).toBe(input)
  })
})

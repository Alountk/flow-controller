import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ScanModal, type ScanItem } from '../../../features/media-pane/components/ScanModal.tsx'

/** labels-wrap T1 (family C): «Título adicional:» was an orphan label — it
 *  now wraps its input and getByLabelText resolves. */

function mockFetch() {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/files/roots')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ roots: [{ path: '/mnt/storage', name: 'storage' }] }),
      } as Response)
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, path: '', items: [] }),
    } as Response)
  })
  vi.stubGlobal('fetch', fn)
}

const item: ScanItem = { type: 'movie', id: 7, title: 'Ronin', source: 'radarr' }

describe('ScanModal — the label wraps «Título adicional»', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('getByLabelText resolves and the input is a descendant of the label', async () => {
    mockFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ScanModal item={item} onClose={() => {}} />
      </QueryClientProvider>,
    )

    const input = await screen.findByLabelText('Título adicional:')
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(within(label!).getByText('Título adicional:')).toBeInTheDocument()
  })

  it('S2: the input carries id/name scan-titulo-adicional and the label links to it', async () => {
    mockFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ScanModal item={item} onClose={() => {}} />
      </QueryClientProvider>,
    )

    const input = (await screen.findByLabelText('Título adicional:')) as HTMLInputElement
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(label!.getAttribute('for')).toBe(input.id)
    expect(input.id).toBeTruthy()
    expect(input.name).toBeTruthy()
    expect(input.id).toBe('scan-titulo-adicional')
    expect(input.name).toBe('scan-titulo-adicional')
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileNavigator } from '../../../shared/ui/FileNavigator.tsx'

/** labels-wrap T1 (family C): rootLabel was an orphan label — it now wraps
 *  the volume select and the row buttons stay outside the label. */

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

describe('FileNavigator — the label wraps the volume select', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rootLabel: the select is a descendant of the label and «Subir» stays outside', async () => {
    mockFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <FileNavigator
          variant="region"
          rootPicker="select"
          rootLabel="Carpeta a escanear:"
          selectPlaceholder="Seleccionar volumen..."
          mode="both"
        />
      </QueryClientProvider>,
    )

    const select = await screen.findByLabelText('Carpeta a escanear:')
    const label = select.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(select)
    expect(within(label!).getByText('Carpeta a escanear:')).toBeInTheDocument()
    expect(label).not.toContainElement(screen.getByRole('button', { name: /Subir/ }))
  })

  it('S2: the volume select carries id/name fm-volume-root and the label links to it', async () => {
    mockFetch()
    const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { unmount } = render(
      <QueryClientProvider client={makeClient()}>
        <FileNavigator
          variant="region"
          rootPicker="select"
          rootLabel="Carpeta a escanear:"
          selectPlaceholder="Seleccionar volumen..."
          mode="both"
        />
      </QueryClientProvider>,
    )

    const select = (await screen.findByLabelText('Carpeta a escanear:')) as HTMLSelectElement
    const label = select.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(select)
    expect(label!.getAttribute('for')).toBe(select.id)
    expect(select.id).toBe('fm-volume-root')
    expect(select.name).toBe('fm-volume-root')

    // Without rootLabel no label renders, but the form hookup stays on the select.
    unmount()
    render(
      <QueryClientProvider client={makeClient()}>
        <FileNavigator
          variant="region"
          rootPicker="select"
          selectPlaceholder="Seleccionar volumen..."
          mode="both"
        />
      </QueryClientProvider>,
    )
    const bare = (await screen.findByRole('combobox')) as HTMLSelectElement
    expect(bare.closest('label')).toBeNull()
    expect(bare.id).toBe('fm-volume-root')
    expect(bare.name).toBe('fm-volume-root')
  })
})

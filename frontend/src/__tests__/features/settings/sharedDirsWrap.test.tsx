import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SharedDirsSection } from '../../../features/settings/SharedDirsSection.tsx'

/** labels-wrap T1 (family B): «Ruta a compartir» wraps text+input; the row
 *  buttons stay OUTSIDE the label (the labeled control is the input alone). */

function mockFetch() {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/amule/shared-dirs')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          config_dir: '/mnt/storage/amule/config',
          recursive: [],
          explicit: [],
          allowed_roots: ['/mnt/storage'],
        }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SharedDirsSection />
    </QueryClientProvider>,
  )
}

describe('aMule shared dirs — the label wraps the input', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('«Ruta a compartir»: input inside the label, row buttons outside', async () => {
    mockFetch()
    renderSection()

    const input = await screen.findByLabelText('Ruta a compartir')
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(within(label!).getByText('Ruta a compartir')).toBeInTheDocument()
    expect(label).not.toContainElement(screen.getByRole('button', { name: /Añadir recursiva/ }))
    expect(label).not.toContainElement(
      screen.getByRole('button', { name: /Añadir solo esta carpeta/ }),
    )
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileExplorer } from '../../../shared/ui/FileExplorer.tsx'

/** La etiqueta de la raíz nombra el selector: `htmlFor` enlaza, nunca envuelve.
 *  Envolverlo metía «Subir» y «Refrescar» dentro de la etiqueta del volumen. */

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

function renderExplorer(props: { rootLabel?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileExplorer accept="both" {...props} />
    </QueryClientProvider>,
  )
}

describe('FileExplorer — la etiqueta nombra el selector de raíz', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('el selector se alcanza por su etiqueta y los botones quedan fuera', async () => {
    mockFetch()
    renderExplorer({ rootLabel: 'Carpeta a escanear:' })

    const select = (await screen.findByLabelText('Carpeta a escanear:')) as HTMLSelectElement
    const label = document.querySelector('label[for="explorer-root"]')
    expect(label).not.toBeNull()
    expect(label!.getAttribute('for')).toBe(select.id)
    expect(select.id).toBe('explorer-root')
    // Nada más dentro de la etiqueta: un botón ahí es un botón que se pulsa
    // al hacer clic en el texto.
    expect(label!.contains(screen.getByRole('button', { name: /Subir/ }))).toBe(false)
  })

  it('sin rootLabel no hay etiqueta, pero el selector conserva id y name', async () => {
    mockFetch()
    renderExplorer()

    const select = (await screen.findByRole('combobox')) as HTMLSelectElement
    expect(document.querySelector('label[for="explorer-root"]')).toBeNull()
    expect(select.id).toBe('explorer-root')
    expect(select.name).toBe('explorer-root')
  })
})

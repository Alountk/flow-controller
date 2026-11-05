import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileManager } from '../../../features/file-manager/FileManager.tsx'

/**
 * The `#/archivos?path=` door Renombrar's «Abrir carpeta» walks through.
 *
 * Two things are guarded here: the explorer opens AT the folder the link names
 * (not at the root, not at the first pane's own root), and the parameter is
 * consumed on arrival — a door is not state, so a reload after the user has
 * navigated elsewhere must not drag them back to a folder they left.
 */

const ROOT = '/mnt/4k'
const FOLDER = '/mnt/4k/Dune Parte Dos (2024)'

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileManager />
    </QueryClientProvider>,
  )
}

describe('Archivos · la carpeta que llega en la URL', () => {
  let calls: string[] = []

  beforeEach(() => {
    calls = []
    const fn = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/api/files/roots')) {
        return ok({ roots: [{ path: ROOT, name: '4k', role: '4k', label: '4K' }], detail: '' })
      }
      if (url.includes('/api/files/browse')) {
        const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
        return ok({ ok: true, path, items: [] })
      }
      if (url.includes('/api/files/retention')) {
        return ok({ ok: true, path: FOLDER, days: 7, files: [] })
      }
      return ok({})
    })
    vi.stubGlobal('fetch', fn)
    window.history.replaceState(null, '', `/archivos#/archivos?path=${encodeURIComponent(FOLDER)}`)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/archivos')
  })

  it('browses that folder instead of falling back to the root', async () => {
    renderApp()

    await waitFor(() => {
      const browse = calls.find((url) => url.includes('/api/files/browse'))
      expect(browse).toBeDefined()
      expect(new URL(String(browse), 'http://x').searchParams.get('path')).toBe(FOLDER)
    })
  })

  it('consumes the parameter so a later reload starts clean', async () => {
    renderApp()

    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(window.location.pathname).toBe('/archivos')
  })
})

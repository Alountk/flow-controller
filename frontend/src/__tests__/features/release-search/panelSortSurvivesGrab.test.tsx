import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import type { Release } from '../../../shared/api/releases.ts'

/** The operator sorts the results, grabs one, and the order must still be theirs. */
const releases: Release[] = [
  { guid: 'a', title: 'Alpha.small', size: 1_000_000_000, indexer: 'idx', source: 'torznab', link: 'https://idx.test/a.torrent', seeders: 5 },
  { guid: 'b', title: 'Bravo.big', size: 9_000_000_000, indexer: 'idx', source: 'torznab', link: 'https://idx.test/b.torrent', seeders: 1 },
]

const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body } as Response)

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) return ok({ indexers: [{ id: 1, name: 'idx', implementation: 'Torznab', enableSearch: true }] })
    if (url.includes('/api/calendar/releases')) return ok({ releases, detail: '2 releases encontrados' })
    if (url.includes('/api/calendar/grab')) {
      return init?.method === 'POST'
        ? ok({ ok: true, task_id: 'g1', status: 'running', detail: 'Descarga lanzada' })
        : ok({ ok: true, id: 'g1', status: 'done', detail: 'Descarga iniciada' })
    }
    if (url.includes('/api/settings')) return ok({ paths: { path_4k: '', path_3d: '' } })
    return ok({})
  }))
}

describe('panel · the sort survives a grab', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the operator\'s order after pressing download', async () => {
    stubFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ReleaseSearchModal presentation="panel" item={{ type: 'movie', id: 7301, title: 'Peli', source: 'radarr', has_file: false }} />
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await screen.findByPlaceholderText('Filtrar por título...')

    const sizeSort = screen.getByRole('button', { name: /Tamaño/ })
    fireEvent.click(sizeSort)
    fireEvent.click(sizeSort)
    const sorted = screen.getAllByRole('row').map((r) => r.textContent ?? '')
    const bravoFirst = sorted.findIndex((t) => t.includes('Bravo')) < sorted.findIndex((t) => t.includes('Alpha'))
    expect(bravoFirst).toBe(true)

    fireEvent.click(document.querySelectorAll('.release-dest-btn')[0] as HTMLElement)
    await screen.findByText('Descarga iniciada')

    const after = screen.getAllByRole('row').map((r) => r.textContent ?? '')
    expect(after.findIndex((t) => t.includes('Bravo'))).toBeLessThan(after.findIndex((t) => t.includes('Alpha')))
  })
})

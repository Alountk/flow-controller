import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * The combo is gone: the modal offers our SITES as checkboxes (every enabled
 * Torznab registry row + aMule + Prowlarr) and the search runs only on the
 * checked ones — `sources`/`indexer_ids` ride the POST, absent when nothing
 * is unchecked (today's fan-out, byte-identical). The backend's own `detail`
 * («fuentes omitidas», «amule: 0 resultados») reaches the results step, so a
 * source that contributed nothing always says why.
 */

const release: Release = {
  title: 'Película 2020 1080p',
  guid: 'g-1',
  link: 'magnet:?xt=urn:btih:aa',
  size: 1,
  indexer: 'Sitio Uno',
  source: 'torznab',
  seeders: 5,
}

const REGISTRY = {
  indexers: [
    { id: 1, name: 'Sitio Uno', url: 'http://u1', api_key: '***', categories: '', enabled: 1 },
    { id: 2, name: 'Apagado', url: 'http://u2', api_key: '***', categories: '', enabled: 0 },
    { id: 3, name: 'Sitio Dos', url: 'http://u3', api_key: '***', categories: '', enabled: 1 },
  ],
}

const REGISTRY_ERROR = { indexers: [], error: 'el almacén de indexadores no está disponible' }

function mockFetch(opts: { detail?: string; registryError?: boolean } = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => ({ indexers: [] }) } as Response)
    }
    if (url.includes('/api/indexers')) {
      const body = opts.registryError ? REGISTRY_ERROR : REGISTRY
      return Promise.resolve({ ok: true, json: async () => body } as Response)
    }
    if (url.includes('/api/settings')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ paths: { path_4k: '', path_3d: '' } }),
      } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases: [release], detail: opts.detail ?? '1 releases' }),
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof mockFetch>

function searchBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(
      ([input, init]) =>
        String(input).includes('/api/calendar/releases') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 411, title: 'Everything Everywhere', source: 'radarr' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

const siteNames = ['Sitio Uno', 'Sitio Dos', 'aMule', 'Prowlarr']

describe('site checkboxes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists our sites as checked checkboxes and the combo is gone', async () => {
    mockFetch()
    renderModal()
    for (const name of siteNames) {
      const box = await screen.findByLabelText(name)
      expect(box).toBeChecked()
    }
    expect(screen.queryByLabelText('Apagado')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(document.querySelector('.calendar-indexer-select')).toBeNull()
  })

  it('keeps today\'s fan-out when nothing is unchecked', async () => {
    const fn = mockFetch()
    renderModal()
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await waitFor(() => expect(searchBodies(fn)).toHaveLength(1))
    expect(searchBodies(fn)[0]).not.toHaveProperty('sources')
    expect(searchBodies(fn)[0]).not.toHaveProperty('indexer_ids')
  })

  it('sends only the checked sites', async () => {
    const fn = mockFetch()
    renderModal()
    fireEvent.click(await screen.findByLabelText('aMule'))
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await waitFor(() => expect(searchBodies(fn)).toHaveLength(1))
    expect(searchBodies(fn)[0].sources).toEqual(['torznab', 'prowlarr'])
    expect(searchBodies(fn)[0]).not.toHaveProperty('indexer_ids')
  })

  it('narrows the registry to the checked rows', async () => {
    const fn = mockFetch()
    renderModal()
    fireEvent.click(await screen.findByLabelText('Sitio Dos'))
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await waitFor(() => expect(searchBodies(fn)).toHaveLength(1))
    const body = searchBodies(fn)[0]
    expect(body.sources).toEqual(['torznab', 'amule', 'prowlarr'])
    expect(body.indexer_ids).toEqual([1])
  })

  it('refuses to search with no site selected', async () => {
    const fn = mockFetch()
    renderModal()
    for (const name of siteNames) fireEvent.click(await screen.findByLabelText(name))
    expect(
      await screen.findByText('Selecciona al menos un sitio para buscar'),
    ).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    expect(searchBodies(fn)).toHaveLength(0)
  })

  it('shows the backend detail on the results step', async () => {
    mockFetch({ detail: '1 releases — amule: 0 resultados' })
    renderModal()
    fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
    await waitFor(() => expect(document.querySelector('.calendar-releases')).not.toBeNull())
    expect(screen.getByText('1 releases — amule: 0 resultados')).toBeVisible()
  })

  it('surfaces an unreadable registry instead of an empty list', async () => {
    mockFetch({ registryError: true })
    renderModal()
    expect(
      // retry:1 on the query: the settled error lands after one 1 s retry.
      await screen.findByText(
        'el almacén de indexadores no está disponible',
        {},
        { timeout: 4000 },
      ),
    ).toBeVisible()
    expect(screen.getByLabelText('aMule')).toBeChecked()
  })
})

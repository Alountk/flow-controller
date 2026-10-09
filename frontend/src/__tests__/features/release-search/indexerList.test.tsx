import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'

/**
 * The indexer list was swallowed three layers deep: `arr_indexers` returned []
 * on any failure, the route added no error field, and the modal did
 * `.catch(() => {})`. A Radarr timeout was therefore indistinguishable from
 * "no indexers configured", and the dropdown simply had one option.
 *
 * These guard the two halves of the fix: the failure reaches the screen with
 * its reason, and a list already fetched for one source is not fetched again.
 */

const item = {
  type: 'movie' as const,
  id: 411,
  title: 'Everything Everywhere All at Once',
  source: 'radarr' as const,
}

const okBody = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } })
}

function open(client: ReturnType<typeof makeClient>) {
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal item={item} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('indexer list in the release search modal', () => {
  it('says why the list could not be loaded instead of showing nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            indexers: [],
            error_kind: 'timeout',
            error: 'radarr: no respondió a tiempo',
          }),
        } as Response),
      ),
    )

    open(makeClient())

    // `retry: 1` gives one transient-failure attempt before giving up, so the
    // reason lands after the backoff rather than instantly.
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert.textContent).toContain('no respondió a tiempo')
    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeInTheDocument()
  })

  it('reuses the list already fetched for that source on a second open', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve({ ok: true, json: async () => okBody } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = makeClient()
    const countIndexerCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/calendar/indexers'))
        .length

    const first = open(client)
    expect(await screen.findByText('aMuTorrent')).toBeInTheDocument()
    expect(countIndexerCalls()).toBe(1)
    first.unmount()

    open(client)
    await waitFor(() => expect(screen.getByText('aMuTorrent')).toBeInTheDocument())
    expect(countIndexerCalls()).toBe(1)
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { QualityBelowList } from '../../../features/quality/QualityBelowList.tsx'

/**
 * S4 («umbral-calidad»): the below-threshold list can only claim what was
 * MEASURED — un-analyzed files are counted apart, never listed as candidates.
 */

const report = (over: Record<string, unknown> = {}) => ({
  threshold: { min_class: '1080p', min_width: 0 },
  items: [
    { path: '/m/Low (2001)/Low.mkv', name: 'Low.mkv', width: 1280, height: 536, class: '720p', size_bytes: 2_000_000_000, duration: 3600 },
  ],
  analyzed: 12,
  unanalyzed: 5,
  ...over,
})

function stubFetch(responses: unknown[]) {
  let call = 0
  const fn = vi.fn(() => {
    const body = responses[Math.min(call, responses.length - 1)]
    call += 1
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <QualityBelowList />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('S4 · lista por debajo del umbral', () => {
  it('lists the measured candidates with their real resolution', async () => {
    stubFetch([report()])

    renderList()

    expect(await screen.findByText('Low.mkv')).toBeInTheDocument()
    expect(screen.getByText('1280×536')).toBeInTheDocument()
    expect(screen.getByText('720p')).toBeInTheDocument()
    expect(screen.getByText(/1 por debajo de 1080p/)).toBeInTheDocument()
  })

  it('counts the un-analyzed apart instead of listing them', async () => {
    stubFetch([report()])

    renderList()

    expect(await screen.findByText(/5 sin analizar/)).toBeInTheDocument()
    expect(screen.queryByText(/sin analizar.*baja calidad/i)).toBeNull()
  })

  it('says so honestly when nothing is below the threshold', async () => {
    stubFetch([report({ items: [], analyzed: 12 })])

    renderList()

    expect(await screen.findByText(/ninguna .*por debajo/i)).toBeInTheDocument()
  })

  it('refetches when the operator asks again', async () => {
    const fn = stubFetch([report(), report({ items: [], analyzed: 20, unanalyzed: 0 })])

    renderList()
    await screen.findByText('Low.mkv')
    fireEvent.click(screen.getByRole('button', { name: /actualizar/i }))

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/ninguna .*por debajo/i)).toBeInTheDocument()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DiskSpace } from '../components/DiskSpace'
import type { DiskResponse } from '../types'

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const diskResponse: DiskResponse = {
  volumes: [
    {
      name: 'storage',
      path: '/mnt/storage',
      total_bytes: 100 * 1024 ** 3,
      used_bytes: 50 * 1024 ** 3,
      free_bytes: 50 * 1024 ** 3,
      percent: 50,
    },
  ],
}

describe('DiskSpace', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a loading state before the request resolves', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}))

    renderWithQuery(<DiskSpace />)

    expect(screen.getByText('Cargando...')).toBeInTheDocument()
  })

  it('renders a volume card with usage stats after loading', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => diskResponse,
    } as Response)

    renderWithQuery(<DiskSpace />)

    await waitFor(() => expect(screen.getByText('storage')).toBeInTheDocument())

    expect(screen.getByText('/mnt/storage')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('Usado')).toBeInTheDocument()
    expect(screen.getByText('Libre')).toBeInTheDocument()
    expect(screen.getByText('Total')).toBeInTheDocument()
  })

  it('shows an empty state when there are no volumes', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ volumes: [] }),
    } as Response)

    renderWithQuery(<DiskSpace />)

    await waitFor(() =>
      expect(screen.getByText('No hay volúmenes configurados')).toBeInTheDocument(),
    )
  })

  it('renders the error message for an unavailable volume', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({
        volumes: [
          {
            name: 'broken',
            path: '/mnt/broken',
            total_bytes: 0,
            used_bytes: 0,
            free_bytes: 0,
            percent: 0,
            error: 'permission denied',
          },
        ],
      }),
    } as Response)

    renderWithQuery(<DiskSpace />)

    await waitFor(() => expect(screen.getByText('permission denied')).toBeInTheDocument())
    expect(screen.queryByText('Usado')).not.toBeInTheDocument()
  })
})

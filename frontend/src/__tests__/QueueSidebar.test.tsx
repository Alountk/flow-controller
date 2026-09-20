import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { QueueSidebar } from '../components/QueueSidebar'
import type { QueueOp } from '../api/files'

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function makeOp(overrides: Partial<QueueOp> = {}): QueueOp {
  return {
    id: 'op-1',
    type: 'copy',
    name: 'movie.mkv',
    src: '/src/movie.mkv',
    dst: '/dst/movie.mkv',
    status: 'running',
    detail: null,
    progress: 40,
    copied_bytes: 400,
    total_bytes: 1000,
    files_done: 0,
    files_total: 1,
    import_status: '',
    ...overrides,
  }
}

describe('QueueSidebar', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows an empty state when there is no queue activity', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ queue: [], completed: [], running: false }),
    } as Response)

    renderWithQuery(<QueueSidebar />)

    await waitFor(() => expect(screen.getByText('Sin operaciones')).toBeInTheDocument())
  })

  it('renders active operations with their progress', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ queue: [makeOp()], completed: [], running: true }),
    } as Response)

    renderWithQuery(<QueueSidebar />)

    await waitFor(() => expect(screen.getByText('movie.mkv')).toBeInTheDocument())
    expect(screen.getByText('Copiar')).toBeInTheDocument()
    expect(screen.getByText(/40%/)).toBeInTheDocument()
  })

  it('shows the import indicator while an operation is importing', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({
        queue: [makeOp({ status: 'done', import_status: 'importing' })],
        completed: [],
        running: false,
      }),
    } as Response)

    renderWithQuery(<QueueSidebar />)

    await waitFor(() =>
      expect(screen.getByText(/Importando en Radarr/)).toBeInTheDocument(),
    )
  })

  it('shows completed operations under the recent section', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({
        queue: [],
        completed: [makeOp({ id: 'done-1', status: 'done', import_status: 'imported', detail: 'Completado' })],
        running: false,
      }),
    } as Response)

    renderWithQuery(<QueueSidebar />)

    await waitFor(() => expect(screen.getByText('Recientes')).toBeInTheDocument())
    expect(screen.getByText('Completado')).toBeInTheDocument()
  })

  it('offers a cancel action on active operations and calls the cancel endpoint', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({ queue: [makeOp()], completed: [], running: true }),
      } as Response)
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, detail: 'cancelado' }),
      } as Response)
      .mockResolvedValue({
        json: async () => ({ queue: [], completed: [], running: false }),
      } as Response)

    renderWithQuery(<QueueSidebar />)

    const cancelButton = await screen.findByTitle('Cancelar')
    fireEvent.click(cancelButton)

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/files/queue/cancel/op-1'),
      )
      expect(cancelCall).toBeDefined()
    })
  })

  it('collapses into a floating toggle that reports the active count', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ queue: [makeOp()], completed: [], running: true }),
    } as Response)

    const { container } = renderWithQuery(<QueueSidebar />)

    await waitFor(() => expect(screen.getByText('Cola de operaciones')).toBeInTheDocument())

    expect(container.querySelector('.qsidebar-toggle-fixed')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Cola de operaciones'))

    await waitFor(() => {
      const toggle = container.querySelector('.qsidebar-toggle-fixed')
      expect(toggle).toBeInTheDocument()
      expect(toggle?.querySelector('.qsidebar-toggle-count')).toHaveTextContent('1')
    })
    expect(container.querySelector('.qsidebar.collapsed')).toBeInTheDocument()
  })
})

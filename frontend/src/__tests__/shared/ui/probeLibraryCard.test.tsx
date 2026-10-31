import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProbeLibraryCard } from '../../../shared/ui/ProbeLibraryCard.tsx'

/**
 * T5 (S3/S4): «Analizar biblioteca» starts the sweep and shows live progress
 * from the status endpoint — including the skip count, so the operator sees
 * that already-analyzed files are not being probed again.
 */

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

const running = { running: true, total: 10, analyzed: 3, skipped: 4, failed: 1, started_at: 1, finished_at: 0 }
const finished = { running: false, total: 10, analyzed: 6, skipped: 4, failed: 0, started_at: 1, finished_at: 2 }

function stubFetch(opts: { start?: () => Promise<Response>; status?: unknown[] } = {}) {
  let statusCall = 0
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/mixer/probe-library/status')) {
      const list = opts.status ?? [finished]
      const next = list[Math.min(statusCall, list.length - 1)]
      statusCall += 1
      return ok(next)
    }
    if (url.includes('/api/mixer/probe-library') && init?.method === 'POST') {
      return opts.start ? opts.start() : ok({ started: true, total: 10 })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ProbeLibraryCard intervalMs={10} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('T5 · «Analizar biblioteca» (S3/S4)', () => {
  it('reports the finished sweep including its skips', async () => {
    stubFetch({ status: [finished] })

    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Analizar biblioteca' }))

    expect(await screen.findByText(/6 de 10 analizados/)).toBeInTheDocument()
    expect(screen.getByText(/4 ya estaban analizados/)).toBeInTheDocument()
  })

  it('says it is running while the sweep is in flight', async () => {
    stubFetch({ status: [running] })

    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Analizar biblioteca' }))

    expect(await screen.findByText(/Analizando biblioteca/)).toBeInTheDocument()
    expect(screen.getByText(/1 con error/)).toBeInTheDocument()
  })

  it('explains a refused second run in Spanish', async () => {
    stubFetch({
      start: () => Promise.resolve({ ok: false, status: 409, json: async () => ({ detail: 'Ya hay un análisis de biblioteca en curso' }) } as Response),
      status: [running, finished],
    })

    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Analizar biblioteca' }))

    expect(await screen.findByText('Ya hay un análisis de biblioteca en curso')).toBeInTheDocument()
  })

  it('shows no failure note on a clean run', async () => {
    stubFetch({ status: [finished] })

    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Analizar biblioteca' }))

    await screen.findByText(/6 de 10 analizados/)
    await waitFor(() => expect(screen.queryByText(/con error/)).toBeNull())
  })
})

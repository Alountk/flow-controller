import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ActionsResponse, AutoCopyLogEntry, AutoCopySweepResult } from '../types'
import { TraceView } from '../components/TraceView'

/**
 * Tests for the auto-copy decision history in Trazabilidad.
 *
 * The history is a timeline of TRANSITIONS, not a sweep-by-sweep dump. Each row
 * carries the outcome's Spanish label and the reason the sweep already wrote,
 * and an empty history says so honestly instead of rendering a blank block.
 */

const OPEN_ACTIONS: ActionsResponse = { actions: [], safe_mode: false, available: [] }

function logEntry(overrides: Partial<AutoCopyLogEntry> = {}): AutoCopyLogEntry {
  return {
    id: 1,
    key: 'radarr:abc',
    source: 'radarr',
    title: 'Your Name.',
    decision: 'copied',
    reason: 'el arr no lo importó en 30 min',
    at: 1_700_000_000,
    ...overrides,
  }
}

function emptyCounts() {
  return { traces: 0, copy: 0, copied: 0, proposed: 0, wait: 0, skip: 0, failed: 0 }
}

function sweepResult(): AutoCopySweepResult {
  return {
    ok: true,
    running: false,
    safe_mode: false,
    detail: '',
    counts: emptyCounts(),
    entries: [],
    errors: [],
    started_at: 1,
    finished_at: 2,
  }
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

/** Routes by URL: the history GET and the sweep POST are different requests. */
function stubFetch(historyBody: unknown) {
  return vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes('/api/auto-copy/history')) {
      return Promise.resolve(jsonResponse(historyBody))
    }
    return Promise.resolve(jsonResponse(sweepResult()))
  })
}

function renderTraceView() {
  return render(
    <TraceView data={null} loading={false} actions={OPEN_ACTIONS} onActionDone={() => {}} />,
  )
}

describe('auto-copy decision history', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the history on mount and renders each label with its reason', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        items: [
          logEntry({ id: 1, decision: 'copied', reason: 'el arr no lo importó en 30 min' }),
          logEntry({ id: 2, decision: 'wait', reason: 'la descarga sigue en curso' }),
          logEntry({ id: 3, decision: 'skip', reason: 'no es un grab lanzado desde la app' }),
        ],
      }),
    )
    renderTraceView()

    expect(await screen.findByText('Copiada')).toBeInTheDocument()
    expect(screen.getByText('Esperando')).toBeInTheDocument()
    expect(screen.getByText('Omitida')).toBeInTheDocument()
    expect(screen.getByText('el arr no lo importó en 30 min')).toBeInTheDocument()
    expect(screen.getByText('la descarga sigue en curso')).toBeInTheDocument()
    expect(screen.getByText('no es un grab lanzado desde la app')).toBeInTheDocument()
  })

  it('shows an honest empty state when there is no history', async () => {
    vi.stubGlobal('fetch', stubFetch({ items: [] }))
    renderTraceView()

    expect(await screen.findByText(/Todavía no hay movimientos/)).toBeInTheDocument()
  })

  it('refreshes the history after a sweep runs', async () => {
    let historyCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/api/auto-copy/history')) {
        historyCalls += 1
        return Promise.resolve(
          jsonResponse(
            historyCalls === 1
              ? { items: [] }
              : { items: [logEntry({ decision: 'copied', reason: 'copiada tras el barrido' })] },
          ),
        )
      }
      return Promise.resolve(jsonResponse(sweepResult()))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView()

    // Loaded with the page: nothing yet.
    expect(await screen.findByText(/Todavía no hay movimientos/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Revisar descargas' }))

    expect(await screen.findByText('copiada tras el barrido')).toBeInTheDocument()
    expect(historyCalls).toBe(2)
  })

  it('reports an unreadable history instead of pretending it is empty', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({ items: [], error: 'el historial no está disponible' }),
    )
    renderTraceView()

    expect(await screen.findByText('el historial no está disponible')).toBeInTheDocument()
    expect(screen.queryByText(/Todavía no hay movimientos/)).not.toBeInTheDocument()
  })
})

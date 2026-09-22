import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ActionsResponse, AutoCopySweepResult } from '../types'
import { TraceView } from '../components/TraceView'

/**
 * Tests for the "Revisar descargas" trigger in Trazabilidad.
 *
 * The sweep is an explicit POST — the button is the feature's only user-facing
 * half, since the endpoint should never be a side effect of the polled GET. The
 * panel is the one place that tells the user whether the library was written to
 * or only proposed to, so the safe-mode sentence is asserted verbatim.
 */

const OPEN_ACTIONS: ActionsResponse = { actions: [], safe_mode: false, available: [] }
const SAFE_ACTIONS: ActionsResponse = { actions: [], safe_mode: true, available: [] }

function emptyCounts() {
  return { traces: 0, copy: 0, copied: 0, proposed: 0, wait: 0, skip: 0, failed: 0 }
}

function baseResult(overrides: Partial<AutoCopySweepResult> = {}): AutoCopySweepResult {
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
    ...overrides,
  }
}

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

function ok(body: unknown) {
  return Promise.resolve(okResponse(body))
}

function renderTraceView(actions: ActionsResponse = OPEN_ACTIONS) {
  return render(
    <TraceView
      data={null}
      loading={false}
      actions={actions}
      onActionDone={() => {}}
    />,
  )
}

/** Clicks the trigger and waits for the sweep request to have been made. */
async function clickSweep(fetchMock: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole('button', { name: 'Revisar descargas' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
}

describe('"Revisar descargas" auto-copy trigger', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to the sweep endpoint', async () => {
    const fetchMock = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
      ok(baseResult()),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView()

    await clickSweep(fetchMock)

    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/auto-copy/sweep'),
    )
    expect(call).toBeTruthy()
    expect(String(call![0])).toBe('/api/auto-copy/sweep')
    expect(call![1]).toMatchObject({ method: 'POST' })
  })

  it('renders the counts from the response', async () => {
    const fetchMock = vi.fn(() =>
      ok(
        baseResult({
          counts: { traces: 7, copy: 3, copied: 2, proposed: 3, wait: 1, skip: 0, failed: 0 },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView()

    await clickSweep(fetchMock)

    expect((await screen.findByText('Trazas revisadas')).parentElement).toHaveTextContent('7')
    expect(screen.getByText('Copiadas').parentElement).toHaveTextContent('2')
    expect(screen.getByText('Propuestas').parentElement).toHaveTextContent('3')
    expect(screen.getByText('En espera').parentElement).toHaveTextContent('1')
  })

  it('says plainly that safe mode copied nothing', async () => {
    const fetchMock = vi.fn(() =>
      ok(
        baseResult({
          safe_mode: true,
          counts: { traces: 1, copy: 1, copied: 0, proposed: 1, wait: 0, skip: 0, failed: 0 },
          entries: [
            {
              key: 'k1',
              source: 'radarr',
              title: 'Some Movie',
              decision: 'copy',
              reason: 'El arr no lo importó en 30 minutos',
              action: 'proposed',
              detail: null,
            },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView(SAFE_ACTIONS)

    await clickSweep(fetchMock)

    expect(
      await screen.findByText(
        'Modo seguro activo: no se ha copiado nada. Lo que sigue es lo que el barrido haría.',
      ),
    ).toBeInTheDocument()
  })

  it("shows an entry's Spanish reason", async () => {
    const fetchMock = vi.fn(() =>
      ok(
        baseResult({
          counts: { traces: 1, copy: 1, copied: 1, proposed: 0, wait: 0, skip: 0, failed: 0 },
          entries: [
            {
              key: 'k1',
              source: 'sonarr',
              title: 'Some Show S03E07',
              decision: 'copy',
              reason: 'La descarga terminó y el arr no se enteró',
              action: 'copied',
              detail: '/mnt/storage/shows/Some Show/Season 3',
            },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView()

    await clickSweep(fetchMock)

    expect(await screen.findByText('Some Show S03E07')).toBeInTheDocument()
    expect(screen.getByText('La descarga terminó y el arr no se enteró')).toBeInTheDocument()
  })

  it('reports an in-flight sweep honestly instead of zeros', async () => {
    const fetchMock = vi.fn(() =>
      ok(
        baseResult({
          ok: false,
          running: true,
          safe_mode: true,
          detail: 'ya hay un barrido en curso',
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView(SAFE_ACTIONS)

    await clickSweep(fetchMock)

    expect(await screen.findByText(/Ya hay un barrido en curso/)).toBeInTheDocument()
    // The refusals' zero counts must not be shown as "nothing needed doing".
    expect(screen.queryByText('Trazas revisadas')).not.toBeInTheDocument()
  })

  it('surfaces a non-empty errors list', async () => {
    const fetchMock = vi.fn(() =>
      ok(
        baseResult({
          errors: ['traza Some Show: RuntimeError: boom'],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView()

    await clickSweep(fetchMock)

    expect(await screen.findByText('traza Some Show: RuntimeError: boom')).toBeInTheDocument()
    expect(screen.getByText('Errores')).toBeInTheDocument()
  })

  it('shows an honest empty state when nothing is actionable', async () => {
    const fetchMock = vi.fn(() =>
      ok(
        baseResult({
          counts: { traces: 5, copy: 0, copied: 0, proposed: 0, wait: 2, skip: 3, failed: 0 },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderTraceView()

    await clickSweep(fetchMock)

    expect(
      await screen.findByText('No hay nada que copiar: ninguna descarga necesita intervención.'),
    ).toBeInTheDocument()
  })

  it('disables the button while the request is in flight', async () => {
    let resolveSweep: (res: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      resolveSweep = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    renderTraceView()

    fireEvent.click(screen.getByRole('button', { name: 'Revisar descargas' }))

    expect(await screen.findByRole('button', { name: 'Revisando…' })).toBeDisabled()

    await act(async () => {
      resolveSweep(okResponse(baseResult()))
      await pending
    })
    expect(await screen.findByRole('button', { name: 'Revisar descargas' })).not.toBeDisabled()
  })
})

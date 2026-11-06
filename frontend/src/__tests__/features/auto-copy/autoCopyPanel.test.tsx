import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ActionsResponse, AutoCopySweepResult } from '../../../shared/types.ts'
import { AutoCopyPanel } from '../../../features/auto-copy/AutoCopyPanel.tsx'

/**
 * Tests for the "Revisar descargas" trigger — now AutoCopyPanel, the block
 * Trazabilidad used to own and Seguimiento renders today.
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

function renderPanel(actions: ActionsResponse = OPEN_ACTIONS) {
  return render(<AutoCopyPanel safeMode={actions.safe_mode} />)
}

/** Clicks the trigger and waits for the sweep POST to have been made.
 *  Scoped to the POST because the panel now also fetches the last sweep on
 *  mount — «toHaveBeenCalled» would be satisfied by that GET alone. */
async function clickSweep(fetchMock: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole('button', { name: 'Revisar descargas' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes('/api/auto-copy/sweep') && init?.method === 'POST',
      ),
    ).toBe(true),
  )
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
    renderPanel()

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
    renderPanel()

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
    renderPanel(SAFE_ACTIONS)

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
    renderPanel()

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
    renderPanel(SAFE_ACTIONS)

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
    renderPanel()

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
    renderPanel()

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
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Revisar descargas' }))

    expect(await screen.findByRole('button', { name: 'Revisando…' })).toBeDisabled()

    await act(async () => {
      resolveSweep(okResponse(baseResult()))
      await pending
    })
    expect(await screen.findByRole('button', { name: 'Revisar descargas' })).not.toBeDisabled()
  })
})

describe('el último barrido se muestra al abrir, igual que el manual (S4/T7b)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens showing the last sweep result — counts and entries — without clicking', async () => {
    // The flat GET body: the manual summary plus `swept_at` (auto_copy_driver).
    const last = {
      swept_at: 1762000000,
      ...baseResult({
        counts: { traces: 7, copy: 3, copied: 2, proposed: 1, wait: 1, skip: 0, failed: 0 },
        entries: [
          {
            key: 'k1',
            source: 'sonarr',
            title: 'Some Show S03E07',
            decision: 'copy' as const,
            reason: 'La descarga terminó y el arr no se enteró',
            action: 'copied' as const,
            detail: null,
          },
        ],
      }),
    }
    const fetchMock = vi.fn((input?: RequestInfo | URL) =>
      String(input).includes('/api/auto-copy/last') ? ok(last) : ok(baseResult()),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    expect((await screen.findByText('Trazas revisadas')).parentElement).toHaveTextContent('7')
    expect(screen.getByText('Copiadas').parentElement).toHaveTextContent('2')
    expect(await screen.findByText('Some Show S03E07')).toBeInTheDocument()
    expect(screen.getByText('La descarga terminó y el arr no se enteró')).toBeInTheDocument()
  })

  it('renders the «aún no» detail honestly — no counts row, no errors block', async () => {
    // Before any sweep the body is only `swept_at: null` + `detail`, with NO
    // counts key: zeroes would pretend a sweep ran and found nothing.
    const fetchMock = vi.fn((input?: RequestInfo | URL) =>
      String(input).includes('/api/auto-copy/last')
        ? ok({ swept_at: null, detail: 'aún no se ha ejecutado ningún barrido' })
        : ok(baseResult()),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    expect(
      await screen.findByText('aún no se ha ejecutado ningún barrido'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Trazas revisadas')).not.toBeInTheDocument()
    expect(screen.queryByText('Errores')).not.toBeInTheDocument()
  })

  it('a failed last-sweep fetch degrades to the failed-sweep vocabulary', async () => {
    const fetchMock = vi.fn((input?: RequestInfo | URL) => {
      if (String(input).includes('/api/auto-copy/last')) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return ok(baseResult())
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    // Same honest-failure rendering a failed manual sweep gets (failedResult):
    // the errors block, never a made-up counts row.
    expect(await screen.findByText('Errores')).toBeInTheDocument()
    expect(
      screen.getByText(
        'No se pudo contactar con el servidor. Comprueba la conexión y que el backend siga activo',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Trazas revisadas')).not.toBeInTheDocument()
  })

  it('a later manual sweep overwrites the seeded result', async () => {
    const fetchMock = vi.fn((input?: RequestInfo | URL) =>
      String(input).includes('/api/auto-copy/last')
        ? ok({
            swept_at: 1,
            ...baseResult({
              counts: { traces: 1, copy: 0, copied: 0, proposed: 0, wait: 1, skip: 0, failed: 0 },
            }),
          })
        : ok(
            baseResult({
              counts: { traces: 9, copy: 0, copied: 0, proposed: 0, wait: 9, skip: 0, failed: 0 },
            }),
          ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    expect((await screen.findByText('Trazas revisadas')).parentElement).toHaveTextContent('1')

    await clickSweep(fetchMock)
    await waitFor(() =>
      expect(screen.getByText('Trazas revisadas').parentElement).toHaveTextContent('9'),
    )
  })

  it('a slow last-sweep fetch never clobbers a finished manual sweep', async () => {
    let resolveLast!: (res: Response) => void
    const lastPending = new Promise<Response>((resolve) => {
      resolveLast = resolve
    })
    const fetchMock = vi.fn((input?: RequestInfo | URL) =>
      String(input).includes('/api/auto-copy/last')
        ? lastPending
        : ok(
            baseResult({
              counts: { traces: 9, copy: 0, copied: 0, proposed: 0, wait: 9, skip: 0, failed: 0 },
            }),
          ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    await clickSweep(fetchMock)
    await waitFor(() =>
      expect(screen.getByText('Trazas revisadas').parentElement).toHaveTextContent('9'),
    )

    await act(async () => {
      resolveLast(
        okResponse({
          swept_at: 1,
          ...baseResult({
            counts: { traces: 1, copy: 0, copied: 0, proposed: 0, wait: 1, skip: 0, failed: 0 },
          }),
        }),
      )
      await lastPending
    })
    // The late seed must not erase the manual result the user just saw.
    expect(screen.getByText('Trazas revisadas').parentElement).toHaveTextContent('9')
  })
})

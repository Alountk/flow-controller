import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'
import type { ReleaseSearchItem } from '../../features/release-search/ReleaseSearchModal.tsx'
import { clearToasts, getToasts } from '../../shared/utils/toast.ts'

/**
 * T13 — S11's frontend half on the mixer side:
 *
 * - L30: the destination is an EXPLICIT choice («Carpeta de A» / «Carpeta de
 *   B», no default) and «Mezclar» stays disabled until it is made; the UI
 *   informs the exact path that will be substituted (basename + folder) and
 *   the mux body carries `destination_path`. A destination that no longer
 *   matches an existing input re-disables the button.
 * - L31: a successful submit toasts «Enviado a la cola», and the «Tareas»
 *   section leaves the mixer (mix state now lives in Seguimiento).
 */

vi.mock('../../features/release-search/ReleaseSearchModal.tsx', () => ({
  ReleaseSearchModal: ({ item }: { item: ReleaseSearchItem }) => (
    <div data-testid="release-search-modal">{item.title}</div>
  ),
}))

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const FILE_A = 'Dune.Parte.Dos.2024.1080p.mkv'
const FILE_B = 'Dune.Parte.Dos.2024.2160p.mkv'
const PATH_A = '/mnt/movies/Dune.Parte.Dos.2024.1080p.mkv'
const PATH_B = '/mnt/4k/Dune.Parte.Dos.2024.2160p.mkv'

/** The pair a re-probe substitutes — the stale destination must not match. */
const FILE_A2 = 'Otra.Pelicula.2020.1080p.mkv'
const FILE_B2 = 'Otra.Pelicula.2020.2160p.mkv'
const PATH_A2 = '/mnt/other/Otra.Pelicula.2020.1080p.mkv'
const PATH_B2 = '/mnt/other/Otra.Pelicula.2020.2160p.mkv'

type Obj = Record<string, unknown>

function audioEntry(over: Obj = {}): Obj {
  return {
    index: 1,
    track_index: 0,
    codec: 'eac3',
    language: 'spa',
    language_code: 'spa',
    channels: 6,
    bitrate: 640_000,
    default: true,
    file: 'a',
    selected: true,
    ...over,
  }
}

function probeBody(over: Obj = {}): Obj {
  return {
    file_a: {
      filename: FILE_A,
      path: PATH_A,
      format: 'matroska,webm',
      duration: 6942,
      size_bytes: 8_400_000_000,
      video_tracks: [
        { index: 0, track_index: 0, codec: 'h264', width: 1920, height: 1080, fps: 23.976, bitrate: 12_400_000, selected: true },
      ],
      audio_tracks: [],
      subtitle_tracks: [],
    },
    file_b: {
      filename: FILE_B,
      path: PATH_B,
      format: 'matroska,webm',
      duration: 6940,
      size_bytes: 24_100_000_000,
      video_tracks: [
        { index: 0, track_index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 23.976, bitrate: 5_800_000, selected: false },
      ],
      audio_tracks: [],
      subtitle_tracks: [],
    },
    compatibility: { ok: true, reasons: [], warnings: [] },
    language_check: { ok: true, missing: [], required: ['spa'] },
    best_video: {
      file: 'a',
      path: PATH_A,
      track_index: 0,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 23.976,
      bitrate: 12_400_000,
    },
    audio_ordered: [audioEntry()],
    ...over,
  }
}

/** Same shape, the other pair of probed files. */
function probeBody2(): Obj {
  const body = probeBody()
  const fileA = body.file_a as Obj
  fileA.filename = FILE_A2
  fileA.path = PATH_A2
  const fileB = body.file_b as Obj
  fileB.filename = FILE_B2
  fileB.path = PATH_B2
  const best = body.best_video as Obj
  best.path = PATH_A2
  return body
}

/* ── Fetch harness ────────────────────────────────────────────────────────── */

type Handler = () => { status?: number; body: unknown }
type Route = [string, Handler]

function mockFetch(handlers: Route[]) {
  const calls: { url: string; body: Obj | null }[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Obj) : null
    calls.push({ url, body })
    for (const [match, handler] of handlers) {
      if (url.includes(match)) {
        const r = handler()
        const status = r.status ?? 200
        return Promise.resolve({
          ok: status < 400,
          status,
          json: async () => r.body,
        } as Response)
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

function pickerHandlers(): Route[] {
  return [
    ['/api/files/roots', () => ({ body: { roots: [{ path: '/mnt', name: 'Media' }] } })],
    ['/api/files/browse', () => ({
      body: {
        ok: true,
        path: '/mnt',
        items: [
          { path: PATH_A, name: FILE_A, is_dir: false, size: 8_400_000_000 },
          { path: PATH_B, name: FILE_B, is_dir: false, size: 24_100_000_000 },
          { path: PATH_A2, name: FILE_A2, is_dir: false, size: 1_000_000_000 },
          { path: PATH_B2, name: FILE_B2, is_dir: false, size: 2_000_000_000 },
        ],
      },
    })],
  ]
}

function renderMixer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MediaMixer />
    </QueryClientProvider>,
  )
}

async function selectFile(pickerIndex: number, fileName: string) {
  const browseButtons = await screen.findAllByRole('button', { name: 'Examinar…' })
  fireEvent.click(browseButtons[pickerIndex])
  const nameCell = await screen.findByText(fileName)
  const row = nameCell.closest('.scan-file-item')
  if (!row) throw new Error('file row not rendered')
  fireEvent.doubleClick(row)
}

/** Pick both files and probe — lands in the results workspace. */
async function driveToResults(probe: Obj, extra: Route[] = []) {
  const calls = mockFetch([
    ...pickerHandlers(),
    ...extra,
    ['/api/mixer/tasks/t1', () => ({ body: { ok: true, task_id: 't1', subtitles: [] } })],
    ['/api/mixer/mux', () => ({ body: { ok: true, task_id: 't1', detail: 'Mux task queued' } })],
    ['/api/mixer/probe', () => ({ body: probe })],
    ['/api/mixer/tasks', () => ({ body: { tasks: [] } })],
  ])
  renderMixer()
  await selectFile(0, FILE_A)
  await selectFile(1, FILE_B)
  fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
  await screen.findByRole('button', { name: 'Mezclar' })
  return calls
}

afterEach(() => {
  clearToasts()
  vi.unstubAllGlobals()
})

/* ── S11-1/L30 — destino obligatorio ─────────────────────────────────────── */

describe('mixer — destino obligatorio (S11-1/L30)', () => {
  it('keeps «Mezclar» disabled until a destination is picked, then enables it for A and for B', async () => {
    await driveToResults(probeBody())

    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Carpeta de A' }))
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Carpeta de B' }))
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeEnabled()
  })

  it('sends destination_path = the chosen input path when folder A is picked', async () => {
    const calls = await driveToResults(probeBody())

    fireEvent.click(screen.getByRole('button', { name: 'Carpeta de A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))

    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))
    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.destination_path).toBe(PATH_A)
  })

  it('sends destination_path = the chosen input path when folder B is picked', async () => {
    const calls = await driveToResults(probeBody())

    fireEvent.click(screen.getByRole('button', { name: 'Carpeta de B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))

    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))
    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.destination_path).toBe(PATH_B)
  })

  it('informs the exact path to substitute, with the basename and folder of the replaced file', async () => {
    await driveToResults(probeBody())

    // No choice made → nothing claims to know the destination.
    expect(screen.queryByText('Destino:')).toBeNull()
    expect(screen.queryByText(/Sustituirá/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Carpeta de A' }))

    expect(screen.getByText('Destino:')).toBeInTheDocument()
    expect(screen.getByTitle(PATH_A)).toBeInTheDocument()
    expect(screen.getByText('Sustituirá Dune.Parte.Dos.2024.1080p.mkv (carpeta /mnt/movies)')).toBeInTheDocument()
  })

  it('re-disables «Mezclar» when the inputs change and the destination no longer matches', async () => {
    let probeCount = 0
    mockFetch([
      ...pickerHandlers(),
      ['/api/mixer/probe', () => ({ body: probeCount++ === 0 ? probeBody() : probeBody2() })],
      ['/api/mixer/mux', () => ({ body: { ok: true, task_id: 't1', detail: 'Mux task queued' } })],
      ['/api/mixer/tasks/t1', () => ({ body: { ok: true, task_id: 't1', subtitles: [] } })],
      ['/api/mixer/tasks', () => ({ body: { tasks: [] } })],
    ])
    renderMixer()
    await selectFile(0, FILE_A)
    await selectFile(1, FILE_B)
    fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
    await screen.findByRole('button', { name: 'Mezclar' })

    fireEvent.click(screen.getByRole('button', { name: 'Carpeta de A' }))
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeEnabled()

    // Back to the pickers and probe a DIFFERENT pair: the chosen path is no
    // longer one of the inputs, so it must stop authorizing the submit.
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await selectFile(0, FILE_A2)
    await selectFile(1, FILE_B2)
    fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
    await screen.findByRole('button', { name: 'Mezclar' })

    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeDisabled()
    expect(screen.queryByText(/Sustituirá/)).toBeNull()
  })
})

/* ── S11-2/L31 — toast «Enviado a la cola» ───────────────────────────────── */

describe('mixer — «Enviado a la cola» (S11-2/L31)', () => {
  it('toasts «Enviado a la cola» with the ok tone after a successful submit', async () => {
    const calls = await driveToResults(probeBody())

    fireEvent.click(screen.getByRole('button', { name: 'Carpeta de A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))

    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))
    await waitFor(() =>
      expect(
        getToasts().some((t) => t.message === 'Enviado a la cola' && t.tone === 'ok'),
      ).toBe(true),
    )
  })
})

/* ── S11-2/L31 — la sección «Tareas» sale del mixer ──────────────────────── */

describe('mixer — sin sección «Tareas» (S11-2/L31)', () => {
  const TASKS = [
    {
      task_id: 't1',
      status: 'running',
      progress: 0.4,
      detail: 'muxing',
      output_path: null,
      created_at: 2,
    },
    {
      task_id: 't0',
      status: 'paused',
      progress: 0.2,
      detail: 'paused',
      output_path: null,
      created_at: 1,
    },
  ]

  it('renders no «Tareas» section nor pause/cancel/resume controls even when tasks exist', async () => {
    await driveToResults(probeBody(), [
      ['/api/mixer/tasks/t1', () => ({ body: { ok: true, task_id: 't1', subtitles: [] } })],
      ['/api/mixer/tasks', () => ({ body: { tasks: TASKS } })],
    ])

    // The query stays alive (the subtitles panel rides on the latest task);
    // only the task list and its controls leave the page.
    expect(screen.queryByText('Tareas')).toBeNull()
    expect(screen.queryByRole('button', { name: '⏸ Pausar' })).toBeNull()
    expect(screen.queryByRole('button', { name: '▶ Reanudar' })).toBeNull()
    expect(screen.queryByRole('button', { name: '✕ Cancelar tarea' })).toBeNull()
  })
})

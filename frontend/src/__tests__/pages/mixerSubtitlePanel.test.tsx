import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'
import type { ReleaseSearchItem } from '../../features/release-search/ReleaseSearchModal.tsx'

/**
 * T8 — the subtitles panel (S6/S8): one row per audio language, a status chip
 * that combines the probe's subtitle_tracks with the mux task's `subtitles`
 * entry, and «Buscar subtítulos» → POST /api/mixer/tasks/:id/subtitles/search
 * (three-letter `language_code` values) → task refresh → chips update.
 */

vi.mock('../../features/release-search/ReleaseSearchModal.tsx', () => ({
  ReleaseSearchModal: ({ item }: { item: ReleaseSearchItem }) => (
    <div data-testid="release-search-modal">{item.title}</div>
  ),
}))

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const FILE_A = 'Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv'
const FILE_B = 'Dune.Parte.Dos.2024.2160p.HEVC.DDP5.1.mkv'
const PATH_A = '/mnt/a.mkv'
const PATH_B = '/mnt/b.mkv'

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

function audioOrdered(): Obj[] {
  return [
    audioEntry(),
    audioEntry({ index: 5, track_index: 1, codec: 'dts', language: 'eng', language_code: 'eng', default: false, file: 'b' }),
    audioEntry({ index: 2, track_index: 1, codec: 'ac3', language: 'rus', language_code: 'rus', bitrate: 448_000, default: false, file: 'a' }),
    audioEntry({ index: 3, track_index: 2, codec: 'aac', language: 'cat', language_code: 'cat', channels: 2, bitrate: 192_000, default: false, file: 'a' }),
  ]
}

function subtitleTrack(over: Obj = {}): Obj {
  return {
    index: 4,
    track_index: 0,
    codec: 'subrip',
    language: 'spa',
    language_code: 'spa',
    title: '',
    forced: false,
    default: false,
    kind: 'text',
    extractable: true,
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
        { index: 0, track_index: 0, codec: 'h264', width: 1920, height: 1080, fps: 23.976, bitrate: 12_400_000, selected: false },
      ],
      audio_tracks: [],
      subtitle_tracks: [
        subtitleTrack(),
        subtitleTrack({ index: 5, track_index: 1, codec: 'hdmv_pgs_subtitle', language: 'cat', language_code: 'cat', kind: 'bitmap', extractable: false }),
      ],
    },
    file_b: {
      filename: FILE_B,
      path: PATH_B,
      format: 'matroska,webm',
      duration: 6940,
      size_bytes: 24_100_000_000,
      video_tracks: [
        { index: 0, track_index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 23.976, bitrate: 5_800_000, selected: true },
      ],
      audio_tracks: [],
      subtitle_tracks: [],
    },
    compatibility: { ok: true, reasons: [], warnings: [] },
    language_check: { ok: true, missing: [], required: ['spa'] },
    best_video: {
      file: 'b',
      path: PATH_B,
      track_index: 0,
      codec: 'hevc',
      width: 3840,
      height: 2160,
      fps: 23.976,
      bitrate: 5_800_000,
    },
    audio_ordered: audioOrdered(),
    ...over,
  }
}

function taskSubtitle(over: Obj = {}): Obj {
  return {
    language_code: 'spa',
    language: 'es',
    path: PATH_A,
    track_index: 0,
    codec: 'subrip',
    extractable: true,
    status: 'pending',
    detail: '',
    sidecar: null,
    ...over,
  }
}

function taskWith(subtitles: Obj[]): Obj {
  return {
    ok: true,
    task_id: 't1',
    status: 'running',
    progress: 0.5,
    detail: 'muxing',
    output_path: '/mnt/Mixer/Dune.Parte.Dos.2024.mkv',
    created_at: 1,
    subtitles,
  }
}

/* ── Fetch harness ────────────────────────────────────────────────────────── */

type HandlerResult = { status?: number; body: unknown }
type Handler = () => HandlerResult | Promise<HandlerResult>
type Route = [string, Handler]

function mockFetch(handlers: Route[]) {
  const calls: { url: string; body: Obj | null }[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Obj) : null
    calls.push({ url, body })
    for (const [match, handler] of handlers) {
      if (url.includes(match)) {
        const r = await handler()
        const status = r.status ?? 200
        return { ok: status < 400, status, json: async () => r.body } as Response
      }
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response
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

async function driveToResults(probe: Obj, task: Obj | null, extra: Route[] = []) {
  const calls = mockFetch([
    ...pickerHandlers(),
    ['/api/mixer/tasks/t1/subtitles/search', () => ({ body: { ok: true, results: [] } })],
    ['/api/mixer/tasks/t1', () => ({ body: task ?? { ok: false, detail: 'Task not found' } })],
    ['/api/mixer/mux', () => ({ body: { ok: true, task_id: 't1', detail: 'Mux task started' } })],
    ['/api/mixer/probe', () => ({ body: probe })],
    ['/api/mixer/tasks', () => ({ body: { tasks: task ? [task] : [] } })],
    ...extra,
  ])
  renderMixer()
  await selectFile(0, FILE_A)
  await selectFile(1, FILE_B)
  fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
  await screen.findByRole('button', { name: 'Mezclar' })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ── Chips ────────────────────────────────────────────────────────────────── */

describe('mixer — subtítulos: chips por idioma (S6)', () => {
  it('shows «Extraído» with the sidecar name and «OpenSubtitles» for the downloaded one', async () => {
    await driveToResults(probeBody(), taskWith([
      taskSubtitle({ status: 'extracted', sidecar: '/mnt/Mixer/Dune.es.srt' }),
      taskSubtitle({ language_code: 'eng', language: 'en', status: 'downloaded', sidecar: '/mnt/Mixer/Dune.en.srt' }),
      taskSubtitle({ language_code: 'rus', language: 'ru', status: 'missing' }),
      taskSubtitle({ language_code: 'cat', language: 'ca', status: 'not_extractable', detail: 'bitmap: hdmv_pgs_subtitle' }),
    ]))

    expect(screen.getByText('Extraído')).toBeInTheDocument()
    expect(screen.getByText('Dune.es.srt')).toBeInTheDocument()
    expect(screen.getByText('OpenSubtitles')).toBeInTheDocument()
    expect(screen.getByText('Dune.en.srt')).toBeInTheDocument()
  })

  it('marks bitmap-only languages as «No extraíble (bitmap PGS)» with the codec detail', async () => {
    await driveToResults(probeBody(), taskWith([
      taskSubtitle(),
      taskSubtitle({ language_code: 'eng', language: 'en' }),
      taskSubtitle({ language_code: 'rus', language: 'ru' }),
      taskSubtitle({ language_code: 'cat', language: 'ca', status: 'not_extractable', detail: 'bitmap: hdmv_pgs_subtitle' }),
    ]))

    expect(screen.getByText('No extraíble (bitmap PGS)')).toBeInTheDocument()
    expect(screen.getByText('requiere OCR')).toBeInTheDocument()
  })

  it('shows «No encontrado» for failed / not_found entries', async () => {
    await driveToResults(probeBody(), taskWith([
      taskSubtitle(),
      taskSubtitle({ language_code: 'eng', language: 'en' }),
      taskSubtitle({ language_code: 'rus', language: 'ru', status: 'failed', detail: 'not_found' }),
      taskSubtitle({ language_code: 'cat', language: 'ca' }),
    ]))

    expect(screen.getByText('No encontrado')).toBeInTheDocument()
  })

  it('derives candidate chips from the probe when no task exists', async () => {
    await driveToResults(probeBody(), null)

    // spa has an extractable text track in A, cat only a bitmap PGS in A.
    expect(screen.getByText('Extraíble')).toBeInTheDocument()
    expect(screen.getByText('No extraíble (bitmap PGS)')).toBeInTheDocument()
    expect(screen.getAllByText('Sin pista embebida').length).toBe(2)
  })

  it('renders the dim OpenSubtitles key note and the no-transcode notes (S8)', async () => {
    await driveToResults(probeBody(), taskWith([
      taskSubtitle(),
      taskSubtitle({ language_code: 'eng', language: 'en' }),
      taskSubtitle({ language_code: 'rus', language: 'ru' }),
      taskSubtitle({ language_code: 'cat', language: 'ca' }),
    ]))

    expect(screen.getByText('Clave API de OpenSubtitles: Configuración → Servicios')).toBeInTheDocument()
    expect(
      screen.getByText('Los subtítulos embebidos no se copian al contenedor · solo .srt junto a la salida'),
    ).toBeInTheDocument()
    expect(screen.getByText('copia de streams, sin transcodificar (-c copy)')).toBeInTheDocument()
  })
})

/* ── «Buscar subtítulos» flow ─────────────────────────────────────────────── */

describe('mixer — «Buscar subtítulos» (S6/T6)', () => {
  it('is disabled when no mux task exists', async () => {
    await driveToResults(probeBody(), null)

    expect(screen.getByRole('button', { name: 'Buscar subtítulos' })).toBeDisabled()
  })

  it('searches the searchable languages by three-letter code and updates the chips', async () => {
    let taskState: Obj = taskWith([
      taskSubtitle(),
      taskSubtitle({ language_code: 'eng', language: 'en' }),
      taskSubtitle({ language_code: 'rus', language: 'ru', status: 'missing' }),
      taskSubtitle({ language_code: 'cat', language: 'ca', status: 'not_extractable', detail: 'bitmap: hdmv_pgs_subtitle' }),
    ])

    let releaseSearch: (() => void) | null = null
    const calls = mockFetch([
      ...pickerHandlers(),
      ['/api/mixer/tasks/t1/subtitles/search', () => new Promise<HandlerResult>((resolve) => {
        releaseSearch = () => {
          taskState = {
            ...taskState,
            subtitles: [
              taskSubtitle(),
              taskSubtitle({ language_code: 'eng', language: 'en' }),
              taskSubtitle({ language_code: 'rus', language: 'ru', status: 'downloaded', sidecar: '/mnt/Mixer/Dune.ru.srt' }),
              taskSubtitle({ language_code: 'cat', language: 'ca', status: 'not_extractable', detail: 'bitmap: hdmv_pgs_subtitle' }),
            ],
          }
          resolve({ body: { ok: true, results: [] } })
        }
      })],
      ['/api/mixer/tasks/t1', () => ({ body: taskState })],
      ['/api/mixer/mux', () => ({ body: { ok: true, task_id: 't1', detail: 'Mux task started' } })],
      ['/api/mixer/probe', () => ({ body: probeBody() })],
      ['/api/mixer/tasks', () => ({ body: { tasks: [taskState] } })],
    ])
    renderMixer()
    await selectFile(0, FILE_A)
    await selectFile(1, FILE_B)
    fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
    await screen.findByRole('button', { name: 'Mezclar' })

    fireEvent.click(screen.getByRole('button', { name: 'Buscar subtítulos' }))

    // In flight: the two searchable rows show «Buscando…».
    expect((await screen.findAllByText('Buscando…')).length).toBe(2)

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/mixer/tasks/t1/subtitles/search'))).toBe(true),
    )
    const post = calls.find((c) => c.url.includes('/api/mixer/tasks/t1/subtitles/search'))
    expect(post?.body).toEqual({ languages: ['rus', 'cat'] })

    // Resolve the POST → the task refresh flips rus to «OpenSubtitles».
    if (!releaseSearch) throw new Error('search promise not armed')
    releaseSearch()

    expect(await screen.findByText('Dune.ru.srt')).toBeInTheDocument()
    expect(screen.getByText('OpenSubtitles')).toBeInTheDocument()
    expect(screen.queryByText('Buscando…')).toBeNull()
  })
})

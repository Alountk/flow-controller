import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'

/**
 * T3 (S2/S3) — language selectors on every audio row and every subtitle row:
 * re-tagging sends `language_overrides` only when the choice differs from the
 * probe, and `subtitle_languages` (row order) only when a subtitle row differs
 * from its derived default. «Buscar subtítulos» searches the CHOSEN codes.
 */

const LANGUAGE_LABELS = [
  'Castellano', 'Inglés', 'Ruso', 'Catalán', 'Francés', 'Alemán',
  'Italiano', 'Portugués', 'Japonés', 'Coreano', 'Chino', 'Desconocido',
]

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

function pickDest(label: 'Carpeta de A' | 'Carpeta de B' = 'Carpeta de A') {
  fireEvent.click(screen.getByRole('button', { name: label }))
}

async function driveToResults(probe: Obj, task: Obj | null) {
  const calls = mockFetch([
    ...pickerHandlers(),
    ['/api/mixer/tasks/t1/subtitles/search', () => ({ body: { ok: true, results: [] } })],
    ['/api/mixer/tasks/t1', () => ({ body: task ?? { ok: false, detail: 'Task not found' } })],
    ['/api/mixer/mux', () => ({ body: { ok: true, task_id: 't1', detail: 'Mux task started' } })],
    ['/api/mixer/probe', () => ({ body: probe })],
    ['/api/mixer/tasks', () => ({ body: { tasks: task ? [task] : [] } })],
  ])
  renderMixer()
  await selectFile(0, FILE_A)
  await selectFile(1, FILE_B)
  fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
  await screen.findByRole('button', { name: 'Mezclar' })
  return calls
}

function audioSelects(): HTMLSelectElement[] {
  return screen.getAllByRole('combobox', { name: 'Idioma de la pista' }) as HTMLSelectElement[]
}

function subtitleSelects(): HTMLSelectElement[] {
  return screen.getAllByRole('combobox', { name: 'Idioma del subtítulo' }) as HTMLSelectElement[]
}

function optionLabels(select: HTMLSelectElement): (string | null)[] {
  return [...select.querySelectorAll('option')].map((o) => o.textContent)
}

async function submitMux(calls: { url: string; body: Obj | null }[]) {
  pickDest()
  fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
  await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))
  return calls.find((c) => c.url.includes('/api/mixer/mux'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ── S2 — audio row selectors ─────────────────────────────────────────────── */

describe('mixer — selector de idioma en pistas de audio (S2/T3)', () => {
  it('offers a select with the 12 LANGUAGE_LABELS options (incl. Desconocido) on every audio row', async () => {
    await driveToResults(probeBody(), taskWith([]))

    const selects = audioSelects()
    expect(selects).toHaveLength(4)
    for (const select of selects) {
      expect(optionLabels(select)).toEqual(LANGUAGE_LABELS)
    }
    // Defaults are the probed codes in delivered order.
    expect(selects.map((s) => s.value)).toEqual(['spa', 'eng', 'rus', 'cat'])
  })

  it('sends language: fra in language_overrides when a non-und row is set to «Francés»', async () => {
    const calls = await driveToResults(probeBody(), taskWith([]))

    fireEvent.change(audioSelects()[1], { target: { value: 'fra' } })
    const muxCall = await submitMux(calls)

    expect(muxCall?.body?.language_overrides).toEqual([
      { path: PATH_B, track_index: 1, language: 'fra' },
    ])
    // The re-derived subtitle rows all keep their defaults → no new field.
    expect(muxCall?.body).not.toHaveProperty('subtitle_languages')
  })

  it('sends NO override when a changed row comes back to its probed language', async () => {
    const calls = await driveToResults(probeBody(), taskWith([]))

    fireEvent.change(audioSelects()[1], { target: { value: 'fra' } })
    fireEvent.change(audioSelects()[1], { target: { value: 'eng' } })
    const muxCall = await submitMux(calls)

    expect(muxCall?.body).not.toHaveProperty('language_overrides')
    expect(muxCall?.body).not.toHaveProperty('subtitle_languages')
  })
})

/* ── S3 — subtitle row selectors ──────────────────────────────────────────── */

describe('mixer — selector por fila en subtítulos (S3/T3)', () => {
  it('offers a select on every subtitle row, defaulting to the derived language', async () => {
    await driveToResults(probeBody(), taskWith([]))

    const selects = subtitleSelects()
    expect(selects).toHaveLength(4)
    for (const select of selects) {
      expect(optionLabels(select)).toEqual(LANGUAGE_LABELS)
    }
    expect(selects.map((s) => s.value)).toEqual(['spa', 'eng', 'rus', 'cat'])
  })

  it('sends subtitle_languages in row order when one row is re-tagged', async () => {
    const calls = await driveToResults(probeBody(), taskWith([]))

    fireEvent.change(subtitleSelects()[1], { target: { value: 'ita' } })
    const muxCall = await submitMux(calls)

    expect(muxCall?.body?.subtitle_languages).toEqual(['spa', 'ita', 'rus', 'cat'])
    // Subtitle rows never produce audio overrides.
    expect(muxCall?.body).not.toHaveProperty('language_overrides')
  })

  it('omits subtitle_languages entirely when every row keeps its derived default', async () => {
    const calls = await driveToResults(probeBody(), taskWith([]))

    const muxCall = await submitMux(calls)

    expect(muxCall?.body).not.toHaveProperty('subtitle_languages')
  })

  it('searches «Buscar subtítulos» with the CHOSEN codes', async () => {
    const calls = await driveToResults(probeBody(), taskWith([
      taskSubtitle({ status: 'extracted', sidecar: '/mnt/Mixer/Dune.es.srt' }),
      taskSubtitle({ language_code: 'eng', language: 'en' }),
      taskSubtitle({ language_code: 'rus', language: 'ru', status: 'missing' }),
      taskSubtitle({ language_code: 'cat', language: 'ca', status: 'not_extractable', detail: 'bitmap: hdmv_pgs_subtitle' }),
    ]))

    // The rus row is searchable — re-tag it and search under the new code.
    fireEvent.change(subtitleSelects()[2], { target: { value: 'deu' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar subtítulos' }))

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/mixer/tasks/t1/subtitles/search'))).toBe(true),
    )
    const post = calls.find((c) => c.url.includes('/api/mixer/tasks/t1/subtitles/search'))
    expect(post?.body).toEqual({ languages: ['deu', 'cat'] })
  })
})

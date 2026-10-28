import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'

/**
 * Orden de salida de las pistas de audio (decisión del usuario 2026-10-21):
 * las filas marcadas se reordenan con ▲▼ y `audio_sources` sale en ese orden
 * — `build_mux_command` hace `-map` en orden de array, así que el orden de
 * salida es exactamente el orden renderizado del payload. Los badges 1..n
 * (`mixer-audio-num`) ya numeraban entre las marcadas; ahora el orden es
 * manipulable.
 */

type Obj = Record<string, unknown>

const FILE_A = 'Pelis.2024.1080p.WEB-DL.x264.mkv'
const FILE_B = 'Pelis.2024.2160p.HEVC.DDP5.1.mkv'
const PATH_A = '/mnt/a.mkv'
const PATH_B = '/mnt/b.mkv'

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

function probeBody(): Obj {
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
      subtitle_tracks: [],
    },
    file_b: {
      filename: FILE_B,
      path: PATH_B,
      format: 'matroska,webm',
      duration: 6940,
      size_bytes: 24_100_000_000,
      video_tracks: [
        { index: 0, track_index: 0, codec: 'h264', width: 1920, height: 1080, fps: 23.976, bitrate: 12_100_000, selected: false },
        { index: 3, track_index: 1, codec: 'hevc', width: 3840, height: 2160, fps: 23.976, bitrate: 5_800_000, selected: true },
      ],
      audio_tracks: [],
      subtitle_tracks: [],
    },
    compatibility: { ok: true, reasons: [], warnings: [] },
    language_check: { ok: true, missing: [], required: ['spa'] },
    best_video: {
      file: 'b',
      path: PATH_B,
      track_index: 1,
      codec: 'hevc',
      width: 3840,
      height: 2160,
      fps: 23.976,
      bitrate: 5_800_000,
    },
    // The backend's delivered order: spa → eng → rus (all three auto-checked).
    audio_ordered: [
      audioEntry(),
      audioEntry({ index: 5, track_index: 1, codec: 'dts', language: 'eng', language_code: 'eng', bitrate: 1_509_000, default: false, file: 'b' }),
      audioEntry({ index: 2, track_index: 1, codec: 'ac3', language: 'rus', language_code: 'rus', bitrate: 448_000, default: false, file: 'a' }),
    ],
  }
}

/* ── Fetch harness (same pattern as the sibling mixer test files) ──────────── */

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
    ['/api/mixer/tasks', () => ({ body: { tasks: [] } })],
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

/** Pick both files, probe — lands in the results workspace with the audio list. */
async function driveToResults(probe: Obj = probeBody()) {
  const calls = mockFetch([
    ...pickerHandlers(),
    ['/api/mixer/tasks/t1/subtitles/search', () => ({ body: { ok: true, results: [] } })],
    ['/api/mixer/tasks/t1', () => ({ body: { ok: true, task_id: 't1' } })],
    ['/api/mixer/mux', () => ({ body: { ok: true, task_id: 't1', detail: 'Mux task started' } })],
    ['/api/mixer/probe', () => ({ body: probe })],
  ])
  renderMixer()
  await selectFile(0, FILE_A)
  await selectFile(1, FILE_B)
  fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
  await screen.findByRole('button', { name: 'Mezclar' })
  return calls
}

function audioRow(langName: string): HTMLElement {
  const list = document.querySelector('.mixer-audio-list')
  if (!list) throw new Error('audio list not rendered')
  // Match `.mixer-lang-name` only: the row's select also renders every option label.
  const names = [...list.querySelectorAll('.mixer-lang-name')]
  const row = names.find((n) => n.textContent === langName)?.closest('.mixer-audio-row')
  if (!row) throw new Error(`audio row for ${langName} not rendered`)
  return row as HTMLElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mixer — orden de salida de las pistas de audio (▲▼ + índice 1..n)', () => {
  it('subir una pista marcada reordena el payload audio_sources y su índice', async () => {
    const calls = await driveToResults()

    // eng is second (badge 2) — move it up.
    const engRow = audioRow('Inglés')
    expect(within(engRow).getByText('2')).toBeInTheDocument()
    fireEvent.click(within(engRow).getByTitle('Subir posición'))
    expect(within(engRow).getByText('1')).toBeInTheDocument()

    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))

    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.audio_sources).toEqual([
      { path: PATH_B, track_index: 1 }, // eng — movida a la posición de salida 1
      { path: PATH_A, track_index: 0 }, // spa — ahora 2
      { path: PATH_A, track_index: 1 }, // rus — 3
    ])
  })

  it('el índice numera solo entre las pistas marcadas (baja al desmarcar)', async () => {
    await driveToResults()

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[0]) // spa fuera

    expect(within(audioRow('Castellano')).getByText('—')).toBeInTheDocument()
    expect(within(audioRow('Inglés')).getByText('1')).toBeInTheDocument()
    expect(within(audioRow('Ruso')).getByText('2')).toBeInTheDocument()
  })

  it('bajar la primera marcada la coloca en la segunda posición y bloquea ▲ en el borde', async () => {
    const calls = await driveToResults()

    const spaRow = audioRow('Castellano')
    // Top boundary: ▲ must be disabled (no wrap).
    expect(within(spaRow).getByTitle('Subir posición')).toBeDisabled()
    fireEvent.click(within(spaRow).getByTitle('Bajar posición'))
    expect(within(spaRow).getByText('2')).toBeInTheDocument()

    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))

    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.audio_sources).toEqual([
      { path: PATH_B, track_index: 1 }, // eng — sube a la posición de salida 1
      { path: PATH_A, track_index: 0 }, // spa — movida a 2
      { path: PATH_A, track_index: 1 }, // rus — 3
    ])
  })
})

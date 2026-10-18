import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'
import type { ReleaseSearchItem } from '../../features/release-search/ReleaseSearchModal.tsx'

/**
 * T8 — the Stitch 10/11/12 port (S1–S8): cotejo badge that blocks, merged
 * ordered audio («4 automáticas, resto a elegir»), best-video auto-selection
 * across A and B, and the L18 ordinal payload contract
 * (`MuxRequest.track_index` = the stream's ordinal inside its own file, never
 * ffprobe's absolute `index`).
 */

vi.mock('../../features/release-search/ReleaseSearchModal.tsx', () => ({
  ReleaseSearchModal: ({
    item,
    onGrabStarted,
  }: {
    item: ReleaseSearchItem
    onGrabStarted?: (taskId: string) => void
  }) => (
    <div data-testid="release-search-modal">
      <span>{item.title}</span>
      <span data-testid="modal-languages">{(item.languages ?? []).join(',')}</span>
      <button type="button" onClick={() => onGrabStarted?.('grab-1')}>
        Simular grab
      </button>
    </div>
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

/** The merged list as the backend delivers it: ca→en→ru→cat, then others. */
function defaultAudioOrdered(): Obj[] {
  return [
    audioEntry(),
    audioEntry({ index: 5, track_index: 1, codec: 'dts', language: 'eng', language_code: 'eng', bitrate: 1_509_000, default: false, file: 'b' }),
    audioEntry({ index: 2, track_index: 1, codec: 'ac3', language: 'rus', language_code: 'rus', bitrate: 448_000, default: false, file: 'a' }),
    audioEntry({ index: 3, track_index: 2, codec: 'aac', language: 'cat', language_code: 'cat', channels: 2, bitrate: 192_000, default: false, file: 'a' }),
    audioEntry({ index: 6, track_index: 2, codec: 'ac3', language: 'fra', language_code: 'fra', bitrate: 448_000, default: false, file: 'b', selected: false }),
    audioEntry({ index: 7, track_index: 3, codec: 'ac3', language: 'deu', language_code: 'deu', bitrate: 384_000, default: false, file: 'b', selected: false }),
  ]
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
        // Absolute ffprobe index 3, ordinal 1 — L18 must send the ordinal.
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
    audio_ordered: defaultAudioOrdered(),
    ...over,
  }
}

function incompatibleProbe(): Obj {
  const body = probeBody({
    compatibility: {
      ok: false,
      reasons: ['fps_mismatch', 'duration_mismatch'],
      warnings: [
        { type: 'fps_mismatch', message: 'FPS differs: 23.976 vs 25.0', file_a_value: 23.976, file_b_value: 25.0 },
        { type: 'duration_mismatch', message: 'Duration differs by 3.9%: 6942.0s vs 7212.0s', file_a_value: 6942, file_b_value: 7212 },
      ],
    },
  })
  const fileB = body.file_b as Obj
  fileB.duration = 7212
  fileB.video_tracks = [
    { index: 0, track_index: 0, codec: 'h264', width: 1920, height: 1080, fps: 25.0, bitrate: 12_100_000, selected: false },
    { index: 3, track_index: 1, codec: 'hevc', width: 3840, height: 2160, fps: 25.0, bitrate: 5_800_000, selected: true },
  ]
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

/** S11/L30 — the destination is now one more «Mezclar» gate: pick one so a
 *  later assertion can care about a DIFFERENT reason for the button state. */
function pickDest(label: 'Carpeta de A' | 'Carpeta de B' = 'Carpeta de A') {
  fireEvent.click(screen.getByRole('button', { name: label }))
}

/** Pick both files and probe — lands in the results workspace. */
async function driveToResults(probe: Obj, extra: Route[] = []) {
  // `extra` comes first so a test can override any default route (e.g. /mux).
  const calls = mockFetch([
    ...pickerHandlers(),
    ...extra,
    ['/api/mixer/tasks/t1/subtitles/search', () => ({ body: { ok: true, results: [] } })],
    ['/api/mixer/tasks/t1', () => ({ body: { ok: true, task_id: 't1' } })],
    ['/api/mixer/mux', () => ({ body: { ok: true, task_id: 't1', detail: 'Mux task started' } })],
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
  vi.unstubAllGlobals()
})

/* ── S3 · mockup 10 — cotejo compatible ───────────────────────────────────── */

describe('mixer — cotejo compatible (S3, mockup 10)', () => {
  it('shows the green «Compatible» badge with the fps and duration values', async () => {
    await driveToResults(probeBody())

    expect(screen.getByText('Compatible')).toBeInTheDocument()
    expect(screen.getByText('fps A 23.976 · B 23.976')).toBeInTheDocument()
    expect(screen.getByText(/duración A 1 h 55 min 42 s · B 1 h 55 min 40 s/)).toBeInTheDocument()
    expect(screen.getByText('(Δ 2 s)')).toBeInTheDocument()
  })

  it('enables «Mezclar» when compatibility, language check, selections and destination are good', async () => {
    await driveToResults(probeBody())

    pickDest()
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeEnabled()
  })
})

/* ── S3 · mockup 11 — cotejo no compatible ────────────────────────────────── */

describe('mixer — cotejo no compatible (S3, mockup 11)', () => {
  it('shows the red «No compatible» badge with the reasons and A|B values side by side', async () => {
    await driveToResults(incompatibleProbe())

    expect(screen.getByText('No compatible')).toBeInTheDocument()
    expect(screen.getByText('fps:')).toBeInTheDocument()
    expect(screen.getByText('A 23.976')).toBeInTheDocument()
    expect(screen.getByText('B 25.000')).toBeInTheDocument()
    expect(screen.getByText('duración:')).toBeInTheDocument()
    expect(screen.getByText('A 1h 55m 42s')).toBeInTheDocument()
    expect(screen.getByText('B 2h 00m 12s (Δ 4 min 30 s)')).toBeInTheDocument()
  })

  it('gives «Mezclar» a real disabled attribute when the files are not compatible', async () => {
    await driveToResults(incompatibleProbe())

    pickDest()
    const mezclar = screen.getByRole('button', { name: 'Mezclar' })
    expect(mezclar).toBeDisabled()
    expect(mezclar.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Mezclado bloqueado: los fps o la duración no coinciden entre A y B')).toBeInTheDocument()
  })

  it('surfaces the 409 detail.error from /mux and flips the badge red', async () => {
    const calls = await driveToResults(probeBody(), [
      ['/api/mixer/mux', () => ({
        status: 409,
        body: {
          detail: {
            error: 'incompatible',
            reasons: ['fps_mismatch'],
            compatibility: {
              ok: false,
              reasons: ['fps_mismatch'],
              warnings: [
                { type: 'fps_mismatch', message: 'FPS differs', file_a_value: 23.976, file_b_value: 25.0 },
              ],
            },
          },
        },
      })],
    ])

    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))

    expect(await screen.findByText('incompatible')).toBeInTheDocument()
    expect(screen.getByText('No compatible')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true)
  })

  it('disables «Mezclar» while no audio track is checked', async () => {
    await driveToResults(probeBody())

    pickDest()
    for (const box of screen.getAllByRole('checkbox')) {
      if ((box as HTMLInputElement).checked) fireEvent.click(box)
    }

    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeDisabled()
  })
})

/* ── S2/L14 · mockup 12 — idioma exigido ausente ──────────────────────────── */

describe('mixer — idioma exigido ausente (S2/L14, mockup 12)', () => {
  it('disables «Mezclar» when the required-language check fails', async () => {
    await driveToResults(
      probeBody({ language_check: { ok: false, missing: ['spa'], required: ['spa'] } }),
    )

    pickDest()
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeDisabled()
  })

  it('keeps the T7 notice with the «Bloqueante» chip and the indexer button', async () => {
    await driveToResults(
      probeBody({ language_check: { ok: false, missing: ['spa'], required: ['spa'] } }),
    )

    expect(screen.getByText('Falta castellano (exigido) en los dos archivos')).toBeInTheDocument()
    expect(screen.getByText('Bloqueante')).toBeInTheDocument()
    expect(
      screen.getByText('Castellano es el mínimo obligatorio; basta con que lo tenga uno de los dos archivos.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Buscar en el indexador' })).toBeInTheDocument()
  })
})

/* ── L24/T10 — marcar pista und como castellano ─────────────────────────── */

describe('mixer — marcar und como castellano (L24/T10)', () => {
  const undMissingProbe = () =>
    probeBody({
      language_check: { ok: false, missing: ['spa'], required: ['spa'] },
      audio_ordered: [
        audioEntry({ language: 'und', language_code: 'und', selected: false, default: false }),
        ...defaultAudioOrdered().slice(1),
      ],
    })

  it('offers «Marcar como castellano» on und rows and clears the block when marked', async () => {
    await driveToResults(undMissingProbe())

    pickDest()
    expect(screen.getByText('Falta castellano (exigido) en los dos archivos')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Marcar como castellano' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Marcar como castellano' }))

    expect(screen.queryByText('Falta castellano (exigido) en los dos archivos')).toBeNull()
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Quitar marca' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Marcar como castellano' })).toBeNull()
  })

  it('sends language_overrides for the marked und track in the mux payload', async () => {
    const calls = await driveToResults(undMissingProbe())

    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como castellano' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))

    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.language_overrides).toEqual([
      { path: PATH_A, track_index: 0, language: 'spa' },
    ])
  })

  it('does not offer the mark on non-und rows', async () => {
    await driveToResults(probeBody())

    expect(screen.queryByRole('button', { name: 'Marcar como castellano' })).toBeNull()
  })

  it('re-blocks when the mark is removed', async () => {
    await driveToResults(undMissingProbe())

    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como castellano' }))
    fireEvent.click(screen.getByRole('button', { name: 'Quitar marca' }))

    expect(screen.getByText('Falta castellano (exigido) en los dos archivos')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mezclar' })).toBeDisabled()
  })
})

/* ── S4/L18 — vídeo por mejor compresión ──────────────────────────────────── */

describe('mixer — vídeo por mejor compresión (S4, L18)', () => {
  it('highlights the best_video row even when it lives in file B', async () => {
    await driveToResults(probeBody())

    expect(screen.getByText('Auto · mejor compresión')).toBeInTheDocument()
    const rows = document.querySelectorAll('.mixer-video-row')
    expect(rows.length).toBe(3)
    expect(rows[2].textContent).toContain('2160p')
    expect(rows[2].textContent).toContain('Auto · mejor compresión')
    expect(rows[0].textContent).toContain('Pista original A')
    expect(rows[1].textContent).toContain('Pista original B')

    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.checked)).toEqual([false, false, true])
  })

  it('sends the video as file B path + ordinal track_index, never the absolute index', async () => {
    const calls = await driveToResults(probeBody())

    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))

    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.video_source).toEqual({ path: PATH_B, track_index: 1 })
  })

  it('documents the ranking order the backend implements (resolución > codec > bitrate)', async () => {
    await driveToResults(probeBody())

    expect(screen.getByText(/resolución > codec > bitrate/)).toBeInTheDocument()
  })
})

/* ── S2/S5/L18 — audio ordenado ───────────────────────────────────────────── */

describe('mixer — audio ordenado (S2/S5, L18)', () => {
  it('renders the merged list in delivered order with the 4 automáticas checked', async () => {
    await driveToResults(probeBody())

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true, true, false, false])

    const rows = document.querySelectorAll('.mixer-audio-row')
    const names = ['Castellano', 'Inglés', 'Ruso', 'Catalán', 'Francés', 'Alemán']
    rows.forEach((row, i) => {
      expect(row.textContent).toContain(names[i])
    })
    expect(screen.getByText('Otros idiomas · elegir a mano')).toBeInTheDocument()
    expect(screen.getByText('4 seleccionadas · 2 omitidas')).toBeInTheDocument()
  })

  it('lets unchecked rows be checked and the auto rows be unchecked', async () => {
    await driveToResults(probeBody())

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[1]) // Inglés out
    fireEvent.click(boxes[4]) // Francés in

    const after = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(after.map((b) => b.checked)).toEqual([true, false, true, true, true, false])
  })

  it('sends audio_sources as the checked rows in rendered order with ordinal track_index', async () => {
    const calls = await driveToResults(probeBody())

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[1]) // Inglés out
    fireEvent.click(boxes[4]) // Francés in
    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))

    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.audio_sources).toEqual([
      { path: PATH_A, track_index: 0 }, // spa — ordinal 0 (absolute index 1)
      { path: PATH_A, track_index: 1 }, // rus — ordinal 1 (absolute index 2)
      { path: PATH_A, track_index: 2 }, // cat — ordinal 2 (absolute index 3)
      { path: PATH_B, track_index: 2 }, // fra — ordinal 2 (absolute index 6)
    ])
  })

  it('defaults the mux payload to the 4 automáticas in delivered order', async () => {
    const calls = await driveToResults(probeBody())

    pickDest()
    fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/mixer/mux'))).toBe(true))

    const muxCall = calls.find((c) => c.url.includes('/api/mixer/mux'))
    expect(muxCall?.body?.audio_sources).toEqual([
      { path: PATH_A, track_index: 0 }, // spa
      { path: PATH_B, track_index: 1 }, // eng — ordinal 1, NOT absolute index 5
      { path: PATH_A, track_index: 1 }, // rus
      { path: PATH_A, track_index: 2 }, // cat
    ])
    expect(muxCall?.body).toEqual({
      video_source: { path: PATH_B, track_index: 1 },
      audio_sources: [
        { path: PATH_A, track_index: 0 },
        { path: PATH_B, track_index: 1 },
        { path: PATH_A, track_index: 1 },
        { path: PATH_A, track_index: 2 },
      ],
      // S11/L30 — the UI always sends the destination of the mix.
      destination_path: PATH_A,
    })
  })
})

/* ── S10/T11 — descarga de alternativa desde los slots ───────────────────── */

describe('mixer — descarga de alternativa (S10/T11)', () => {
  const ALT_TITLE = 'Dune Parte Dos 2024'
  const ALT_PATH = '/mnt/dl/Dune.Parte.Dos.2024.mkv'
  const ALT_BASENAME = 'Dune.Parte.Dos.2024.mkv'

  /** The exact JSON shapes of T11's contract. */
  function lookupBody(over: Obj = {}): Obj {
    return {
      ok: true,
      title: ALT_TITLE,
      movie: { id: 7, title: 'Dune: Part Two', year: 2024, source: 'radarr' },
      audio_languages: ['spa', 'eng'],
      ...over,
    }
  }

  function statusBody(over: Obj = {}): Obj {
    return { state: 'unknown', progress: null, path: null, allowed: false, ...over }
  }

  function altRoutes(lookup: Obj, status: Obj): Route[] {
    return [
      ['/api/mixer/alternatives/lookup', () => ({ body: lookup })],
      ['/api/mixer/alternatives/status', () => ({ body: status })],
    ]
  }

  const altButtons = () =>
    screen.queryAllByRole('button', { name: 'Buscar y descargar alternativa' })

  /** Fill ONE slot and leave the pickers on screen — the other stays empty. */
  async function driveToOneSlot(filled: 'a' | 'b', routes: Route[] = []) {
    const calls = mockFetch([
      ...pickerHandlers(),
      ...routes,
      ['/api/mixer/tasks', () => ({ body: { tasks: [] } })],
    ])
    renderMixer()
    await selectFile(filled === 'a' ? 0 : 1, filled === 'a' ? FILE_A : FILE_B)
    return calls
  }

  /** Click the slot button → wait for the modal → fire its grab. */
  async function startGrab() {
    fireEvent.click(screen.getByRole('button', { name: 'Buscar y descargar alternativa' }))
    await screen.findByTestId('release-search-modal')
    fireEvent.click(screen.getByRole('button', { name: 'Simular grab' }))
  }

  it('offers «Buscar y descargar alternativa» only on the empty slot when the other holds a file', async () => {
    await driveToOneSlot('a')

    expect(altButtons()).toHaveLength(1)
    const card = altButtons()[0].closest('.mixer-file-input') as HTMLElement
    expect(within(card).getByText('Archivo B')).toBeInTheDocument()

    // Both slots hold a file → there is nothing to replace.
    await selectFile(1, FILE_B)
    expect(altButtons()).toHaveLength(0)
  })

  it('mirrors the button to slot A when only slot B holds a file, and hides it while both are empty', async () => {
    mockFetch([...pickerHandlers(), ['/api/mixer/tasks', () => ({ body: { tasks: [] } })]])
    renderMixer()
    await screen.findAllByRole('button', { name: 'Examinar…' })
    expect(altButtons()).toHaveLength(0)

    await selectFile(1, FILE_B)
    expect(altButtons()).toHaveLength(1)
    const card = altButtons()[0].closest('.mixer-file-input') as HTMLElement
    expect(within(card).getByText('Archivo A')).toBeInTheDocument()
  })

  it('puts the slot in the wait state when the grab starts, polling only while waiting', async () => {
    const calls = await driveToOneSlot(
      'a',
      altRoutes(lookupBody(), statusBody({ state: 'downloading', progress: 37 })),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Buscar y descargar alternativa' }))

    // The lookup takes the OTHER slot's path — the title comes from that file.
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/mixer/alternatives/lookup'))).toBe(true),
    )
    expect(calls.find((c) => c.url.includes('/api/mixer/alternatives/lookup'))?.body).toEqual({
      path: PATH_A,
    })

    await screen.findByTestId('release-search-modal')
    // Honesty: no status poll before the wait starts.
    expect(calls.some((c) => c.url.includes('/api/mixer/alternatives/status'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Simular grab' }))

    expect(await screen.findByText(`Descargando… ${ALT_TITLE}`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dejar de esperar' })).toBeInTheDocument()
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/mixer/alternatives/status'))).toBe(true),
    )
    expect(await screen.findByText('37%')).toBeInTheDocument()
  })

  it('auto-places the ready file in the waiting slot with the «Colocado automáticamente» notice', async () => {
    await driveToOneSlot(
      'a',
      altRoutes(
        lookupBody(),
        statusBody({ state: 'ready', progress: null, path: ALT_PATH, allowed: true }),
      ),
    )

    await startGrab()

    expect(
      await screen.findByText(`Colocado automáticamente: ${ALT_BASENAME}`),
    ).toBeInTheDocument()
    // The slot took the path (its onSelect) and the wait is over.
    expect(screen.getByTitle(ALT_PATH)).toBeInTheDocument()
    expect(screen.queryByText(/Descargando…/)).toBeNull()
  })

  it('warns without placing when the ready file is outside allowed_roots', async () => {
    await driveToOneSlot(
      'a',
      altRoutes(
        lookupBody(),
        statusBody({ state: 'ready', progress: null, path: ALT_PATH, allowed: false }),
      ),
    )

    await startGrab()

    expect(
      await screen.findByText(
        `El fichero quedó en ${ALT_PATH} — añade esa carpeta a allowed_roots`,
      ),
    ).toBeInTheDocument()
    // Nothing was placed and nothing else was touched.
    expect(screen.queryByText(/Colocado automáticamente/)).toBeNull()
    expect(screen.getByText('Sin seleccionar')).toBeInTheDocument()
    expect(screen.getByTitle(PATH_A)).toBeInTheDocument()
  })

  it('«Dejar de esperar» returns to the initial button and touches nothing else', async () => {
    await driveToOneSlot(
      'a',
      altRoutes(lookupBody(), statusBody({ state: 'downloading', progress: 10 })),
    )

    await startGrab()
    await screen.findByText(/Descargando…/)

    fireEvent.click(screen.getByRole('button', { name: 'Dejar de esperar' }))

    expect(screen.queryByText(/Descargando…/)).toBeNull()
    expect(altButtons()).toHaveLength(1)
    expect(screen.getByTitle(PATH_A)).toBeInTheDocument()
    expect(screen.getByText('Sin seleccionar')).toBeInTheDocument()
  })

  it('opens the modal with the lookup movie and item.languages from audio_languages', async () => {
    const calls = await driveToOneSlot(
      'a',
      altRoutes(lookupBody({ audio_languages: ['spa', 'eng', 'rus'] }), statusBody()),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Buscar y descargar alternativa' }))

    const modal = await screen.findByTestId('release-search-modal')
    expect(within(modal).getByText('Dune: Part Two')).toBeInTheDocument()
    expect(screen.getByTestId('modal-languages').textContent).toBe('spa,eng,rus')
    expect(calls.find((c) => c.url.includes('/api/mixer/alternatives/lookup'))?.body).toEqual({
      path: PATH_A,
    })
  })

  it('keeps the T7 «añádela primero en Radarr» notice when the lookup finds no library movie', async () => {
    await driveToOneSlot('a', altRoutes(lookupBody({ movie: null }), statusBody()))

    fireEvent.click(screen.getByRole('button', { name: 'Buscar y descargar alternativa' }))

    expect(
      await screen.findByText(`${ALT_TITLE} no está en la librería — añádela primero en Radarr`),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('release-search-modal')).toBeNull()
  })
})

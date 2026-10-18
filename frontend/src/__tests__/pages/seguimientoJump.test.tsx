import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../app/App.tsx'
import { setUnauthorizedHandler } from '../../shared/api/auth.ts'
import type { QueueOp } from '../../shared/api/files.ts'
import { clearToasts, getToasts } from '../../shared/utils/toast.ts'

/**
 * T3/S1 end to end — decision L4: «Al pulsar Mezclar → /seguimiento con
 * «mezcla X» destacada en la lista (borde de acento)».
 *
 * The unit halves are pinned where they live (MediaMixer hands the accepted
 * task id up in mixerQueueDestination.test.tsx; Seguimiento draws the hoist
 * and the accent border in Seguimiento.test.tsx). This file pins the WIRING
 * between them — the app shell's own page state and hash — because that is
 * where the jump could silently regress: nothing but App's callback crosses
 * from «Mezclar» to the router, and the highlight travels only in the hash
 * (`#/seguimiento?highlight=<task id>`).
 */

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const FILE_A = 'Dune.Parte.Dos.2024.1080p.mkv'
const FILE_B = 'Dune.Parte.Dos.2024.2160p.mkv'
const PATH_A = '/mnt/movies/Dune.Parte.Dos.2024.1080p.mkv'
const PATH_B = '/mnt/4k/Dune.Parte.Dos.2024.2160p.mkv'

type Obj = Record<string, unknown>

function audioEntry(): Obj {
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
  }
}

const COPY_OP: QueueOp = {
  id: 'op-1',
  type: 'copy',
  name: 'copia en curso',
  src: '/src/movie',
  dst: '/dst/movie',
  status: 'running',
  detail: null,
  progress: 40,
  copied_bytes: 400,
  total_bytes: 1000,
  files_done: 1,
  files_total: 2,
  import_status: '',
}

/* ── Fetch harness (the whole shell, one router) ─────────────────────────── */

type Handler = () => { status?: number; body: unknown }
type Route = [string, Handler]

function ok(body: unknown) {
  return { body }
}

function mockFetch() {
  const routes: Route[] = [
    // App shell (same answers pageSubtitles.test.tsx drives the shell with).
    ['/api/config', () => ok({ developer: false, auth_required: false, encryption_ok: true })],
    ['/api/setup', () => ok({ needs_setup: false, auth_required: false })],
    ['/api/services', () => ok({ services: [], configured: ['radarr', 'sonarr'] })],
    ['/api/status', () => ok({ radarr: 'online:ok', sonarr: 'online:ok', amutorrent: 'online:ok' })],
    ['/api/trace', () => ok({ traces: [], summary: {}, indexer: '', updated_at: 0 })],
    ['/api/actions', () => ok({ actions: [], safe_mode: false, available: [] })],
    // Seguimiento's own polls: one active copy op so the mix hoist has
    // something to jump above.
    ['/api/files/queue/status', () => ok({ queue: [COPY_OP], completed: [], running: true })],
    // The mixer flow, driven through the real MediaMixer.
    ['/api/files/roots', () => ok({ roots: [{ path: '/mnt', name: 'Media' }] })],
    ['/api/files/browse', () =>
      ok({
        ok: true,
        path: '/mnt',
        items: [
          { path: PATH_A, name: FILE_A, is_dir: false, size: 8_400_000_000 },
          { path: PATH_B, name: FILE_B, is_dir: false, size: 24_100_000_000 },
        ],
      })],
    ['/api/mixer/probe', () => ok(probeBody())],
    ['/api/mixer/mux', () => ok({ ok: true, task_id: 't1', detail: 'Mux task queued' })],
    ['/api/mixer/tasks/t1', () => ok({ ok: true, task_id: 't1', subtitles: [] })],
    ['/api/mixer/tasks', () =>
      ok({
        tasks: [
          { task_id: 't1', status: 'queued', progress: 0, detail: 'mezcla nueva', output_path: null, created_at: 2 },
          { task_id: 't0', status: 'running', progress: 0.2, detail: 'mezcla previa', output_path: null, created_at: 1 },
        ],
      })],
  ]
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    for (const [match, handler] of routes) {
      if (url.includes(match)) {
        const r = handler()
        return Promise.resolve({ ok: true, status: r.status ?? 200, json: async () => r.body } as Response)
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <App />
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

/** The user's S1 flow: pick the pair, probe, pick the destination, «Mezclar». */
async function submitMix() {
  await selectFile(0, FILE_A)
  await selectFile(1, FILE_B)
  fireEvent.click(await screen.findByRole('button', { name: 'Cotejar archivos' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Carpeta de A' }))
  fireEvent.click(screen.getByRole('button', { name: 'Mezclar' }))
}

/** Landing assertions: the page, the tab, and the hoisted accented row. */
async function expectSeguimientoLanding() {
  await waitFor(() => expect(window.location.pathname).toBe('/seguimiento'))
  expect(window.location.hash).toBe('#/seguimiento?highlight=t1')

  await screen.findByText('mezcla nueva')
  expect(screen.getByRole('tab', { name: /Activas/ })).toHaveAttribute('aria-selected', 'true')

  const rows = [...document.querySelectorAll('.sg-list .sg-row')]
  expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
    'mezcla nueva',
    'copia en curso',
    'mezcla previa',
  ])
  expect(rows[0]).toHaveClass('sg-row-highlight')
  expect((rows[0] as HTMLElement).style.borderLeft).toBe('3px solid var(--accent)')
}

beforeEach(() => {
  window.history.pushState(null, '', '/mixer')
  window.location.hash = ''
  mockFetch()
  setUnauthorizedHandler(vi.fn())
  clearToasts()
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearToasts()
  window.location.hash = ''
})

describe('the jump to Seguimiento after «Mezclar» (T3/S1)', () => {
  it('navigates itself to Seguimiento with the just-submitted mix hoisted and accented', async () => {
    renderApp()
    await submitMix()

    await expectSeguimientoLanding()

    // The navigation replaced nothing on the mixer's way out: the L31 toast
    // is still standing while Seguimiento renders.
    expect(
      getToasts().some((t) => t.message === 'Enviado a la cola' && t.tone === 'ok'),
    ).toBe(true)
    expect(screen.queryByRole('button', { name: 'Mezclar' })).toBeNull()
  })

  it('drops the highlight when the user leaves Seguimiento', async () => {
    renderApp()
    await submitMix()
    await expectSeguimientoLanding()

    // The param lives until the user changes tab or leaves — leaving is the
    // route push, which resolves to the bare path and drops the hash.
    fireEvent.click(screen.getByRole('link', { name: /Dashboard/ }))
    await waitFor(() => expect(window.location.pathname).toBe('/dashboard'))
    expect(window.location.hash).toBe('')
  })
})

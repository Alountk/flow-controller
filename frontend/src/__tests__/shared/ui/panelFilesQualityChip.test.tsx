import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PanelFiles } from '../../../shared/ui/PanelFiles.tsx'
import type { PanelFilesFacts } from '../../../shared/ui/PanelFiles.tsx'

/**
 * T4 (S2): the «Baja calidad» chip. It exists ONLY for a file whose persisted
 * probe says its height is below 1080 — an un-analyzed file shows no chip,
 * and rendering never runs ffprobe: the chips come from `probe-cached`.
 */

const BASE = '/peliculas/Film (2012)'
const ready: PanelFilesFacts = { state: 'ready', path: BASE }
const CHIP = 'Baja calidad'

const listing = {
  ok: true,
  path: BASE,
  items: [
    { name: 'Low.mkv', path: `${BASE}/Low.mkv`, is_dir: false, is_video: true, size: 1, modified: 1_759_382_400 },
    { name: 'High.mkv', path: `${BASE}/High.mkv`, is_dir: false, is_video: true, size: 1, modified: 1_759_382_400 },
    { name: 'Cold.mkv', path: `${BASE}/Cold.mkv`, is_dir: false, is_video: true, size: 1, modified: 1_759_382_400 },
  ],
}

const probeOf = (path: string, height: number) => ({
  filename: path.split('/').pop() ?? '',
  path,
  format: 'matroska,webm',
  duration: 60,
  size_bytes: 1,
  video_tracks: [{
    index: 0, track_index: 0, codec: 'h264', width: Math.round(height * 16 / 9),
    height, fps: 23.976, bitrate: 1_000_000, profile: 'High', level: 40,
    color_transfer: 'bt709', color_primaries: 'bt709', pix_fmt: 'yuv420p',
    selected: true,
  }],
  audio_tracks: [],
  subtitle_tracks: [],
})

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

function stubFetch(cached: Record<string, unknown>) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/mixer/probe-cached')) return ok(cached)
    if (url.includes('/api/mixer/probe-file')) return ok(probeOf('/x.mkv', 720))
    if (url.includes('/api/files/browse')) return ok(listing)
    return ok({ paths: { path_4k: '', path_3d: '' } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />
    </QueryClientProvider>,
  )
}

const chips = () => screen.queryAllByText(CHIP)

/** The listing row of one file (the name cell holds the chip; the spec block
 *  repeats the name inside a separate <code>, so rows are addressed by cell). */
const rowOf = (name: string) =>
  screen.getByText(name, { selector: 'td.sec-file-name' }).closest('tr') as HTMLElement

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('T4 · chip «Baja calidad» desde la caché persistida (S2)', () => {
  it('marks only the analyzed file below 1080 and never probes on render', async () => {
    const fn = stubFetch({
      [`${BASE}/Low.mkv`]: probeOf(`${BASE}/Low.mkv`, 720),
      [`${BASE}/High.mkv`]: probeOf(`${BASE}/High.mkv`, 1080),
      [`${BASE}/Cold.mkv`]: null,
    })

    renderPanel()

    await screen.findByText('Low.mkv', { selector: 'td.sec-file-name' })
    const lowRow = rowOf('Low.mkv')
    const highRow = rowOf('High.mkv')
    const coldRow = rowOf('Cold.mkv')

    expect(await screen.findByText(CHIP)).toBeInTheDocument()
    expect(chips()).toHaveLength(1)
    expect(lowRow.textContent).toContain(CHIP)
    expect(highRow.textContent).not.toContain(CHIP)
    expect(coldRow.textContent).not.toContain(CHIP)

    expect(fn.mock.calls.filter((c) => String(c[0]).includes('/api/mixer/probe-file'))).toHaveLength(0)
  })

  it('shows no chip at all when nothing is analyzed', async () => {
    stubFetch({})

    renderPanel()

    await screen.findByText('Low.mkv', { selector: 'td.sec-file-name' })
    expect(chips()).toHaveLength(0)
  })
})

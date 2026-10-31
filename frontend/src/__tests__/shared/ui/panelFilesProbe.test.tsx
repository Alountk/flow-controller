import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { PanelFiles } from '../../../shared/ui/PanelFiles.tsx'
import type { PanelFilesFacts } from '../../../shared/ui/PanelFiles.tsx'

/**
 * T4 (S2/S3/L7/L8): on-demand ffprobe in the movies file view — «Analizar»
 * per file and per section, «Ejecutando ffprobe…» for the running scope, the
 * S3 spec block VERBATIM on success and a `wanted-error` block on failure.
 * S2 pins that nothing probes on plain render; L8 pins HDR honesty: «HDR»/
 * «HLG» from color_transfer only, NEVER «HDR10»/«Dolby Vision» (unprovable
 * without side_data). Preview labels win over the helpers (L7): «AC3» never
 * «AC-3», «español» never «Castellano», «srt» never «subrip».
 */

const BASE = '/peliculas/Film (2012)'

const ready: PanelFilesFacts = { state: 'ready', path: BASE }

const LOADING = 'Ejecutando ffprobe…'

const video = (name: string, dir: string) => ({
  name,
  path: `${dir}/${name}`,
  is_dir: false,
  is_video: true,
})

const listing = (path: string, items: Array<Record<string, unknown>>) => ({
  ok: true,
  path,
  items: items.map((item) => ({ size: 1_000_000, modified: 1_759_382_400, ...item })),
})

const BASE_LISTING = listing(BASE, [
  video('ParaNorman.mkv', BASE),
  video('Film.2012.1080p.BluRay.mkv', BASE),
  video('Film.720p.mkv', BASE),
  { name: 'subs', path: `${BASE}/subs`, is_dir: true, is_video: false },
  { name: 'Film.srt', path: `${BASE}/Film.srt`, is_dir: false, is_video: false },
])

// The S3 preview lines for the default payload below — spec-verbatim.
const SPECS = 'MKV · H.264 High@4.0 · 1920×1080 · 8.2 Mbps · 23.976 fps'
const SPECS_HDR = `${SPECS} · HDR`
const SPECS_HLG = `${SPECS} · HLG`
const SPECS_LEVEL0 = 'MKV · H.264 High · 1920×1080 · 8.2 Mbps · 23.976 fps'
const SPECS_NOPROFILE = 'MKV · H.264 · 1920×1080 · 8.2 Mbps · 23.976 fps'
const FOOTER = '1h 35m · 5.4 GB'

const videoTrack = (overrides: Record<string, unknown> = {}) => ({
  index: 0,
  track_index: 0,
  codec: 'h264',
  width: 1920,
  height: 1080,
  fps: 23.976,
  bitrate: 8_200_000,
  profile: 'High',
  level: 40,
  color_transfer: 'bt709',
  color_primaries: 'bt709',
  pix_fmt: 'yuv420p',
  selected: false,
  ...overrides,
})

// Field-for-field the parse_probe_data shape probe.ts pins (keys-always).
const probeOf = (name: string, v: Record<string, unknown> = videoTrack()) => ({
  filename: name,
  path: `${BASE}/${name}`,
  format: 'matroska,webm',
  duration: 5700,
  size_bytes: 5_798_205_850,
  video_tracks: [v],
  audio_tracks: [
    { index: 1, track_index: 0, codec: 'ac3', language: 'spa', channels: 6, bitrate: 640_000, default: true },
    { index: 2, track_index: 1, codec: 'aac', language: 'eng', channels: 2, bitrate: 128_000, default: false },
  ],
  subtitle_tracks: [
    { index: 3, track_index: 0, codec: 'subrip', language: 'spa', language_code: 'spa', title: '', forced: false, default: true, kind: 'text', extractable: true },
    { index: 4, track_index: 1, codec: 'subrip', language: 'eng', language_code: 'eng', title: '', forced: false, default: false, kind: 'text', extractable: true },
  ],
})

type ProbeEntry = Record<string, unknown> | { status: number; detail: string }
const isFailure = (e: ProbeEntry): e is { status: number; detail: string } => 'status' in e

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

function bad(status: number, body: unknown) {
  return Promise.resolve({ ok: false, status, json: async () => body } as Response)
}

function stubFetch(opts: { probes?: Record<string, ProbeEntry>; deferProbes?: boolean } = {}) {
  const deferred: Array<() => void> = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/mixer/probe-file')) {
      const req = JSON.parse(String(init?.body)) as { path: string }
      const entry = opts.probes?.[req.path]
      const respond = () =>
        entry && isFailure(entry)
          ? bad(entry.status, { detail: entry.detail })
          : ok(entry ?? probeOf(req.path.split('/').pop() ?? ''))
      if (opts.deferProbes) {
        return new Promise<Response>((resolve) => deferred.push(() => resolve(respond())))
      }
      return respond()
    }
    if (url.includes('/api/files/browse')) return ok(BASE_LISTING)
    return ok({ paths: { path_4k: '', path_3d: '' } })
  })
  vi.stubGlobal('fetch', fn)
  return { fn, flushProbes: () => deferred.splice(0).forEach((resolve) => resolve()) }
}

function renderPanel(panel: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>)
}

function sectionOf(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 4, name: label })
  const el = heading.closest('section')
  expect(el, `section wrapper for ${label}`).not.toBeNull()
  return el as HTMLElement
}

const probeCalls = (calls: unknown[][]) =>
  calls.filter((c) => String(c[0]).includes('/api/mixer/probe-file'))

const bodyPath = (call: unknown[]) =>
  (JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as { path: string }).path

beforeEach(() => stubFetch())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('T4 · «Analizar» bajo demanda (S2)', () => {
  it('renders without probing anything — zero probe-file calls', async () => {
    const { fn } = stubFetch()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)

    await screen.findByRole('heading', { level: 4, name: '1080' })
    expect(probeCalls(fn.mock.calls)).toHaveLength(0)
  })

  it('file «Analizar» POSTs {path} once and renders the S3 block verbatim', async () => {
    const { fn } = stubFetch()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('ParaNorman.mkv')

    fireEvent.click(screen.getByRole('button', { name: 'Analizar ParaNorman.mkv' }))

    await screen.findByText(SPECS)
    const calls = probeCalls(fn.mock.calls)
    expect(calls).toHaveLength(1)
    expect((calls[0][1] as RequestInit | undefined)?.method).toBe('POST')
    expect(bodyPath(calls[0])).toBe(`${BASE}/ParaNorman.mkv`)

    // Verbatim preview (S3): header through footer, one line each.
    expect(screen.getByText('1080p')).toBeInTheDocument()
    expect(screen.getByText('ParaNorman.mkv', { selector: 'code' })).toBeInTheDocument()
    expect(screen.getByText(SPECS)).toBeInTheDocument()
    expect(screen.getByText('Audio 1: AC3 5.1 640kbps español')).toBeInTheDocument()
    expect(screen.getByText('Audio 2: AAC 2.0 128kbps inglés')).toBeInTheDocument()
    expect(screen.getByText('Subtítulos: ESP (srt), ENG (srt)')).toBeInTheDocument()
    expect(screen.getByText(FOOTER)).toBeInTheDocument()
    // L7: preview labels WIN over the helpers' own words.
    expect(screen.queryByText(/AC-3|Castellano|Inglés|subrip/)).toBeNull()
  })

  it('section «Analizar» probes every analyzable file of that section, one call each', async () => {
    const { fn } = stubFetch()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('ParaNorman.mkv')

    fireEvent.click(screen.getByRole('button', { name: 'Analizar sección 1080' }))

    const s1080 = sectionOf('1080')
    await within(s1080).findByText('ParaNorman.mkv', { selector: 'code' })
    await within(s1080).findByText('Film.2012.1080p.BluRay.mkv', { selector: 'code' })

    const calls = probeCalls(fn.mock.calls)
    expect(calls).toHaveLength(2)
    expect(calls.map(bodyPath).sort()).toEqual(
      [`${BASE}/Film.2012.1080p.BluRay.mkv`, `${BASE}/ParaNorman.mkv`].sort(),
    )
    // Each file's spec block shows under its section.
    expect(within(s1080).getAllByText(FOOTER)).toHaveLength(2)
    expect(within(s1080).getAllByText(SPECS)).toHaveLength(2)
  })

  it('«Ejecutando ffprobe…» marks the running FILE scope, on its row', async () => {
    const { flushProbes } = stubFetch({ deferProbes: true })
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    const row = (await screen.findByText('ParaNorman.mkv')).closest('tr') as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: 'Analizar ParaNorman.mkv' }))

    expect(within(row).getByText(LOADING)).toBeInTheDocument()
    expect(screen.getAllByText(LOADING)).toHaveLength(1)
    flushProbes()
    await screen.findByText(SPECS)
    expect(screen.queryByText(LOADING)).toBeNull()
  })

  it('«Ejecutando ffprobe…» marks the SECTION scope with one label', async () => {
    const { flushProbes } = stubFetch({ deferProbes: true })
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('ParaNorman.mkv')

    fireEvent.click(screen.getByRole('button', { name: 'Analizar sección 1080' }))

    expect(screen.getAllByText(LOADING)).toHaveLength(1)
    flushProbes()
    await screen.findByText('Film.2012.1080p.BluRay.mkv', { selector: 'code' })
    expect(screen.queryByText(LOADING)).toBeNull()
  })
})

describe('T4 · etiquetas del bloque (S3/L7/L8)', () => {
  it('HDR honesty: smpte2084→«HDR», arib-std-b67→«HLG», unknown→nothing', async () => {
    stubFetch({
      probes: {
        [`${BASE}/ParaNorman.mkv`]: probeOf('ParaNorman.mkv', videoTrack({ color_transfer: 'smpte2084' })),
        [`${BASE}/Film.2012.1080p.BluRay.mkv`]: probeOf('Film.2012.1080p.BluRay.mkv', videoTrack({ color_transfer: 'arib-std-b67' })),
        [`${BASE}/Film.720p.mkv`]: probeOf('Film.720p.mkv', videoTrack({ color_transfer: 'unknown' })),
      },
    })
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('ParaNorman.mkv')

    fireEvent.click(screen.getByRole('button', { name: 'Analizar ParaNorman.mkv' }))
    await screen.findByText(SPECS_HDR)
    fireEvent.click(screen.getByRole('button', { name: 'Analizar Film.2012.1080p.BluRay.mkv' }))
    await screen.findByText(SPECS_HLG)
    fireEvent.click(screen.getByRole('button', { name: 'Analizar Film.720p.mkv' }))
    await screen.findByText(SPECS)

    expect(screen.getByText(SPECS_HDR)).toBeInTheDocument()
    expect(screen.getByText(SPECS_HLG)).toBeInTheDocument()
    expect(screen.getByText(SPECS)).toBeInTheDocument()
    // L8 hard rule: DV is indistinguishable without side_data — never claimed.
    expect(screen.queryByText(/HDR10|Dolby Vision/)).toBeNull()
  })

  it('level 0 renders the profile alone — no «@»', async () => {
    stubFetch({
      probes: { [`${BASE}/ParaNorman.mkv`]: probeOf('ParaNorman.mkv', videoTrack({ level: 0 })) },
    })
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('ParaNorman.mkv')

    fireEvent.click(screen.getByRole('button', { name: 'Analizar ParaNorman.mkv' }))

    await screen.findByText(SPECS_LEVEL0)
    expect(screen.queryByText(/@/)).toBeNull()
  })

  it('profile «unknown» renders the codec alone — no «unknown», no «@»', async () => {
    stubFetch({
      probes: {
        [`${BASE}/ParaNorman.mkv`]: probeOf('ParaNorman.mkv', videoTrack({ profile: 'unknown' })),
      },
    })
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('ParaNorman.mkv')

    fireEvent.click(screen.getByRole('button', { name: 'Analizar ParaNorman.mkv' }))

    await screen.findByText(SPECS_NOPROFILE)
    expect(within(sectionOf('1080')).queryByText(/unknown/)).toBeNull()
  })
})

describe('T4 · fallos y alcance de los botones', () => {
  it('a 403 detail renders a wanted-error block for that file — no spec block', async () => {
    stubFetch({
      probes: {
        [`${BASE}/ParaNorman.mkv`]: { status: 403, detail: 'Ruta fuera de las raíces permitidas' },
      },
    })
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('ParaNorman.mkv')

    fireEvent.click(screen.getByRole('button', { name: 'Analizar ParaNorman.mkv' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveClass('wanted-error')
    expect(alert).toHaveTextContent('ParaNorman.mkv')
    expect(alert).toHaveTextContent('Ruta fuera de las raíces permitidas')
    expect(screen.queryByText(SPECS)).toBeNull()
    expect(screen.queryByText(FOOTER)).toBeNull()
  })

  it('dirs and subtitles expose no «Analizar» — videos do, wherever they landed', async () => {
    stubFetch()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    await screen.findByText('Film.720p.mkv')

    const sOtros = sectionOf('Otros')
    expect(within(sOtros).queryByRole('button', { name: 'Analizar subs' })).toBeNull()
    expect(within(sOtros).queryByRole('button', { name: 'Analizar Film.srt' })).toBeNull()
    expect(within(sOtros).getByRole('button', { name: 'Analizar Film.720p.mkv' })).toBeInTheDocument()
  })

  it('the flat view (Series) stays button-free', async () => {
    const { fn } = stubFetch()
    renderPanel(<PanelFiles facts={ready} />)
    await screen.findByText('ParaNorman.mkv')

    expect(screen.queryByRole('button', { name: /Analizar/ })).toBeNull()
    expect(probeCalls(fn.mock.calls)).toHaveLength(0)
  })

  it('a re-click re-probes and REPLACES the block — no caching', async () => {
    const { fn } = stubFetch()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)
    const row = (await screen.findByText('ParaNorman.mkv')).closest('tr') as HTMLElement
    const button = within(row).getByRole('button', { name: 'Analizar ParaNorman.mkv' })

    fireEvent.click(button)
    await screen.findByText(SPECS)
    fireEvent.click(button)
    await screen.findByText(SPECS)

    expect(probeCalls(fn.mock.calls)).toHaveLength(2)
    expect(screen.getAllByText(SPECS)).toHaveLength(1)
    expect(screen.getAllByText(FOOTER)).toHaveLength(1)
  })
})

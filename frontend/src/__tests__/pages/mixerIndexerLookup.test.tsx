import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaMixer } from '../../pages/MediaMixer.tsx'
import type { ReleaseSearchItem } from '../../features/release-search/ReleaseSearchModal.tsx'

/**
 * S7 — «Botón con lookup automático» (L8): when a required language is missing
 * from both files, the mixer offers «Buscar en el indexador». The click parses
 * the title from the filename server-side and the answer decides the surface:
 * in-library → `ReleaseSearchModal` with that movie; not in library → the
 * «añádela primero» notice with the derived title; Radarr unusable → the
 * error surface already in the page.
 */

const modalSpy = vi.hoisted(() => ({ items: [] as ReleaseSearchItem[] }))

vi.mock('../../features/release-search/ReleaseSearchModal.tsx', () => ({
  ReleaseSearchModal: ({ item }: { item: ReleaseSearchItem }) => {
    modalSpy.items.push(item)
    return <div data-testid="release-search-modal">{item.title}</div>
  },
}))

const FILE_A = 'Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv'
const MISSING_NOTICE = 'Falta castellano (exigido) en los dos archivos'
const IN_LIBRARY_ITEM: ReleaseSearchItem = {
  type: 'movie',
  id: 7,
  title: 'Dune Parte Dos',
  year: 2024,
  source: 'radarr',
  idKind: 'movie',
}

type LanguageCheck = { ok: boolean; missing: string[]; required: string[] }

function probeBody(language_check: LanguageCheck) {
  return {
    file_a: {
      filename: FILE_A,
      path: '/mnt/entry.mkv',
      format: 'matroska,webm',
      duration: 7200,
      size_bytes: 1_000_000,
      video_tracks: [
        { index: 0, codec: 'h264', width: 1920, height: 1080, fps: 24, bitrate: 5_000_000, selected: false },
      ],
      audio_tracks: [
        { index: 1, codec: 'aac', language: 'eng', channels: 6, bitrate: 128_000, default: true },
      ],
    },
    file_b: {
      filename: 'Dune.Parte.Dos.2024.2160p.HEVC.DDP5.1.mkv',
      path: '/mnt/entry2.mkv',
      format: 'matroska,webm',
      duration: 7200,
      size_bytes: 2_000_000,
      video_tracks: [
        { index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 24, bitrate: 10_000_000, selected: false },
      ],
      audio_tracks: [
        { index: 1, codec: 'aac', language: 'rus', channels: 6, bitrate: 128_000, default: true },
      ],
    },
    compatibility: { ok: true, warnings: [] },
    language_check,
  }
}

interface LookupReply {
  status: number
  body: unknown
}

function mockFetch(probe: unknown, lookup: LookupReply) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url, body })
    if (url.includes('/api/files/roots')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ roots: [{ path: '/mnt', name: 'Media' }] }),
      } as Response)
    }
    if (url.includes('/api/files/browse')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ok: true,
          path: '/mnt',
          items: [{ path: '/mnt/entry.mkv', name: FILE_A, is_dir: false, size: 1000 }],
        }),
      } as Response)
    }
    if (url.includes('/api/mixer/probe')) {
      return Promise.resolve({ ok: true, json: async () => probe } as Response)
    }
    if (url.includes('/api/mixer/lookup')) {
      return Promise.resolve({
        ok: lookup.status < 400,
        status: lookup.status,
        json: async () => lookup.body,
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({ tasks: [] }) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

function renderMixer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MediaMixer />
    </QueryClientProvider>,
  )
}

async function selectFile(pickerIndex: number) {
  const browseButtons = await screen.findAllByRole('button', { name: 'Browse' })
  fireEvent.click(browseButtons[pickerIndex])
  const fileName = await screen.findByText(FILE_A)
  const row = fileName.closest('.scan-file-item')
  if (!row) throw new Error('file row not rendered')
  fireEvent.doubleClick(row)
}

/** Pick both files and probe — lands in the results phase. */
async function driveToResults(languageCheck: LanguageCheck, lookup: LookupReply) {
  const calls = mockFetch(probeBody(languageCheck), lookup)
  renderMixer()
  await selectFile(0)
  await selectFile(1)
  fireEvent.click(await screen.findByRole('button', { name: /Probe Files/ }))
  await screen.findByRole('button', { name: '← Back' })
  return calls
}

describe('mixer — «Buscar en el indexador» when a required language is missing (S7)', () => {
  beforeEach(() => {
    modalSpy.items.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the aviso and the indexer button only when language_check.ok is false', async () => {
    await driveToResults(
      { ok: false, missing: ['spa'], required: ['spa'] },
      { status: 200, body: { ok: true, title: 'Dune Parte Dos 2024', movie: null } },
    )

    expect(screen.getByText(MISSING_NOTICE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Buscar en el indexador' })).toBeInTheDocument()
  })

  it('renders neither the aviso nor the button when the required language is present', async () => {
    await driveToResults(
      { ok: true, missing: [], required: ['spa'] },
      { status: 200, body: { ok: true, title: 'Dune Parte Dos 2024', movie: null } },
    )

    expect(screen.queryByText(MISSING_NOTICE)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Buscar en el indexador' })).toBeNull()
  })

  it('opens ReleaseSearchModal with the in-library movie the lookup returned', async () => {
    const calls = await driveToResults(
      { ok: false, missing: ['spa'], required: ['spa'] },
      {
        status: 200,
        body: {
          ok: true,
          title: 'Dune Parte Dos 2024',
          movie: { id: 7, title: 'Dune Parte Dos', year: 2024, source: 'radarr' },
        },
      },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Buscar en el indexador' }))

    expect(await screen.findByTestId('release-search-modal')).toBeInTheDocument()
    expect(modalSpy.items).toEqual([IN_LIBRARY_ITEM])
    const lookupCall = calls.find((c) => c.url.includes('/api/mixer/lookup'))
    expect(lookupCall?.body).toEqual({ filename: FILE_A })
  })

  it('answers «añádela primero» with the derived title when the movie is not in the library', async () => {
    await driveToResults(
      { ok: false, missing: ['spa'], required: ['spa'] },
      { status: 200, body: { ok: true, title: 'Dune Parte Dos 2024', movie: null } },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Buscar en el indexador' }))

    expect(
      await screen.findByText('Dune Parte Dos 2024 no está en la librería — añádela primero en Radarr'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('release-search-modal')).toBeNull()
  })

  it('reports a Radarr failure on the existing error surface', async () => {
    await driveToResults(
      { ok: false, missing: ['spa'], required: ['spa'] },
      { status: 502, body: { detail: 'Radarr lookup failed: connection refused' } },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Buscar en el indexador' }))

    expect(
      await screen.findByText('Radarr lookup failed: connection refused'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('release-search-modal')).toBeNull()
  })
})

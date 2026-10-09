import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaPane, type MediaSelection } from '../../../features/media-pane/MediaPane.tsx'
import type { AllMovie } from '../../../shared/types.ts'

/**
 * The false-negative fix: `hasFile: false` is Radarr's IMPORT state, not a
 * disk fact, so a folder that plainly holds a video (Luca) must stop reading
 * "✗ Sin archivo". The backend now says `has_unimported_file`, and every
 * surface that renders the file status has to honour it:
 *
 *  - the 'page' card badge (MediaPane's Faltantes-era markup),
 *  - the 'section' row pill — tone included: an unimported video is a STATE,
 *    not a failure, so `warn`/neutral, never the bad/error tone,
 *  - the detail panel's `Estado` (catalogState), the same claim as the badge.
 *
 * The two messages are claims about bytes on disk, and only the unimported
 * one is directly witnessed: the backend listed the folder and SAW a video.
 * "✗ Sin archivo" stays the exact copy for a checked folder with no video
 * (the Enola Holmes 3 case — Radarr was right all along).
 */

const luca: AllMovie = {
  id: 1,
  title: 'Luca',
  year: 2021,
  remotePoster: '',
  has_file: false,
  has_unimported_file: true,
  path: '/movies/Luca (2021)',
  path_exists: true,
  monitored: true,
  quality: '',
  grabbed_at: null,
  grabbed_destination: null,
}

const enola: AllMovie = {
  id: 2,
  title: 'Enola Holmes 3 (2026)',
  year: 2026,
  remotePoster: '',
  has_file: false,
  has_unimported_file: false,
  path: '/movies/Enola Holmes 3 (2026)',
  path_exists: true,
  monitored: true,
  quality: '',
  grabbed_at: null,
  grabbed_destination: null,
}

const imported: AllMovie = {
  id: 3,
  title: 'Ya Importada',
  year: 2019,
  remotePoster: '',
  has_file: true,
  path: '/movies/Ya Importada (2019)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-1080p',
  grabbed_at: null,
  grabbed_destination: null,
}

function stubFetch(items: AllMovie[]) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/wanted/all')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ items, total: items.length, page: 1, page_size: 50 }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderPane(opts: {
  variant?: 'page' | 'section'
  onSelect?: (selection: MediaSelection) => void
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MediaPane
        kind="movies"
        filter="all"
        namespace="unimported-label"
        variant={opts.variant ?? 'page'}
        onSelect={opts.onSelect}
      />
    </QueryClientProvider>,
  )
}

describe('file status: an unimported video is not "Sin archivo"', () => {
  beforeEach(() => {
    // The pane's search text lives in the URL hash: start every test clean.
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('page card: a folder with an unimported video says so, not "✗ Sin archivo", and not as an error', async () => {
    // Luca ALONE: if her card still said "✗ Sin archivo", this finds it.
    stubFetch([luca])
    renderPane()

    const badge = await screen.findByText('Carpetas con vídeo · sin importar')
    expect(screen.queryByText('✗ Sin archivo')).not.toBeInTheDocument()
    // The bytes ARE there: this must not wear the error class.
    expect(badge.className).not.toContain('badge-error')
  })

  it('page card: a checked folder with no video keeps the exact "✗ Sin archivo" error badge', async () => {
    stubFetch([enola])
    renderPane()

    const badge = await screen.findByText('✗ Sin archivo')
    expect(badge.className).toContain('badge-error')
  })

  it('page card: an imported title still says "✓ Configurada"', async () => {
    stubFetch([imported])
    renderPane()

    const badge = await screen.findByText('✓ Configurada')
    expect(badge.className).toContain('badge-ok')
  })

  it('section row: the unimported pill is warn, never the bad tone', async () => {
    stubFetch([luca, enola, imported])
    renderPane({ variant: 'section' })

    const unimported = await screen.findByText('Carpetas con vídeo · sin importar')
    expect(unimported.className).toContain('sec-pill-warn')
    expect(unimported.className).not.toContain('sec-pill-bad')
    // The other two labels are untouched by the fix.
    expect(screen.getByText('Sin archivo').className).toContain('sec-pill-bad')
    expect(screen.getByText('En biblioteca').className).toContain('sec-pill-ok')
  })

  it('the detail panel carries the same evidence-backed Estado', async () => {
    const onSelect = vi.fn()
    stubFetch([luca])
    renderPane({ variant: 'section', onSelect })

    fireEvent.click(await screen.findByText('Luca'))
    await waitFor(() => expect(onSelect).toHaveBeenCalled())

    const meta = onSelect.mock.calls[0][0].detail.meta as { label: string; value: string }[]
    expect(meta.find((entry) => entry.label === 'Estado')?.value).toBe(
      'Carpetas con vídeo · sin importar',
    )
  })
})

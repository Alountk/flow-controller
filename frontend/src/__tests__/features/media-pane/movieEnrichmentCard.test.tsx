import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SectionRow, faltaStatus } from '../../../features/media-pane/components/SectionRow.tsx'
import { Peliculas } from '../../../pages/Peliculas.tsx'

/**
 * Design-03 card extras (stitch-peliculas-03 T2): the director line
 * (`Dir: …`) and the on-disk size in mono at the right of the card footer.
 * Both are OPTIONAL in the payload (the T1 mapper omits what Radarr did not
 * send), so every absence renders NOTHING — no `Dir: ` with no name, no
 * `0 B` standing in for an unknown size.
 */

const enrichedMovie = {
  id: 411,
  title: 'Dune: Part Two',
  year: 2024,
  remotePoster: '',
  has_file: true,
  path: '/peliculas/Dune Part Two (2024)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-2160p',
  grabbed_at: null,
  grabbed_destination: null,
  directors: ['Denis Villeneuve'],
  size_on_disk: 51_753_517_056,
}

const plainMovie = {
  id: 412,
  title: 'El Verdugo',
  year: 1963,
  remotePoster: '',
  has_file: false,
  path: '/peliculas/El Verdugo (1963)',
  path_exists: true,
  monitored: false,
  quality: '',
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch() {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr'] })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [enrichedMovie, plainMovie], total: 2, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({ wanted: { radarr: { items: [], total: 0 } }, updated_at: 0 })
    }
    void init
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Peliculas />
    </QueryClientProvider>,
  )
}

const rows = () => Array.from(document.querySelectorAll('.sec-row')) as HTMLElement[]

describe('director line · SectionRow', () => {
  it('renders the design line when the row carries a director', () => {
    render(
      <SectionRow
        className="wanted-card"
        wiring={{}}
        title="Dune: Part Two"
        year={2024}
        status={faltaStatus()}
        director="Denis Villeneuve"
      >
        <span>acciones</span>
      </SectionRow>,
    )

    expect(screen.getByText('Dir: Denis Villeneuve').className).toContain('sec-row-dir')
  })

  it('renders no line at all when the payload had no directors', () => {
    render(
      <SectionRow className="wanted-card" wiring={{}} title="El Verdugo" status={faltaStatus()}>
        <span>acciones</span>
      </SectionRow>,
    )

    expect(screen.queryByText(/^Dir:/)).toBeNull()
    expect(document.querySelector('.sec-row-dir')).toBeNull()
  })
})

describe('card size · SectionRow', () => {
  it('renders the size at the right of the footer when provided', () => {
    render(
      <SectionRow
        className="wanted-card"
        wiring={{}}
        title="Dune: Part Two"
        status={faltaStatus()}
        size="48.2 GB"
      >
        <span>acciones</span>
      </SectionRow>,
    )

    expect(screen.getByText('48.2 GB').className).toContain('sec-row-size')
  })

  it('renders no size when the payload had none', () => {
    render(
      <SectionRow className="wanted-card" wiring={{}} title="El Verdugo" status={faltaStatus()}>
        <span>acciones</span>
      </SectionRow>,
    )

    expect(document.querySelector('.sec-row-size')).toBeNull()
  })
})

describe('wiring through the Peliculas section', () => {
  beforeEach(() => {
    window.location.hash = ''
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the director and the formatted size on the movie that has them', async () => {
    renderSection()
    await screen.findByText('Dune: Part Two')

    const row = rows().find((r) => r.textContent?.includes('Dune: Part Two')) as HTMLElement
    expect(within(row).getByText('Dir: Denis Villeneuve')).toBeInTheDocument()
    expect(within(row).getByText('48.2 GB')).toBeInTheDocument()
  })

  it('shows neither on a movie the mapper enriched with nothing', async () => {
    renderSection()
    await screen.findByText('El Verdugo')

    const row = rows().find((r) => r.textContent?.includes('El Verdugo')) as HTMLElement
    expect(within(row).queryByText(/^Dir:/)).toBeNull()
    expect(within(row).queryByText(/\d+(\.\d+)? (B|KB|MB|GB|TB)/)).toBeNull()
  })
})

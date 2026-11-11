import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { PanelFiles } from '../../../shared/ui/PanelFiles.tsx'
import type { PanelFilesFacts } from '../../../shared/ui/PanelFiles.tsx'

/**
 * S3 («v2-file-pick-and-release-states»), corrected placement: the «Buscar en
 * carpeta» lives in each SECTION CARD's head (sec-file-card > sec-file-card-
 * head), a neighbor of sec-analyze-row and ALWAYS visible — the card carries
 * it even with no files, exactly where the ANALIZAR control hides. The listing
 * table keeps no «Buscar en carpeta» column.
 */

const BASE = '/peliculas/Film (2012)'
const FOLDERS = { path4k: '/4k', path3d: '/3d' }

const ready: PanelFilesFacts = { state: 'ready', path: BASE }

const listing = (path: string, items: Array<Record<string, unknown>>) => ({
  ok: true,
  path,
  items: items.map((item) => ({
    size: 1_000_000,
    modified: 1_759_382_400,
    ...item,
  })),
})

const file = (name: string, dir = false, video = !dir) => ({
  name,
  path: `${BASE}/${name}`,
  is_dir: dir,
  is_video: video,
})

const BASE_LISTING = listing(BASE, [
  file('Film.2012.1080p.BluRay.mkv'),
  file('Film.720p.mkv'),
  file('Film.srt', false, false),
  file('subs', true, false),
])

/** Two videos in ONE card: no single victim, so no substitution path. */
const TWO_VIDEO_LISTING = listing(BASE, [
  file('Film.2012.1080p.BluRay.mkv'),
  file('Film.2012.Extended.1080p.BluRay.mkv'),
])

type Call = [input: RequestInfo | URL, init?: RequestInit]

function stubFetch(body: unknown = BASE_LISTING) {
  const calls: Call[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init])
    const url = String(input)
    if (url.includes('/api/files/browse')) {
      return Promise.resolve({ ok: true, json: async () => body } as Response)
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({}),
    } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

function renderPanel(panel: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>)
}

const cardOf = (label: string) => screen.getByRole('region', { name: `Archivos ${label}` })

const headOf = (label: string) =>
  cardOf(label).querySelector('.sec-file-card-head') as HTMLElement

const headChipOf = (label: string) =>
  within(headOf(label)).getByRole('button', { name: 'Buscar en carpeta' })

beforeEach(() => stubFetch())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PanelFiles · sin handler (Series y V1)', () => {
  it('gains no button at all: the plain read-only listing stays plain', async () => {
    renderPanel(<PanelFiles facts={ready} folders={FOLDERS} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    expect(screen.queryByRole('button', { name: 'Buscar en carpeta' })).toBeNull()
  })

  it('the flat listing shows no chip either: the head chip belongs to sections', async () => {
    const onSearch = vi.fn()
    renderPanel(<PanelFiles facts={ready} onSearchInFolder={onSearch} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    expect(screen.queryByRole('button', { name: 'Buscar en carpeta' })).toBeNull()
  })
})

describe('PanelFiles · «Buscar en carpeta» en la cabecera de cada tarjeta (S3)', () => {
  it('puts ONE chip in every card head — all five, even the empty ones', async () => {
    const onSearch = vi.fn()
    const { container } = renderPanel(
      <PanelFiles facts={ready} folders={FOLDERS} onSearchInFolder={onSearch} />,
    )

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    const cards = container.querySelectorAll('.sec-file-card')
    expect(cards).toHaveLength(5)
    for (const card of cards) {
      const head = card.querySelector('.sec-file-card-head') as HTMLElement
      expect(within(head).getAllByRole('button', { name: 'Buscar en carpeta' })).toHaveLength(1)
    }
    // The card that holds nothing still offers the search…
    expect(within(headOf('4K')).getByRole('button', { name: 'Buscar en carpeta' })).toBeInTheDocument()
    expect(within(cardOf('4K')).getByText('Sin archivos en esta sección')).toBeInTheDocument()
    // …while ANALIZAR stays hidden: there is no associated file to analyze.
    expect(headOf('4K').querySelector('.sec-analyze-row')).toBeNull()
  })

  it('sits in the SAME head as sec-analyze-row when the card has files', async () => {
    const onSearch = vi.fn()
    renderPanel(<PanelFiles facts={ready} folders={FOLDERS} onSearchInFolder={onSearch} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    const head = headOf('1080')
    expect(within(head).getByRole('button', { name: 'Buscar en carpeta' })).toBeInTheDocument()
    expect(head.querySelector('.sec-analyze-row')).not.toBeNull()
    expect(head.querySelectorAll('button')).toHaveLength(2)
  })

  it('leaves the table with NO «Buscar en carpeta» column', async () => {
    const onSearch = vi.fn()
    const { container } = renderPanel(
      <PanelFiles facts={ready} folders={FOLDERS} onSearchInFolder={onSearch} />,
    )

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    const table = container.querySelector('table.sec-files-table') as HTMLElement
    expect(within(table).queryByRole('button', { name: 'Buscar en carpeta' })).toBeNull()
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).not.toContain('Buscar en carpeta')
    expect(headers).toEqual(['Nombre', 'Tamaño', 'Modificado', 'Analizar'])
  })

  it('hands the head chip the card’s folder and its SOLE video as victim', async () => {
    const onSearch = vi.fn()
    renderPanel(<PanelFiles facts={ready} folders={FOLDERS} onSearchInFolder={onSearch} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    fireEvent.click(headChipOf('1080'))
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith({
      path: BASE,
      replaceVideo: `${BASE}/Film.2012.1080p.BluRay.mkv`,
    })
  })

  it('an empty card still searches its root — no victim, no substitution', async () => {
    const onSearch = vi.fn()
    renderPanel(<PanelFiles facts={ready} folders={FOLDERS} onSearchInFolder={onSearch} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    fireEvent.click(headChipOf('4K'))
    expect(onSearch).toHaveBeenCalledWith({ path: '/4k' })
    expect(onSearch.mock.calls[0][0].replaceVideo).toBeUndefined()
  })

  it('a card with two videos gets no guessed victim: the pick localizes only', async () => {
    stubFetch(TWO_VIDEO_LISTING)
    const onSearch = vi.fn()
    renderPanel(<PanelFiles facts={ready} folders={FOLDERS} onSearchInFolder={onSearch} />)

    await screen.findByText('Film.2012.Extended.1080p.BluRay.mkv')
    fireEvent.click(headChipOf('1080'))
    expect(onSearch).toHaveBeenCalledWith({ path: BASE })
    expect(onSearch.mock.calls[0][0].replaceVideo).toBeUndefined()
  })

  it('keeps the tab read-only and inert until the head chip is clicked', async () => {
    const calls = stubFetch()
    const onSearch = vi.fn()
    const { container } = renderPanel(
      <PanelFiles facts={ready} folders={FOLDERS} onSearchInFolder={onSearch} />,
    )

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    expect(screen.getAllByRole('button', { name: 'Buscar en carpeta' })).toHaveLength(5)
    expect(
      within(container).queryByRole('button', { name: /Renombrar|Eliminar|Copiar/ }),
    ).toBeNull()

    const mutating = calls.filter(
      ([input, init]) =>
        /api\/wanted\/scan|api\/files\/queue/.test(String(input)) ||
        (init?.method === 'POST' && !String(input).includes('/api/mixer/probe-cached')),
    )
    expect(mutating).toHaveLength(0)
    expect(onSearch).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { PanelFiles } from '../../../shared/ui/PanelFiles.tsx'
import type { PanelFilesFacts } from '../../../shared/ui/PanelFiles.tsx'

/**
 * S3 («v2-file-pick-and-release-states»): every file row of the Archivos tab
 * carries its own «Buscar en carpeta», so a localized file can be substituted
 * by a better pick and a localization the system missed can be created. The
 * tab stays read-only and the buttons stay inert until clicked.
 */

const BASE = '/peliculas/Film (2012)'

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

const BASE_LISTING = listing(BASE, [
  { name: 'Film.2012.1080p.BluRay.mkv', path: `${BASE}/Film.2012.1080p.BluRay.mkv`, is_dir: false, is_video: true },
  { name: 'Film.720p.mkv', path: `${BASE}/Film.720p.mkv`, is_dir: false, is_video: true },
  { name: 'Film.srt', path: `${BASE}/Film.srt`, is_dir: false, is_video: false },
  { name: 'subs', path: `${BASE}/subs`, is_dir: true, is_video: false },
])

type Call = [input: RequestInfo | URL, init?: RequestInit]

function stubFetch() {
  const calls: Call[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init])
    const url = String(input)
    if (url.includes('/api/files/browse')) {
      return Promise.resolve({ ok: true, json: async () => BASE_LISTING } as Response)
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ paths: { path_4k: '', path_3d: '' } }),
    } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

function renderPanel(panel: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>)
}

/** The table row whose text contains `name`, as the listing rendered it. */
const rowOf = (name: string) =>
  screen.getByText(name).closest('tr') as HTMLElement

const searchButtons = () => screen.getAllByRole('button', { name: 'Buscar en carpeta' })

beforeEach(() => stubFetch())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PanelFiles · sin handler (Series y V1)', () => {
  it('gains no button at all: the plain read-only listing stays plain', async () => {
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    expect(screen.queryByRole('button', { name: 'Buscar en carpeta' })).toBeNull()
    expect(rowOf('Film.2012.1080p.BluRay.mkv')).toBeInTheDocument()
  })
})

describe('PanelFiles · «Buscar en carpeta» por fila (S3)', () => {
  it('gives EVERY file row its own «Buscar en carpeta», sections and flat alike', async () => {
    const onSearch = vi.fn()
    const sections = renderPanel(
      <PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} onSearchInFolder={onSearch} />,
    )

    await within(sections.container).findByText('Film.2012.1080p.BluRay.mkv')
    // Four entries on disk, four buttons — one per row, no row skipped
    // (video, subtitle and folder rows each carry their own).
    expect(
      within(sections.container).getAllByRole('button', { name: 'Buscar en carpeta' }),
    ).toHaveLength(4)

    const flat = renderPanel(<PanelFiles facts={ready} onSearchInFolder={onSearch} />)
    await within(flat.container).findByText('Film.2012.1080p.BluRay.mkv')
    expect(
      within(flat.container).getAllByRole('button', { name: 'Buscar en carpeta' }),
    ).toHaveLength(4)
  })

  it('opens the flow with THAT row’s context — the handler gets the row itself', async () => {
    const onSearch = vi.fn()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} onSearchInFolder={onSearch} />)

    await screen.findByText('Film.720p.mkv')
    fireEvent.click(within(rowOf('Film.720p.mkv')).getByRole('button', { name: 'Buscar en carpeta' }))

    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Film.720p.mkv', path: `${BASE}/Film.720p.mkv`, is_dir: false }),
    )

    fireEvent.click(within(rowOf('subs')).getByRole('button', { name: 'Buscar en carpeta' }))
    expect(onSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'subs', path: `${BASE}/subs`, is_dir: true }),
    )
  })

  it('keeps the tab read-only: the row search never comes with rename/delete/copy', async () => {
    const onSearch = vi.fn()
    const { container } = renderPanel(
      <PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} onSearchInFolder={onSearch} />,
    )

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    expect(searchButtons().length).toBeGreaterThan(0)
    expect(
      within(container).queryByRole('button', { name: /Renombrar|Eliminar|Copiar/ }),
    ).toBeNull()
  })

  it('fires nothing on mount: the rows render inert until a button is clicked', async () => {
    const calls = stubFetch()
    const onSearch = vi.fn()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} onSearchInFolder={onSearch} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    expect(searchButtons().length).toBeGreaterThan(0)

    // The listing's own reads are the whole bill — the persisted-probe cache
    // read predates this button. No scan, no queue, no other POST.
    const mutating = calls.filter(
      ([input, init]) =>
        /api\/wanted\/scan|api\/files\/queue/.test(String(input)) ||
        (init?.method === 'POST' && !String(input).includes('/api/mixer/probe-cached')),
    )
    expect(mutating).toHaveLength(0)
    expect(onSearch).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { PanelFiles } from '../../../shared/ui/PanelFiles.tsx'
import type { PanelFilesFacts } from '../../../shared/ui/PanelFiles.tsx'

/**
 * T3 (S1/S4): the Archivos tab, when given the routing folders, aggregates
 * the movie's three locations (base folder + path_4k + path_3d copies) and
 * renders FOUR sections — 1080, 4K, 3D, Otros — each file under exactly one
 * (S1 precedence), foreign copies never rendered, unclassifiable entries
 * visible under Otros (S4 honesty). WITHOUT folders (Series' tab) the flat
 * table stays byte-identical.
 */

const BASE = '/peliculas/Film (2012)'
const F4K = '/mnt/4k'
const F3D = '/mnt/3d'

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

const video = (name: string, dir: string) => ({
  name,
  path: `${dir}/${name}`,
  is_dir: false,
  is_video: true,
})

const BASE_LISTING = listing(BASE, [
  video('Film.2012.1080p.BluRay.mkv', BASE),
  video('ParaNorman.mkv', BASE),
  video('Film.720p.mkv', BASE),
  { name: 'subs', path: `${BASE}/subs`, is_dir: true, is_video: false },
])

const ROUTING_LISTINGS: Record<string, unknown> = {
  [F4K]: listing(F4K, [
    { name: 'Film (2012)', path: `${F4K}/Film (2012)`, is_dir: true },
    // Another title's copy: the prefix guard must keep it out of this movie.
    video('Other.Movie.2160p.mkv', F4K),
  ]),
  [`${F4K}/Film (2012)`]: listing(`${F4K}/Film (2012)`, [
    video('Film.2160p.mkv', `${F4K}/Film (2012)`),
    { name: 'Film.srt', path: `${F4K}/Film (2012)/Film.srt`, is_dir: false, is_video: false },
  ]),
  [F3D]: listing(F3D, [
    { name: 'Film (2012)', path: `${F3D}/Film (2012)`, is_dir: true },
  ]),
  [`${F3D}/Film (2012)`]: listing(`${F3D}/Film (2012)`, [
    video('Film.3D.SBS.mkv', `${F3D}/Film (2012)`),
  ]),
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch(opts: { brokenRoots?: string[] } = {}) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/files/browse')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '')
      if (opts.brokenRoots?.includes(path)) {
        return Promise.reject(new Error('red caída'))
      }
      const body = path === BASE ? BASE_LISTING : ROUTING_LISTINGS[path]
      if (!body) return ok({ ok: false, error: 'No es un directorio', items: [], path })
      return ok(body)
    }
    return ok({ paths: { path_4k: F4K, path_3d: F3D } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderPanel(panel: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{panel}</QueryClientProvider>)
}

/** The section element whose h4 carries this exact label. */
function sectionOf(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 4, name: label })
  const el = heading.closest('section')
  expect(el, `section wrapper for ${label}`).not.toBeNull()
  return el as HTMLElement
}

beforeEach(() => stubFetch())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PanelFiles sections (folders given)', () => {
  it('renders the four section headings from the three aggregated locations', async () => {
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: F4K, path3d: F3D }} />)

    await screen.findByRole('heading', { level: 4, name: '1080' })
    expect(screen.getByRole('heading', { level: 4, name: '4K' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 4, name: '3D' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 4, name: 'Otros' })).toBeInTheDocument()
  })

  it('files the base folder under 1080 and the tokened ones where the tokens say', async () => {
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: F4K, path3d: F3D }} />)

    await screen.findByRole('heading', { level: 4, name: '1080' })
    const s1080 = sectionOf('1080')
    await within(s1080).findByText('Film.2012.1080p.BluRay.mkv')
    expect(within(s1080).getByText('ParaNorman.mkv')).toBeInTheDocument()

    const sOtros = sectionOf('Otros')
    expect(within(sOtros).getByText('Film.720p.mkv')).toBeInTheDocument()
    expect(within(sOtros).getByText('subs')).toBeInTheDocument()
  })

  it('descends into the copy folders and keeps foreign copies out (prefix guard)', async () => {
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: F4K, path3d: F3D }} />)

    await screen.findByRole('heading', { level: 4, name: '4K' })
    const s4k = sectionOf('4K')
    await within(s4k).findByText('Film.2160p.mkv')
    // A subtitle proves nothing (holdsCopy rule) — visible under Otros, not 4K.
    expect(within(sectionOf('Otros')).getByText('Film.srt')).toBeInTheDocument()

    const s3d = sectionOf('3D')
    await within(s3d).findByText('Film.3D.SBS.mkv')

    expect(screen.queryByText('Other.Movie.2160p.mkv')).not.toBeInTheDocument()
  })

  it('each section keeps the table columns the response carries', async () => {
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: F4K, path3d: F3D }} />)

    await screen.findByRole('heading', { level: 4, name: '1080' })
    const s1080 = sectionOf('1080')
    await within(s1080).findByText('ParaNorman.mkv')
    expect(within(s1080).getByRole('columnheader', { name: 'Nombre' })).toBeInTheDocument()
    expect(within(s1080).getByRole('columnheader', { name: 'Tamaño' })).toBeInTheDocument()
    expect(within(s1080).getByRole('columnheader', { name: 'Modificado' })).toBeInTheDocument()
  })

  it('an unconfigured routing folder reads as an empty section, never as a fetch', async () => {
    const fn = stubFetch()
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: '', path3d: '' }} />)

    await screen.findByRole('heading', { level: 4, name: '4K' })
    expect(within(sectionOf('4K')).getByText('Sin archivos en esta sección')).toBeInTheDocument()
    expect(within(sectionOf('3D')).getByText('Sin archivos en esta sección')).toBeInTheDocument()

    const browseCalls = fn.mock.calls.filter((c) => String(c[0]).includes('/api/files/browse'))
    const routingCalls = browseCalls.filter(
      (c) => !String(c[0]).includes(encodeURIComponent(BASE)),
    )
    expect(routingCalls).toHaveLength(0)
  })

  it('a failed routing folder is an alert, never an empty section', async () => {
    vi.unstubAllGlobals()
    stubFetch({ brokenRoots: [F4K] })
    renderPanel(<PanelFiles facts={ready} folders={{ path4k: F4K, path3d: F3D }} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo leer la ruta')
    expect(within(sectionOf('4K')).queryByText('Sin archivos en esta sección')).toBeNull()
  })
})

describe('PanelFiles without folders (Series parity)', () => {
  it('stays the flat single table — no sections, no routing fetches', async () => {
    const fn = stubFetch()
    renderPanel(<PanelFiles facts={ready} />)

    await screen.findByText('Film.2012.1080p.BluRay.mkv')
    expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Nombre' })).toBeInTheDocument()

    const browseCalls = fn.mock.calls.filter((c) => String(c[0]).includes('/api/files/browse'))
    expect(browseCalls).toHaveLength(1)
  })
})

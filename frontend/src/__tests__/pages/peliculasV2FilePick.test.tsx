import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'

/**
 * S3 («v2-file-pick-and-release-states»), corrected placement: each section
 * CARD of the V2 detail's Archivos tab carries ONE «Buscar en carpeta» in its
 * head (sec-file-card-head, next to sec-analyze-row), ALWAYS visible — the
 * empty card is the case that needs it most. It opens the existing scan/pick
 * flow anchored at the card's folder, and a card with exactly one video takes
 * that video as substitution target; no column in the table.
 */

const MOVIE_PATH = '/movies/ParaNorman'
const ROW_FILE = `${MOVIE_PATH}/ParaNorman.mkv`
const PICKED = '/downloads/Better.Release.mkv'

const paraNorman = {
  id: 7,
  title: 'ParaNorman',
  year: 2012,
  remotePoster: '',
  has_file: true,
  path: MOVIE_PATH,
  path_exists: true,
  monitored: true,
  quality: 'Bluray-1080p',
  class: '1080',
  libraries: ['1080p'],
  file_name: 'ParaNorman.mkv',
  grabbed_at: null,
  grabbed_destination: null,
}

const MATCH = {
  file_path: PICKED,
  file_name: 'Better.Release.mkv',
  movie_id: 7,
  movie_title: 'ParaNorman',
  movie_year: 2012,
  target_path: MOVIE_PATH,
  score: 0.92,
  matched_title: 'ParaNorman',
}

const MATCH_2 = {
  ...MATCH,
  file_path: '/downloads/Worse.Release.mkv',
  file_name: 'Worse.Release.mkv',
  score: 0.71,
}

const FOLDER_LISTING = {
  ok: true,
  path: MOVIE_PATH,
  items: [
    { name: 'ParaNorman.mkv', path: ROW_FILE, is_dir: false, is_video: true, size: 12_000_000_000, modified: 1_759_382_400 },
    { name: 'notes.srt', path: `${MOVIE_PATH}/notes.srt`, is_dir: false, is_video: false, size: 4_000, modified: 1_759_382_400 },
    { name: 'subs', path: `${MOVIE_PATH}/subs`, is_dir: true, is_video: false, size: 0, modified: 1_759_382_400 },
  ],
}

type Call = [input: RequestInfo | URL, init?: RequestInit]

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

function stubFetch() {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      const url = String(input)
      if (url.includes('/api/wanted/all')) {
        return ok({ items: [paraNorman], total: 1, page: 1, page_size: 50, counts: { todos: 1, 'sin archivo': 0, '4K': 0, '3D': 0, '1080': 1, otros: 0 } })
      }
      if (url.includes('/api/files/browse')) {
        const path = decodeURIComponent(url.split('path=')[1] ?? '')
        if (path === MOVIE_PATH) return ok(FOLDER_LISTING)
        return ok({ ok: true, path, items: [] })
      }
      if (url.includes('/api/files/roots')) {
        return ok({ roots: [{ name: 'Películas', path: '/movies' }, { name: 'Descargas', path: '/downloads' }] })
      }
      if (url.includes('/api/wanted/scan')) {
        return ok({ ok: true, matches: [MATCH, MATCH_2], scanned_files: 3, detail: '2 coincidencias' })
      }
      if (url.includes('/api/settings')) {
        return ok({ paths: { path_4k: '/movies/4k', path_3d: '/movies/3d' } })
      }
      return ok({})
    }),
  )
  return calls
}

function renderV2() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Peliculas layout="page" />
    </QueryClientProvider>,
  )
}

const modal = () => document.querySelector('.scan-modal') as HTMLElement

const cardOf = (label: string) => screen.getByRole('region', { name: `Archivos ${label}` })

/** The card head's own chip — the only «Buscar en carpeta» the tab has. */
const headChipOf = (label: string) =>
  within(cardOf(label).querySelector('.sec-file-card-head') as HTMLElement).getByRole('button', {
    name: 'Buscar en carpeta',
  })

async function openFilesTab() {
  renderV2()
  fireEvent.click(await screen.findByRole('button', { name: 'Abrir ParaNorman' }))
  const panel = await screen.findByRole('region', { name: 'Panel de detalle' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Archivos' }))
  await screen.findByText('ParaNorman.mkv')
  return panel
}

/** The scan→pick→place run inside the open modal, starting at the scan button. */
async function pickAndPlace() {
  const scope = within(modal())
  fireEvent.click(scope.getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ }))
  const match = await scope.findByText(PICKED)
  fireEvent.click(match.closest('.scan-match') as HTMLElement)
  fireEvent.click(scope.getByRole('button', { name: /Sustituir el archivo elegido en la cola/ }))
}

/** The body the queue was asked to place, from the captured wire calls. */
function queueBody(calls: Call[]) {
  const call = calls.find(([input]) => String(input).includes('/api/files/queue/add'))
  expect(call, 'a /api/files/queue/add request').toBeDefined()
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>
}

const scanBody = (calls: Call[]) => {
  const call = calls.find(([input]) => String(input).includes('/api/wanted/scan'))
  expect(call, 'a /api/wanted/scan request').toBeDefined()
  return JSON.parse(String(call?.[1]?.body)) as { remote_path?: string }
}

beforeEach(() => {
  window.location.hash = ''
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('V2 · «Buscar en carpeta» en la cabecera de cada tarjeta (S3)', () => {
  it('shows one chip per card head (five), none in the table, and queues nothing on render', async () => {
    const calls = stubFetch()
    const panel = await openFilesTab()

    for (const label of ['1080', '4K', '3D', 'SD', 'Otros']) {
      expect(headChipOf(label)).toBeInTheDocument()
    }
    expect(within(panel).queryByRole('columnheader', { name: 'Buscar en carpeta' })).toBeNull()
    const rows = within(panel).getAllByRole('row').filter((row) => row.querySelector('td'))
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(within(row).queryByRole('button', { name: 'Buscar en carpeta' })).toBeNull()
    }

    const mutating = calls.filter(
      ([input, init]) =>
        /api\/wanted\/scan|api\/files\/queue/.test(String(input)) ||
        (init?.method === 'POST' && !String(input).includes('/api/mixer/probe-cached')),
    )
    expect(mutating).toHaveLength(0)
  })

  it('the 1080 card’s chip opens the flow at the movie folder and substitutes its sole video', async () => {
    const calls = stubFetch()
    await openFilesTab()

    fireEvent.click(headChipOf('1080'))

    expect(document.querySelector('.scan-modal-backdrop')).not.toBeNull()
    expect(modal()).toHaveTextContent('ParaNorman')
    const crumbs = within(modal()).getByRole('navigation', { name: 'Ruta' })
    expect(await within(crumbs).findByRole('button', { name: 'ParaNorman' })).toBeInTheDocument()

    await pickAndPlace()
    await waitFor(() => {
      expect(scanBody(calls).remote_path).toBe(MOVIE_PATH)
      const body = queueBody(calls)
      // The card's sole video is the substitution target the user asked for.
      expect(body.local_path).toBe(ROW_FILE)
      expect(body.remote_path).toBe(PICKED)
      expect(body.source).toBe('copy')
      expect(body.host).toBe('radarr')
      expect((body.ids as Record<string, number>).movie_id).toBe(7)
    })
  })

  it('the EMPTY 4K card still searches: the chip is there and anchors at the 4K root', async () => {
    const calls = stubFetch()
    await openFilesTab()

    expect(
      within(cardOf('4K')).getByText('Sin archivos en esta sección'),
    ).toBeInTheDocument()
    fireEvent.click(headChipOf('4K'))

    expect(modal()).toHaveTextContent('ParaNorman')
    fireEvent.click(within(modal()).getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ }))
    await waitFor(() => {
      expect(scanBody(calls).remote_path).toBe('/movies/4k')
    })
  })

  it('the Otros card (sidecar + folder, no video) localizes beside them, never over them', async () => {
    const calls = stubFetch()
    await openFilesTab()

    fireEvent.click(headChipOf('Otros'))
    const scope = within(modal())
    fireEvent.click(scope.getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ }))
    fireEvent.click((await scope.findByText(PICKED)).closest('.scan-match') as HTMLElement)
    fireEvent.click(scope.getByRole('button', { name: /Colocar \d+ archivos en la cola/ }))

    await waitFor(() => {
      expect(scanBody(calls).remote_path).toBe(MOVIE_PATH)
      const body = queueBody(calls)
      // No sole video in the card → no victim: the pick lands as its own name
      // in the movie folder, never over the subtitle or the folder row.
      expect(body.local_path).toBe(`${MOVIE_PATH}/Better.Release.mkv`)
      expect(body.local_path).not.toBe(`${MOVIE_PATH}/notes.srt`)
    })
  })

  it('substitution is one file in one place: a second pick replaces the selection', async () => {
    await openFilesTab()

    fireEvent.click(headChipOf('1080'))
    const scope = within(modal())
    fireEvent.click(scope.getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ }))
    const first = (await scope.findByText(PICKED)).closest('.scan-match') as HTMLElement
    const second = (await scope.findByText('/downloads/Worse.Release.mkv')).closest('.scan-match') as HTMLElement

    fireEvent.click(first)
    fireEvent.click(second)

    // The victim is ONE file: two picks would queue over each other, so the
    // second pick replaces the first instead of adding to it.
    expect(within(first).getByRole('checkbox')).not.toBeChecked()
    expect(within(second).getByRole('checkbox')).toBeChecked()
    fireEvent.click(second)
    expect(within(second).getByRole('checkbox')).not.toBeChecked()
  })
})

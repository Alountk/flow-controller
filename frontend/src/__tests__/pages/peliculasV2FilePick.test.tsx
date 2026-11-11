import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'

/**
 * S3 («v2-file-pick-and-release-states»): the per-row «Buscar en carpeta» of
 * the V2 detail's Archivos tab. Each row opens the EXISTING scan/pick flow
 * (ScanModal) pre-anchored to the row's folder, and a placed pick takes the
 * row's own path — queue-add copy already substitutes an existing file, so
 * the substitution needs no backend change.
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

/** The table row whose cell holds this exact file name. */
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement

const pickButtonOf = (name: string) =>
  within(rowOf(name)).getByRole('button', { name: 'Buscar en carpeta' })

async function openFilesTab() {
  renderV2()
  fireEvent.click(await screen.findByRole('button', { name: 'Abrir ParaNorman' }))
  const panel = await screen.findByRole('region', { name: 'Panel de detalle' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Archivos' }))
  await screen.findByText('ParaNorman.mkv')
  return panel
}

/** The scan→pick→place run inside the open modal, starting at the scan button.
 *  The match row is keyed by its full path: the visible name line carries an
 *  icon, so only the path line is an exact text match. */
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

beforeEach(() => {
  window.location.hash = ''
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('V2 · «Buscar en carpeta» junto a cada archivo (S3)', () => {
  it('puts a «Buscar en carpeta» on EVERY file row of the detail’s Archivos tab', async () => {
    const calls = stubFetch()
    const panel = await openFilesTab()

    const rows = within(panel).getAllByRole('row').filter((row) => row.querySelector('td'))
    expect(rows.length).toBe(3)
    for (const row of rows) {
      expect(within(row).getByRole('button', { name: 'Buscar en carpeta' })).toBeInTheDocument()
    }

    // Rendering the buttons is free: nothing scans or queues until a click
    // (the persisted-probe cache read is the listing's, not the button's).
    const mutating = calls.filter(
      ([input, init]) =>
        /api\/wanted\/scan|api\/files\/queue/.test(String(input)) ||
        (init?.method === 'POST' && !String(input).includes('/api/mixer/probe-cached')),
    )
    expect(mutating).toHaveLength(0)
  })

  it('opens the scan flow anchored to the row’s folder — the scan starts where the row lives', async () => {
    const calls = stubFetch()
    await openFilesTab()

    fireEvent.click(pickButtonOf('ParaNorman.mkv'))

    // The right flow (the section's own scan modal) over the right movie…
    expect(document.querySelector('.scan-modal-backdrop')).not.toBeNull()
    expect(modal()).toHaveTextContent('ParaNorman')
    // …pre-anchored at the row's folder: the explorer's crumbs say so (once
    // the roots resolve, which is what maps the folder to its crumbs).
    const crumbs = within(modal()).getByRole('navigation', { name: 'Ruta' })
    expect(await within(crumbs).findByRole('button', { name: 'ParaNorman' })).toBeInTheDocument()

    fireEvent.click(within(modal()).getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ }))
    await waitFor(() => {
      const scan = calls.find(([input]) => String(input).includes('/api/wanted/scan'))
      expect(scan).toBeDefined()
      expect(JSON.parse(String(scan?.[1]?.body)).remote_path).toBe(MOVIE_PATH)
    })
  })

  it('substitutes the row’s file: the queue places the pick OVER the row path', async () => {
    const calls = stubFetch()
    await openFilesTab()

    fireEvent.click(pickButtonOf('ParaNorman.mkv'))
    await pickAndPlace()

    await waitFor(() => {
      const body = queueBody(calls)
      // The substitution the user asked for: the better file takes the row's
      // own place (queue-add copy replaces an existing destination).
      expect(body.local_path).toBe(ROW_FILE)
      expect(body.remote_path).toBe(PICKED)
      expect(body.source).toBe('copy')
      expect(body.host).toBe('radarr')
      expect((body.ids as Record<string, number>).movie_id).toBe(7)
    })
  })

  it('a folder row is a search context, not a substitution: the pick lands named as itself', async () => {
    const calls = stubFetch()
    await openFilesTab()

    fireEvent.click(pickButtonOf('subs'))

    // Anchored INSIDE the folder the row names…
    const scanButton = within(modal()).getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ })
    fireEvent.click(scanButton)
    await waitFor(() => {
      const scan = calls.find(([input]) => String(input).includes('/api/wanted/scan'))
      expect(JSON.parse(String(scan?.[1]?.body)).remote_path).toBe(`${MOVIE_PATH}/subs`)
    })

    fireEvent.click((await within(modal()).findByText(PICKED)).closest('.scan-match') as HTMLElement)
    fireEvent.click(within(modal()).getByRole('button', { name: /Colocar \d+ archivos en la cola/ }))

    // …and a video is localized into the movie folder, never written over
    // the folder row (copytree over an existing dir would fail anyway).
    await waitFor(() => {
      const body = queueBody(calls)
      expect(body.local_path).toBe(`${MOVIE_PATH}/Better.Release.mkv`)
    })
  })

  it('a sidecar row stays intact: a video pick localizes beside it, never over it', async () => {
    const calls = stubFetch()
    await openFilesTab()

    fireEvent.click(pickButtonOf('notes.srt'))
    const scope = within(modal())
    fireEvent.click(scope.getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ }))
    fireEvent.click((await scope.findByText(PICKED)).closest('.scan-match') as HTMLElement)
    fireEvent.click(scope.getByRole('button', { name: /Colocar \d+ archivos en la cola/ }))

    await waitFor(() => {
      const body = queueBody(calls)
      // The flow only ever picks videos: writing one over a subtitle's path
      // would corrupt the folder, so the sidecar is never the destination.
      expect(body.local_path).toBe(`${MOVIE_PATH}/Better.Release.mkv`)
      expect(body.local_path).not.toBe(`${MOVIE_PATH}/notes.srt`)
    })
  })

  it('substitution is one file in one place: a second pick replaces the selection', async () => {
    await openFilesTab()

    fireEvent.click(pickButtonOf('ParaNorman.mkv'))
    const scope = within(modal())
    fireEvent.click(scope.getByRole('button', { name: /Buscar "ParaNorman" en esta carpeta/ }))
    const first = (await scope.findByText(PICKED)).closest('.scan-match') as HTMLElement
    const second = (await scope.findByText('/downloads/Worse.Release.mkv')).closest('.scan-match') as HTMLElement

    fireEvent.click(first)
    fireEvent.click(second)

    // The row's path is ONE file: two picks would queue over each other, so
    // the second pick replaces the first instead of adding to it.
    expect(within(first).getByRole('checkbox')).not.toBeChecked()
    expect(within(second).getByRole('checkbox')).toBeChecked()
    fireEvent.click(second)
    expect(within(second).getByRole('checkbox')).not.toBeChecked()
  })
})

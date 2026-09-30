import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileManager } from '../components/FileManager'

/**
 * Wiring-level tests for the file explorer's multi-file selection.
 *
 * The pure selection helpers are covered in selection.test.ts. What these
 * guard is the integration: that the "select all" control feeds the CURRENT
 * directory listing to `toggleVisibleSelection`, that a batch fans out to the
 * per-item endpoints that already exist (one request each, sequentially), and
 * that a per-item refusal — the seed guard answering a `move` — reaches the
 * screen with the backend's own words instead of being collapsed into a
 * generic "algo falló".
 *
 * fetch is stubbed at the network boundary, like the other component tests.
 */

interface BrowseItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
}

const dir = (name: string): BrowseItem => ({
  name,
  path: `/mnt/storage/${name}`,
  is_dir: true,
  size: 0,
  modified: 0,
})

const file = (name: string, size = 1_500_000_000): BrowseItem => ({
  name,
  path: `/mnt/storage/${name}`,
  is_dir: false,
  size,
  modified: 0,
})

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** The seed guard's real refusal for a `move` out of the torrent folder. */
const SEED_GUARD =
  "'Seed.mkv' está en la carpeta de descargas de torrents (/mnt/storage/torrents) y no se " +
  'puede mover: qBittorrent comparte exactamente esa ruta, y renombrarla o moverla ' +
  'rompe el hardlink con el que sigue sembrando. En su lugar, copia o coloca el ' +
  'fichero — se resuelve con un enlace duro y la semilla no se entera.'

interface MockOptions {
  /** Browse listings keyed by path; anything else lists as empty. */
  listings?: Record<string, BrowseItem[]>
  /** Backend answer for one queue/add call, decided per file. */
  onQueueAdd?: (body: Record<string, unknown>) => { ok: boolean; detail: string }
  /** Backend answer for one delete call, decided per path. */
  onDelete?: (path: string) => { ok: boolean; detail: string }
  /** Simulated per-delete latency, to expose non-sequential fan-out. */
  deleteDelayMs?: number
}

interface MockedFetch {
  fn: ReturnType<typeof vi.fn>
  /** Peak number of delete requests in flight at once. Sequential means 1. */
  maxDeleteInFlight: () => number
  /** Log of `confirm:` / `delete:` events, for asserting order. */
  events: string[]
}

function mockFetch(options: MockOptions = {}): MockedFetch {
  const listings = options.listings ?? { '/mnt/storage': [] }
  const onQueueAdd = options.onQueueAdd ?? (() => ({ ok: true, detail: 'Agregado a la cola' }))
  const onDelete = options.onDelete ?? (() => ({ ok: true, detail: 'Eliminado' }))
  const events: string[] = []
  let inFlight = 0
  let peak = 0

  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.includes('/api/files/roots')) {
      return ok({ roots: [{ path: '/mnt/storage', name: 'storage' }] })
    }

    if (url.includes('/api/files/browse')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, items: listings[path] ?? [] })
    }

    if (url.includes('/api/files/delete')) {
      const body = JSON.parse(String(init?.body)) as { remote_path: string }
      events.push(`delete:${body.remote_path}`)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // A hang per request, so a Promise.all fan-out would show peak > 1 while
      // a sequential loop shows exactly 1.
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          inFlight -= 1
          resolve(ok(onDelete(body.remote_path)))
        }, options.deleteDelayMs ?? 0)
      })
    }

    if (url.includes('/api/files/queue/add')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return ok(onQueueAdd(body))
    }

    void init
    return ok({})
  })

  vi.stubGlobal('fetch', fn)
  return { fn, maxDeleteInFlight: () => peak, events }
}

type AnyFetch = ReturnType<typeof mockFetch>['fn']

function queueBodies(fn: AnyFetch): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes('/api/files/queue/add'))
    .map(([, init]) => JSON.parse(String((init as RequestInit)?.body)) as Record<string, unknown>)
}

function deleteBodies(fn: AnyFetch): { remote_path: string }[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes('/api/files/delete'))
    .map(([, init]) => JSON.parse(String((init as RequestInit)?.body)) as { remote_path: string })
}

function renderFileManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileManager />
    </QueryClientProvider>,
  )
}

/** Renders the explorer and waits for the root listing to be on screen. */
async function openPane() {
  renderFileManager()
  await screen.findByText('A.mkv')
}

/** Accessible name of every row checkbox inside the list. */
function checkedRowNames(): (string | null)[] {
  const list = document.querySelector('.fm-list') as HTMLElement
  return within(list)
    .getAllByRole('checkbox')
    .filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.getAttribute('aria-label'))
}

describe('FileManager multi-file selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('select-all marks exactly the visible rows, and Limpiar empties the selection', async () => {
    mockFetch({ listings: { '/mnt/storage': [file('A.mkv'), file('B.mkv'), file('C.mkv')] } })
    await openPane()

    // No batch toolbar while nothing is selected.
    expect(screen.queryByText('Limpiar')).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar A.mkv' }))
    expect(screen.getByText('1 seleccionado')).toBeInTheDocument()

    // The checkbox must not reach the row's own click handler: if it did, the
    // second click would replace the selection instead of adding to it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar B.mkv' }))
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument()

    // The batch control only ever touches what is on screen: exactly these
    // three rows, no more and no less.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todo' }))
    expect(screen.getByText('3 seleccionados')).toBeInTheDocument()
    expect(checkedRowNames()).toEqual([
      'Seleccionar A.mkv',
      'Seleccionar B.mkv',
      'Seleccionar C.mkv',
    ])

    // The helper's round-trip: everything visible is selected, so the same
    // control deselects exactly those rows.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todo' }))
    expect(screen.queryByText('3 seleccionados')).toBeNull()
    expect(checkedRowNames()).toEqual([])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar B.mkv' }))
    expect(screen.getByText('1 seleccionado')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
    expect(screen.queryByText('Limpiar')).toBeNull()
    expect(checkedRowNames()).toEqual([])
  })

  it('batch delete confirms with the count and the irreversibility sentence, then deletes each file', async () => {
    const mocked = mockFetch({
      listings: { '/mnt/storage': [file('A.mkv'), file('B.mkv'), file('C.mkv')] },
      deleteDelayMs: 5,
    })
    const confirmMessages: string[] = []
    let confirmAnswer = false
    vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      confirmMessages.push(String(message))
      mocked.events.push(`confirm:${String(message)}`)
      return confirmAnswer
    })
    await openPane()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todo' }))
    expect(screen.getByText('3 seleccionados')).toBeInTheDocument()

    // Refusing the confirmation must delete nothing at all.
    fireEvent.click(screen.getByText('Eliminar'))
    expect(confirmMessages).toHaveLength(1)
    expect(confirmMessages[0]).toContain('3 elementos seleccionados')
    expect(confirmMessages[0]).toContain('no se puede deshacer')
    expect(confirmMessages[0]).toContain('no podrás recuperar los datos')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(deleteBodies(mocked.fn)).toHaveLength(0)

    // Accepting it sends one request per selected file, sequentially.
    confirmAnswer = true
    fireEvent.click(screen.getByText('Eliminar'))
    expect(confirmMessages).toHaveLength(2)

    await waitFor(() => expect(deleteBodies(mocked.fn)).toHaveLength(3))
    expect(new Set(deleteBodies(mocked.fn).map((b) => b.remote_path))).toEqual(
      new Set(['/mnt/storage/A.mkv', '/mnt/storage/B.mkv', '/mnt/storage/C.mkv']),
    )
    // The confirmation always comes before the first unlink.
    expect(mocked.events[0]).toMatch(/^confirm:/)
    expect(mocked.events.findIndex((e) => e.startsWith('delete:'))).toBeGreaterThan(0)
    // Concurrency against a network mount: never more than one at a time.
    expect(mocked.maxDeleteInFlight()).toBe(1)
    expect(await screen.findByText('3 eliminados, 0 rechazados')).toBeInTheDocument()
  })

  it('batch move surfaces the refused item\u2019s own message while the rest report success', async () => {
    const mocked = mockFetch({
      listings: { '/mnt/storage': [file('A.mkv'), file('B.mkv'), file('Seed.mkv')] },
      onQueueAdd: (body) =>
        String(body.remote_path).endsWith('/Seed.mkv')
          ? { ok: false, detail: SEED_GUARD }
          : { ok: true, detail: `Agregado a la cola: ${String(body.remote_path)}` },
    })
    await openPane()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todo' }))
    fireEvent.click(screen.getByText('Mover'))

    // Summary with counts — not a collapsed "algo falló".
    expect(await screen.findByText('2 colocados, 1 rechazado')).toBeInTheDocument()

    // The seed guard's refusal is rendered with the backend's own words...
    expect(screen.getByText(SEED_GUARD)).toBeInTheDocument()
    // ...and attributed to the file it is about.
    const report = document.querySelector('.fm-batch-report') as HTMLElement
    expect(within(report).getByText('Seed.mkv')).toBeInTheDocument()

    // Every selected file was offered to the backend: the refusal is the
    // backend's answer, not the frontend quietly skipping the item.
    expect(queueBodies(mocked.fn)).toHaveLength(3)
    expect(queueBodies(mocked.fn).map((b) => b.source)).toEqual(['move', 'move', 'move'])
    expect(new Set(queueBodies(mocked.fn).map((b) => b.remote_path))).toEqual(
      new Set(['/mnt/storage/A.mkv', '/mnt/storage/B.mkv', '/mnt/storage/Seed.mkv']),
    )
  })

  it('clears the selection when navigating into another directory', async () => {
    mockFetch({
      listings: {
        '/mnt/storage': [dir('subcarpeta'), file('A.mkv')],
        '/mnt/storage/subcarpeta': [file('Dentro.mkv')],
      },
    })
    await openPane()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todo' }))
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument()

    fireEvent.dblClick(screen.getByText('subcarpeta'))

    expect(await screen.findByText('Dentro.mkv')).toBeInTheDocument()
    expect(screen.queryByText('2 seleccionados')).toBeNull()
    expect(screen.queryByText('Limpiar')).toBeNull()
    expect(checkedRowNames()).toEqual([])
  })
})

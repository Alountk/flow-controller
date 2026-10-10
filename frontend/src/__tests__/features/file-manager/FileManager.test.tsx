import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileManager } from '../../../features/file-manager/FileManager.tsx'
import type { RetentionFile, RootsResponse } from '../../../shared/types.ts'

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
  /** Retention rows keyed by directory path; anything else comes back empty. */
  retention?: Record<string, RetentionFile[]>
  /** Roots for /api/files/roots; defaults to the navigation mount alone. */
  roots?: RootsResponse['roots']
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
  const retention = options.retention ?? {}
  const onQueueAdd = options.onQueueAdd ?? (() => ({ ok: true, detail: 'Agregado a la cola' }))
  const onDelete = options.onDelete ?? (() => ({ ok: true, detail: 'Eliminado' }))
  const events: string[] = []
  let inFlight = 0
  let peak = 0

  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.includes('/api/files/roots')) {
      return ok({
        roots: options.roots ?? [
          { path: '/mnt/storage', name: 'storage', role: 'navigation', label: 'storage' },
        ],
        detail: '',
      })
    }

    if (url.includes('/api/files/browse')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, items: listings[path] ?? [] })
    }

    if (url.includes('/api/files/retention')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, days: 7, files: retention[path] ?? [] })
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

/** URLs of every call in issue order, so "refetch AFTER the deletes" is provable. */
function requestOrder(fn: AnyFetch): string[] {
  return fn.mock.calls.map(([input]) => String(input))
}

function renderFileManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileManager />
    </QueryClientProvider>,
  )
}

/** Renders the explorer and waits for a known row of the root listing. */
async function openPane(firstRow = 'A.mkv') {
  renderFileManager()
  await screen.findByText(firstRow)
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

  it('annotates each row with its retention age, and shows nothing when there is no age', async () => {
    mockFetch({
      listings: {
        '/mnt/storage': [file('Recien.mkv'), file('Nuevo.mkv'), file('Viejo.mkv'), file('SinEdad.mkv')],
      },
      retention: {
        '/mnt/storage': [
          { name: 'Recien.mkv', first_seen_at: 1759200000, age_days: 0.4, expired: false, provenance: null, provenance_label: null },
          { name: 'Nuevo.mkv', first_seen_at: 1759000000, age_days: 2.4, expired: false, provenance: null, provenance_label: null },
          { name: 'Viejo.mkv', first_seen_at: 1758000000, age_days: 12.4, expired: true, provenance: null, provenance_label: null },
          { name: 'SinEdad.mkv', first_seen_at: null, age_days: null, expired: false, provenance: null, provenance_label: null },
        ],
      },
    })
    await openPane('Viejo.mkv')

    // Not yet past the window: how long it has been here, in days.
    expect(await screen.findByText('hace 2 días')).toBeInTheDocument()
    expect(screen.getByText('hoy')).toBeInTheDocument()
    // Under a day old is "hoy", not "hace 0 días".
    expect(screen.queryByText(/hace 0/)).toBeNull()

    // Expired is a STATE, not an error: its own word and its own class,
    // never the red used for failures.
    const caducados = screen.getAllByText('caducado')
    expect(caducados).toHaveLength(1)
    expect(caducados[0].className).toContain('expired')
    expect(caducados[0].className).not.toContain('bad')

    // The store was unreadable for this file: no chip and no fabricated age —
    // a made-up age could justify deleting something never recorded.
    const row = screen.getByText('SinEdad.mkv').closest('.fm-item') as HTMLElement
    expect(row.querySelector('.fm-age')).toBeNull()
    expect(within(row).queryByText(/días|día|hoy|caducado/)).toBeNull()
  })

  it('marks each row with its provenance chip, and shows nothing when no source claims it', async () => {
    // F-07: procedencia — cola · importando / histórico / lo pedimos nosotros.
    // Display-only: the chip explains why the file is there, it never gates
    // an action, and an unclaimed file gets NO chip (null == absence).
    mockFetch({
      listings: {
        '/mnt/storage': [file('Cola.mkv'), file('Historico.mkv'), file('Nuestro.mkv'), file('SinDueno.mkv')],
      },
      retention: {
        '/mnt/storage': [
          {
            name: 'Cola.mkv', first_seen_at: 1, age_days: 1, expired: false,
            provenance: 'queue', provenance_label: 'cola · importando',
          },
          {
            name: 'Historico.mkv', first_seen_at: 1, age_days: 1, expired: false,
            provenance: 'history', provenance_label: 'histórico',
          },
          {
            name: 'Nuestro.mkv', first_seen_at: 1, age_days: 1, expired: false,
            provenance: 'own', provenance_label: 'lo pedimos nosotros',
          },
          {
            name: 'SinDueno.mkv', first_seen_at: 1, age_days: 1, expired: false,
            provenance: null, provenance_label: null,
          },
        ],
      },
    })
    await openPane('Cola.mkv')

    expect(await screen.findByText('cola · importando')).toBeInTheDocument()
    expect(screen.getByText('histórico')).toBeInTheDocument()
    expect(screen.getByText('lo pedimos nosotros')).toBeInTheDocument()

    const row = screen.getByText('SinDueno.mkv').closest('.fm-item') as HTMLElement
    expect(row.querySelector('.fm-prov')).toBeNull()
  })

  it('Marcar caducados shows only when something is expired, and selects exactly those rows', async () => {
    // Nothing is past the window: the button must not exist at all.
    mockFetch({
      listings: { '/mnt/storage': [file('A.mkv'), file('B.mkv')] },
      retention: {
        '/mnt/storage': [
          { name: 'A.mkv', first_seen_at: 1, age_days: 1.5, expired: false, provenance: null, provenance_label: null },
          { name: 'B.mkv', first_seen_at: 1, age_days: 2.5, expired: false, provenance: null, provenance_label: null },
        ],
      },
    })
    const first = renderFileManager()
    // Retention data is on screen — its absence is what hides the button,
    // not a query still in flight.
    expect(await screen.findByText('hace 1 día')).toBeInTheDocument()
    expect(screen.queryByText('Marcar caducados')).toBeNull()
    first.unmount()

    // With expired rows the button appears and is a pure selection action.
    const second = mockFetch({
      listings: { '/mnt/storage': [file('A.mkv'), file('B.mkv'), file('C.mkv')] },
      retention: {
        '/mnt/storage': [
          { name: 'A.mkv', first_seen_at: 1, age_days: 12, expired: true, provenance: null, provenance_label: null },
          { name: 'B.mkv', first_seen_at: 1, age_days: 2, expired: false, provenance: null, provenance_label: null },
          { name: 'C.mkv', first_seen_at: 1, age_days: 12, expired: true, provenance: null, provenance_label: null },
        ],
      },
    })
    renderFileManager()
    expect(await screen.findAllByText('caducado')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Marcar caducados' }))

    // Exactly the expired rows — the fresh one stays unselected — and nothing
    // is deleted: selecting is the whole action, the delete goes through the
    // batch bar's own confirmation.
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument()
    expect(checkedRowNames()).toEqual(['Seleccionar A.mkv', 'Seleccionar C.mkv'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requestOrder(second.fn).filter((u) => u.includes('/api/files/delete'))).toHaveLength(0)
  })

  it('a batch delete refetches the retention query after the files are gone', async () => {
    const mocked = mockFetch({
      listings: { '/mnt/storage': [file('A.mkv'), file('B.mkv'), file('C.mkv')] },
      retention: {
        '/mnt/storage': [
          { name: 'A.mkv', first_seen_at: 1, age_days: 12, expired: true, provenance: null, provenance_label: null },
          { name: 'B.mkv', first_seen_at: 1, age_days: 2.5, expired: false, provenance: null, provenance_label: null },
          { name: 'C.mkv', first_seen_at: 1, age_days: 12, expired: true, provenance: null, provenance_label: null },
        ],
      },
      deleteDelayMs: 2,
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openPane()
    await screen.findAllByText('caducado')

    const retentionCalls = () =>
      requestOrder(mocked.fn).filter((u) => u.includes('/api/files/retention'))
    expect(retentionCalls()).toHaveLength(1)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todo' }))
    fireEvent.click(screen.getByText('Eliminar'))
    await waitFor(() =>
      expect(screen.getByText('3 eliminados, 0 rechazados')).toBeInTheDocument(),
    )

    // Assert the REFETCH — a second GET /api/files/retention on the network —
    // not merely that invalidateQueries was called with some key...
    await waitFor(() => expect(retentionCalls().length).toBeGreaterThan(1))

    // ...and that it lands strictly after the last unlink, because that is the
    // moment the ages and the pruned rows actually change.
    const order = requestOrder(mocked.fn)
    const lastDelete = Math.max(
      ...order.map((u, i) => (u.includes('/api/files/delete') ? i : -1)),
    )
    expect(deleteBodies(mocked.fn)).toHaveLength(3)
    expect(retentionCalls().length).toBeGreaterThanOrEqual(2)
    expect(order.some((u, i) => u.includes('/api/files/retention') && i > lastDelete)).toBe(true)
  })

  it('labels the roots, groups destinations under Destinos, and keeps navigation first', async () => {
    mockFetch({
      listings: { '/mnt/storage': [file('A.mkv')] },
      roots: [
        { path: '/mnt/storage', name: 'storage', role: 'navigation', label: 'storage' },
        { path: '/mnt/storage-6tb', name: 'storage-6tb', role: 'navigation', label: 'storage-6tb' },
        {
          path: '/mnt/storage/movies/es',
          name: 'es',
          role: 'library',
          service: 'radarr',
          label: 'Biblioteca (películas) · 1080 y por debajo',
        },
        { path: '/mnt/storage/movies/4k', name: '4k', role: '4k', label: '4K · 2160p' },
      ],
    })
    renderFileManager()
    await screen.findByText('A.mkv')

    const selects = document.querySelectorAll<HTMLSelectElement>('.fm-volume-select')
    expect(selects.length).toBeGreaterThan(0)

    for (const select of selects) {
      const options = Array.from(select.querySelectorAll('option'))
      const texts = options.map((o) => o.textContent)

      // The label renders, not the raw name: the library option shows its
      // words and never the bare folder name `es`...
      expect(texts).toContain('Biblioteca (películas) · 1080 y por debajo')
      expect(texts).toContain('4K · 2160p')
      expect(texts).not.toContain('es')

      // ...the destinations live in their own optgroup...
      const group = select.querySelector('optgroup')
      expect(group?.getAttribute('label')).toBe('Destinos')
      const groupOptions = options.filter((o) => o.parentElement === group)

      // ...and navigation still comes first, before any destination: the two
      // mounts stay the options roots[0]/roots[1] the panes default to.
      const plain = options.filter((o) => o.parentElement === select)
      expect(plain.map((o) => o.value)).toEqual(['/mnt/storage', '/mnt/storage-6tb'])
      expect(groupOptions.map((o) => o.value)).toEqual([
        '/mnt/storage/movies/es',
        '/mnt/storage/movies/4k',
      ])
      expect(options.indexOf(plain[0])).toBeLessThan(options.indexOf(groupOptions[0]))
    }
  })
})

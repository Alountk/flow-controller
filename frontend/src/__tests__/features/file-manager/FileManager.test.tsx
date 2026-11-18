import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileManager } from '../../../features/file-manager/FileManager.tsx'
import type { RetentionFile, RootsResponse } from '../../../shared/types.ts'

/**
 * Wiring-level tests for the file explorer pane.
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

describe('FileManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clicking a folder\u2019s name enters it and a file click does nothing', async () => {
    mockFetch({
      listings: {
        '/mnt/storage': [dir('subcarpeta'), dir('otra'), file('A.mkv')],
        '/mnt/storage/subcarpeta': [file('Dentro.mkv')],
        '/mnt/storage/otra': [file('Fuera.mkv')],
      },
    })
    await openPane('A.mkv')

    // A file has nothing to enter: the listing stays where it is.
    fireEvent.click(screen.getByText('A.mkv'))
    expect(screen.getByText('otra')).toBeInTheDocument()

    // The name enters.
    fireEvent.click(screen.getByText('subcarpeta'))
    expect(await screen.findByText('Dentro.mkv')).toBeInTheDocument()
  })

  it('clicking a folder\u2019s icon enters it', async () => {
    mockFetch({
      listings: {
        '/mnt/storage': [dir('subcarpeta')],
        '/mnt/storage/subcarpeta': [file('Dentro.mkv')],
      },
    })
    await openPane('subcarpeta')

    const row = screen.getByText('subcarpeta').closest('.explorer-row') as HTMLElement
    fireEvent.click(row.querySelector('.explorer-icon') as HTMLElement)

    expect(await screen.findByText('Dentro.mkv')).toBeInTheDocument()
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
    const row = screen.getByText('SinEdad.mkv').closest('.explorer-row') as HTMLElement
    expect(row.querySelector('.fm-age')).toBeNull()
    expect(within(row).queryByText(/días|día|hoy|caducado/)).toBeNull()
  })

  it('keeps the name, its provenance and its date in ONE block, stacked (S1)', async () => {
    // Long file names and long provenance labels fought for the same line and
    // broke every column: the name block now owns the row's leftover width and
    // carries its own second line.
    mockFetch({
      listings: {
        '/mnt/storage': [
          { ...file('UnNombreLarguisimo.De.Pelicula.2024.2160p.mkv'), modified: 1_759_382_400_000 },
        ],
      },
      retention: {
        '/mnt/storage': [
          {
            name: 'UnNombreLarguisimo.De.Pelicula.2024.2160p.mkv',
            first_seen_at: 1759000000, age_days: 2.4, expired: false,
            provenance: 'queue', provenance_label: 'cola · importando',
          },
        ],
      },
    })
    await openPane('UnNombreLarguisimo.De.Pelicula.2024.2160p.mkv')

    const row = screen
      .getByText('UnNombreLarguisimo.De.Pelicula.2024.2160p.mkv')
      .closest('.explorer-row') as HTMLElement
    const main = row.querySelector('.explorer-name') as HTMLElement
    expect(main).not.toBeNull()
    expect(main.querySelector('.fm-name')?.textContent).toBe(
      'UnNombreLarguisimo.De.Pelicula.2024.2160p.mkv',
    )

    // The second line carries provenance and age…
    const sub = main.querySelector('.explorer-meta') as HTMLElement
    expect(sub).not.toBeNull()
    expect(await within(sub).findByText('cola · importando')).toBeInTheDocument()
    expect(sub.querySelector('.fm-age')).not.toBeNull()

    // …and the date is a column of its own now, in every explorador.
    expect(row.querySelector(':scope > .explorer-date')?.textContent).not.toBe('—')
    expect(sub.querySelector('.fm-date')).toBeNull()
  })

  it('names the five columns every explorador has (S2)', async () => {
    mockFetch({ listings: { '/mnt/storage': [file('Uno.mkv')] } })
    await openPane('Uno.mkv')

    const head = document.querySelector('.explorer-head') as HTMLElement
    expect(head).not.toBeNull()
    for (const column of ['Nombre', 'Tipo', 'Tamaño', 'Modificado', 'Acciones']) {
      expect(within(head).getByText(column)).toBeInTheDocument()
    }
    // Provenance and retention are content the slot puts under the name:
    // a column of their own would promise something no other sitio can fill.
    expect(within(head).queryByText('Procedencia')).toBeNull()
    expect(within(head).queryByText('Retención')).toBeNull()
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

    const row = screen.getByText('SinDueno.mkv').closest('.explorer-row') as HTMLElement
    expect(row.querySelector('.fm-prov')).toBeNull()
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

    const selects = document.querySelectorAll<HTMLSelectElement>('.explorer-select')
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
      const group = select.querySelector<HTMLOptGroupElement>('optgroup[label="Destinos"]')
      expect(group).not.toBeNull()
      const groupOptions = options.filter((o) => o.parentElement === group)

      // ...and navigation still comes first, before any destination: the two
      // mounts stay the options roots[0]/roots[1] the panes default to.
      const plain = options.filter((o) => o.parentElement !== group)
      expect(plain.map((o) => o.value)).toEqual(['/mnt/storage', '/mnt/storage-6tb'])
      expect(groupOptions.map((o) => o.value)).toEqual([
        '/mnt/storage/movies/es',
        '/mnt/storage/movies/4k',
      ])
      expect(options.indexOf(plain[0])).toBeLessThan(options.indexOf(groupOptions[0]))
    }
  })

})

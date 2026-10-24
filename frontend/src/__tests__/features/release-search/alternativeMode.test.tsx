import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * T2 — «alternativa sin ruteo» (S1-S3, odd/tasks/alternativa-sin-ruteo.md).
 *
 * S1 (verbatim): las alternativas «deberian descargarse en la carpeta normal de
 * descarga y no mostrar las opciones de Normal / 4k / 3d esto machacaria los
 * archivos que aislados». S2 fija el alcance: se excluyen el ruteo (los tres
 * destinos F-12: → Biblioteca / → 4K / → 3D) y la sugerencia por calidad
 * (`destinationFor` → 4K para 2160p) — SÓLO cuando el modal abre en modo
 * alternativa (`alternativeMode`). Películas/Series/calendario/panel no pasan
 * la prop y conservan las tres opciones byte-idénticas (S3): ese contrato se
 * pinnea AQUÍ, en diferencial.
 *
 * El único «Descargar» del modo alternativa dispara el MISMO grab que el
 * «→ Biblioteca» de siempre: `library=true` y sin `destination` — el camino
 * arr (`arr_grab_release`), el único por el que `alternativeStatus` llega a
 * `ready` y auto-coloca el fichero (S10). Un destino `path_4k`/`path_3d` es
 * descarga DIRECTA (fuera de las raíces del arr): jamás `ready`, y el fichero
 * cae en la carpeta de ruteo junto a las copias ya aisladas — el «machacar»
 * de S1. Un `destination` derivado de la calidad (2160p → path_4k) sería el
 * mismo destrozo por otra puerta: por eso la sugerencia también desaparece.
 *
 * Colisión de accesible names: la sección «Búsqueda en idioma» (que sólo el
 * modal de alternativa monta) tiene sus propios botones «Descargar». Todas
 * las queries de este archivo se acotan al CONTENEDOR de la fila
 * (`.calendar-release`) o a la región de releases — nunca se relaja el
 * matcher.
 *
 * RTL + fireEvent only — `@testing-library/user-event` is not installed, and
 * `fireEvent.click` fires on disabled buttons, so the component must guard the
 * handler itself.
 */

function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    guid: 'en-1',
    title: 'Everything Everywhere All at Once 2022 1080p BluRay',
    size: 10_000_000_000,
    quality: 'Bluray-1080p',
    indexer: 'aMuTorrent',
    indexerId: 1,
    indexerFlags: '',
    seeders: 10,
    leechers: 1,
    protocol: 'torrent',
    releaseGroup: '',
    languages: ['English'],
    ...overrides,
  }
}

/** The row the routing rules WOULD suggest → 4K for (2160p + configured
 *  folder) — the case S1 calls out and S2 excludes from suggestion too. */
const RELEASE_4K = makeRelease({ guid: '4k-1', quality: 'Bluray-2160p' })
const RELEASE_HD = makeRelease({
  guid: 'hd-1',
  title: 'Plain Movie 2022 1080p BluRay',
  quality: 'Bluray-1080p',
})

const indexers = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

interface MockOptions {
  /** The routing-folders read (GET /api/settings) fails outright. */
  routingFail?: boolean
  /** Overrides the configured 4K folder; '' means "not configured". */
  path4k?: string
  /** Replace the canned results, for the cases that need a different mix. */
  releases?: Release[]
}

function mockFetch(options: MockOptions = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => indexers } as Response)
    }
    if (url.includes('/api/settings')) {
      if (options.routingFail) {
        return Promise.reject(new Error('settings unavailable'))
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          paths: { path_4k: options.path4k ?? '/mnt/storage-6tb/4k', path_3d: '/mnt/storage/6tb/3d' },
        }),
      } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      const rows = options.releases ?? [RELEASE_4K, RELEASE_HD]
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases: rows, detail: `${rows.length} releases encontrados` }),
      } as Response)
    }
    if (url.includes('/api/calendar/grab')) {
      // async-grab: the POST starts the job; the status GET settles it.
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, task_id: 'grab-1', status: 'running', detail: 'Descarga lanzada' }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, id: 'grab-1', status: 'done', detail: 'Descarga iniciada' }),
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof mockFetch>

/** Every grab request body the modal has sent, in order. Status GETs carry
 *  no body, so only the POSTs are counted. */
function grabBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(
      ([input, init]) =>
        String(input).includes('/api/calendar/grab') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

interface ModalProps {
  alternativeMode?: boolean
  onGrabStarted?: (taskId: string) => void
  languageSearch?: {
    originalTitle: string | null
    alternateTitles: { title: string; language: string | null }[]
    movieId: number
  }
}

function renderModal(props: ModalProps = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 411, title: 'Everything Everywhere All at Once', source: 'radarr' }}
        onClose={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  )
}

async function openResults(props: ModalProps = {}) {
  const view = renderModal(props)
  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
  await waitFor(() => expect(screen.getByPlaceholderText('Filtrar por título...')).toBeInTheDocument())
  return view
}

/** The rendered rows, in order — the container every name query is scoped to. */
const releaseRows = () => [...document.querySelectorAll('.calendar-release')] as HTMLElement[]

/** The ONE download action of a row in alternative mode. Scoped to the row:
 *  the «Búsqueda en idioma» section owns its own «Descargar» buttons. */
const rowDownload = (row: HTMLElement) =>
  within(row).getByRole('button', { name: 'Descargar' })

/** Press a non-alternative destination button (F-12) inside a given row. */
function pressDest(target: 'Biblioteca' | '4K' | '3D', row = 0) {
  const rowEl = document.querySelectorAll('.release-dest')[row] as HTMLElement
  const name = target === 'Biblioteca' ? /Biblioteca/ : target === '4K' ? /4K/ : /3D/
  fireEvent.click(within(rowEl).getByRole('button', { name }))
}

/* ── Modo alternativa: SIN opciones de destino (S1) ──────────────────────── */

describe('ReleaseSearchModal alternativeMode — sin Normal/4K/3D (S1/T2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replaces the three destination buttons with ONE «Descargar» per row — even for a 2160p row', async () => {
    mockFetch()
    await openResults({ alternativeMode: true })

    // The whole destination row is gone, not just thinned out.
    expect(document.querySelectorAll('.release-dest')).toHaveLength(0)
    expect(document.querySelectorAll('.release-dest-btn')).toHaveLength(0)
    // …and with it every per-row destination choice («Normal / 4k / 3d»).
    const rows = releaseRows()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(within(row).queryAllByRole('button', { name: /^→/ })).toHaveLength(0)
      expect(within(row).queryAllByRole('button', { name: /Biblioteca/ })).toHaveLength(0)
      // Scoped by name to the row: the 3D TITLE chip (a title flag, kept) is
      // "Marcar … como 3D" / "Quitar la marca 3D de …", never "→ 3D".
      expect(within(row).queryAllByRole('button', { name: /^(→ 4K|→ 3D)/ })).toHaveLength(0)
      // Exactly one download action — the row's «Descargar».
      expect(within(row).getAllByRole('button', { name: 'Descargar' })).toHaveLength(1)
    }
  })

  it('hides the destination suggestion too — no `suggest` highlight, no routing note (2160p row)', async () => {
    // The routing read fails AND the row is 2160p: the two cases where
    // `destinationFor` speaks (a highlighted button / "la que decida el
    // backend…"). In alternative mode it must say nothing at all.
    mockFetch({ routingFail: true })
    await openResults({ alternativeMode: true })

    expect(document.querySelectorAll('.release-dest-btn.suggest')).toHaveLength(0)
    expect(document.querySelectorAll('.suggest')).toHaveLength(0)
    expect(screen.queryByText(/decida el backend/)).toBeNull()
    // The 2160p row still downloads — just without a routed suggestion.
    expect(rowDownload(releaseRows()[0])).toBeEnabled()
  })

  it('the single «Descargar» grabs the normal flow: library=true, no destination, no quality-derived route', async () => {
    const fn = mockFetch()
    await openResults({ alternativeMode: true })

    // Row 0 is the 2160p release — the one whose quality would be routed to
    // path_4k without an explicit `library: true`.
    fireEvent.click(rowDownload(releaseRows()[0]))

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    const body = grabBodies(fn)[0]
    expect(body.library).toBe(true)
    expect(body).not.toHaveProperty('destination')
    // No routing target under ANY key: not the folders, not a derived one.
    expect(JSON.stringify(body)).not.toContain('/mnt/storage-6tb/4k')
    expect(JSON.stringify(body)).not.toContain('/mnt/storage/6tb/3d')
  })

  it('fires onGrabStarted with the task_id and keeps the ack flowing', async () => {
    mockFetch()
    const onGrabStarted = vi.fn()
    await openResults({ alternativeMode: true, onGrabStarted })

    fireEvent.click(rowDownload(releaseRows()[0]))

    await waitFor(() => expect(onGrabStarted).toHaveBeenCalledTimes(1))
    expect(onGrabStarted).toHaveBeenCalledWith('grab-1')
    // The settled job still acks through the same surface as before.
    expect(await screen.findByText('Descarga iniciada')).toBeInTheDocument()
  })

  it('keeps filters, the 3D title chip and the «Búsqueda en idioma» section', async () => {
    mockFetch()
    await openResults({
      alternativeMode: true,
      languageSearch: {
        originalTitle: 'Everything Everywhere All at Once',
        alternateTitles: [{ title: 'Tout, partout, tout à la fois', language: 'fr' }],
        movieId: 411,
      },
    })

    // Filters untouched.
    expect(screen.getByPlaceholderText('Filtrar por título...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bluray-2160p' })).toBeInTheDocument()
    // The 3D chip is a TITLE flag (not a destination): it stays.
    const row = releaseRows()[0]
    expect(within(row).getByRole('button', { name: /como 3D|marca 3D/ })).toBeInTheDocument()
    // The language section (Sólo en alternativa) stays.
    expect(screen.getByText('Búsqueda en idioma')).toBeInTheDocument()
  })

  it('a failed settings read never blocks the alternative download', async () => {
    const fn = mockFetch({ routingFail: true })
    await openResults({ alternativeMode: true })

    fireEvent.click(rowDownload(releaseRows()[0]))

    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    expect(grabBodies(fn)[0].library).toBe(true)
  })
})

/* ── Pin diferencial: el modal NO-alternativa queda byte-idéntico (S3) ───── */

describe('ReleaseSearchModal differential — sin alternativeMode nada cambia (S3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('still renders the three F-12 destination buttons and the quality suggestion', async () => {
    mockFetch()
    await openResults()

    const rows = document.querySelectorAll('.release-dest')
    expect(rows).toHaveLength(2)
    // The 2160p row keeps its three destinations, 4K highlighted.
    const row4k = rows[0] as HTMLElement
    expect(within(row4k).getByRole('button', { name: /Biblioteca/ })).toBeInTheDocument()
    // The suggestion depends on the async folders read — wait the way the
    // destinations themselves do (the buttons enable when the folders land).
    await waitFor(() =>
      expect(within(row4k).getByRole('button', { name: /4K/ })).toBeEnabled(),
    )
    expect(within(row4k).getByRole('button', { name: /4K/ })).toHaveClass('suggest')
    expect(within(row4k).getByRole('button', { name: /3D/ })).toBeInTheDocument()
    // …and a plain 1080p row still suggests the library.
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: /Biblioteca/ })).toHaveClass('suggest')
  })

  it('keeps the exact grab payloads: 4K → destination path, 3D → destination + is3d, Biblioteca → library', async () => {
    const fn = mockFetch()

    // One render per grab (a grab takes the row to `grabbing`), same mock.
    const first = await openResults()
    await waitFor(() =>
      expect(
        within(document.querySelectorAll('.release-dest')[0] as HTMLElement).getByRole('button', { name: /4K/ }),
      ).toBeEnabled(),
    )
    pressDest('4K')
    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    first.unmount()

    const second = await openResults()
    await waitFor(() =>
      expect(
        within(document.querySelectorAll('.release-dest')[0] as HTMLElement).getByRole('button', { name: /3D/ }),
      ).toBeEnabled(),
    )
    pressDest('3D')
    await waitFor(() => expect(grabBodies(fn)).toHaveLength(2))
    second.unmount()

    await openResults()
    pressDest('Biblioteca')
    await waitFor(() => expect(grabBodies(fn)).toHaveLength(3))

    const [fourK, threeD, library] = grabBodies(fn)
    expect(fourK.destination).toBe('/mnt/storage-6tb/4k')
    expect(fourK).not.toHaveProperty('library')
    expect(threeD.destination).toBe('/mnt/storage/6tb/3d')
    expect(threeD.is3d).toBe(true)
    expect(threeD).not.toHaveProperty('library')
    expect(library).not.toHaveProperty('destination')
    expect(library.library).toBe(true)
    expect(library.quality).toBe('Bluray-2160p')
  })

  it('the alternative «Descargar» body is byte-identical to the classic «→ Biblioteca» body', async () => {
    const fn = mockFetch()

    // Classic grab on the 2160p row…
    const classicView = await openResults()
    pressDest('Biblioteca')
    await waitFor(() => expect(grabBodies(fn)).toHaveLength(1))
    const classic = grabBodies(fn)[0]
    classicView.unmount()

    // …then the very same release through the alternative flow.
    await openResults({ alternativeMode: true })
    fireEvent.click(rowDownload(releaseRows()[0]))
    await waitFor(() => expect(grabBodies(fn)).toHaveLength(2))

    expect(grabBodies(fn)[1]).toEqual(classic)
    expect(classic.library).toBe(true)
    expect(classic).not.toHaveProperty('destination')
  })
})

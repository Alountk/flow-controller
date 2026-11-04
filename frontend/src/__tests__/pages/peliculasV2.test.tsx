import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'

/**
 * Películas V2 («peliculas-v2-pulido»): the design's L2 list — chips with the
 * catalogue's counts, a search that asks the server, a real pager, rows that
 * select, a chevron that opens the detail and a ✕ that comes back to exactly
 * the list you left. The shipped V1 (`layout` default) keeps its tabs and its
 * side panel; those pins live in `calidadView.test.tsx` and here.
 */

type Movie = {
  id: number
  title: string
  year: number | null
  remotePoster: string
  has_file: boolean
  path: string
  path_exists: boolean
  monitored: boolean
  quality: string
  class: string
  /** What the backend proved the disk holds (S1): the class plus the copies. */
  libraries: string[]
  grabbed_at: number | null
  grabbed_destination: string | null
  file_name?: string
}

function makeMovie(over: Partial<Movie> & { id: number; title: string }): Movie {
  return {
    year: 2012,
    remotePoster: '',
    has_file: true,
    path: `/movies/${over.title}`,
    path_exists: true,
    monitored: true,
    quality: 'Bluray-1080p',
    class: '1080',
    libraries: ['1080p'],
    file_name: `${over.title}.mkv`,
    grabbed_at: null,
    grabbed_destination: null,
    ...over,
  }
}

const paraNorman = makeMovie({ id: 7, title: 'ParaNorman' })
const dune = makeMovie({
  id: 9,
  title: 'Dune: Parte Dos',
  year: 2024,
  quality: 'Bluray-2160p',
  class: '4K',
  libraries: ['4K'],
  path: '/movies/Dune Parte Dos (2024)',
})
const missing = makeMovie({
  id: 11,
  title: 'Sin Copia',
  year: 1999,
  quality: '',
  class: 'sin archivo',
  libraries: [],
  has_file: false,
})

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

function countsOf(items: Movie[]): Record<string, number> {
  const counts: Record<string, number> = {
    todos: items.length,
    'sin archivo': 0,
    '4K': 0,
    '3D': 0,
    '1080': 0,
    otros: 0,
  }
  for (const item of items) counts[item.class] += 1
  return counts
}

/** The backend, as this component uses it: a page of the catalogue, the chips'
 *  counts over all of it, and the routing folders. `total` can lie on purpose —
 *  a catalogue bigger than one page is what the pager needs. */
function stubFetch(items: Movie[] = [paraNorman], total = items.length) {
  const calls: string[] = []
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/api/wanted/all')) {
      return ok({ items, total, page: 1, page_size: 50, counts: countsOf(items) })
    }
    if (url.includes('/api/mixer/quality/below')) {
      return ok({ threshold: { min_class: '1080p', min_width: 0 }, items: [], analyzed: 0, unanalyzed: 0 })
    }
    if (url.includes('/api/settings')) {
      return ok({ paths: { path_4k: '/movies/4k', path_3d: '/movies/3d' } })
    }
    if (url.includes('/api/mixer/probe-library/status')) {
      return ok({ running: false, total: 10, analyzed: 6, skipped: 4, failed: 0, started_at: 1, finished_at: 2 })
    }
    if (url.includes('/api/mixer/probe-library')) {
      return ok({ started: true, total: 10 })
    }
    if (url.includes('/api/files/browse')) {
      return ok({ ok: true, path: '/movies/ParaNorman', items: [] })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', mock)
  return { calls, mock }
}

const wantedCalls = (calls: string[]) => calls.filter((url) => url.includes('/api/wanted/all'))
const lastWanted = (calls: string[]) => wantedCalls(calls).at(-1) ?? ''

/** The list's row for `title`: the detail repeats titles, so every lookup is
 *  scoped to the list the V2 draws. */
async function rowOf(title: string): Promise<HTMLElement> {
  await screen.findByText(title)
  const list = document.querySelector('.sec-movie-list')
  const rows = [...(list?.querySelectorAll('.sec-movie-row') ?? [])] as HTMLElement[]
  const row = rows.find((candidate) => candidate.textContent?.includes(title))
  expect(row, `row for ${title}`).not.toBeUndefined()
  return row as HTMLElement
}

function renderV2() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Peliculas layout="page" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.location.hash = ''
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('V2 · la cabecera del diseño L2', () => {
  it('states the title and the catalogue counts, not the page count (S5)', async () => {
    stubFetch([paraNorman, dune, missing])
    renderV2()

    const head = (await screen.findByRole('heading', { name: 'Películas' })).closest(
      '.sec-l2-head',
    ) as HTMLElement
    await waitFor(() => expect(head).toHaveTextContent('3 películas · 1 sin archivo'))
  })

  it('draws the design chips with their counts, honouring the missing files (S2)', async () => {
    stubFetch([paraNorman, dune, missing])
    renderV2()
    await rowOf('ParaNorman')

    const chips = within(screen.getByRole('group', { name: 'Filtrar por clase' }))
    expect(chips.getByRole('button', { name: /^Todas/ })).toHaveTextContent('3')
    expect(chips.getByRole('button', { name: /^Sin archivo/ })).toHaveTextContent('1')
    expect(chips.getByRole('button', { name: /^4K/ })).toHaveTextContent('1')
    expect(chips.getByRole('button', { name: /^3D/ })).toHaveTextContent('0')
    expect(chips.getByRole('button', { name: /^1080/ })).toHaveTextContent('1')
    expect(chips.getByRole('button', { name: /^Otros/ })).toHaveTextContent('0')
  })

  it('asks the server for a class and comes back to page 1 (S2, S3)', async () => {
    const { calls } = stubFetch([paraNorman, dune], 60)
    renderV2()
    await rowOf('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    await waitFor(() => expect(lastWanted(calls)).toContain('page=2'))

    fireEvent.click(screen.getByRole('button', { name: /^4K/ }))

    await waitFor(() => expect(lastWanted(calls)).toContain('class=4K'))
    expect(lastWanted(calls)).toContain('page=1')
  })

  it('filters by name on the server, debounced and back on page 1 (S3)', async () => {
    const { calls } = stubFetch([paraNorman, dune], 60)
    renderV2()
    await rowOf('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    await waitFor(() => expect(lastWanted(calls)).toContain('page=2'))

    fireEvent.change(screen.getByLabelText('Buscar película'), { target: { value: 'dune' } })

    await waitFor(() => expect(lastWanted(calls)).toContain('q=dune'), { timeout: 2000 })
    expect(lastWanted(calls)).toContain('page=1')
  })

  it('says honestly that nothing matches the active filter', async () => {
    stubFetch([], 0)
    renderV2()

    expect(await screen.findByText(/No hay películas en el catálogo/)).toBeInTheDocument()
  })

  it('puts the cursor in the search box with Ctrl+K (S5)', async () => {
    renderV2()
    await rowOf('ParaNorman')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    expect(screen.getByLabelText('Buscar película')).toHaveFocus()
  })

  it('refetches from Actualizar, saying it is busy (S5)', async () => {
    const { calls, mock } = stubFetch()
    renderV2()
    await rowOf('ParaNorman')
    expect(wantedCalls(calls)).toHaveLength(1)
    // QualityBelowList has its own Actualizar: the header's is the one under
    // test, so every lookup is scoped to the header.
    const head = document.querySelector('.sec-l2-head') as HTMLElement

    // Hold the refresh in flight: a request that settles instantly would hide
    // the only evidence the operator has that the click did anything.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = mock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/wanted/all')) await gate
        return inner(input)
      }),
    )

    fireEvent.click(within(head).getByRole('button', { name: /^Actualizar/ }))

    expect(await within(head).findByRole('button', { name: /Actualizando/ })).toBeDisabled()
    release()
    expect(await within(head).findByRole('button', { name: /^Actualizar/ })).toBeEnabled()
    expect(wantedCalls(calls)).toHaveLength(2)
  })
})

describe('V2 · la fila selecciona y el chevron abre', () => {
  it('selects on click and does NOT open the detail (S4)', async () => {
    renderV2()

    const row = await rowOf('ParaNorman')
    fireEvent.click(row)

    expect(row).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('region', { name: 'Panel de detalle' })).toBeNull()
  })

  it('walks the list with the arrows and opens with Enter (S7)', async () => {
    stubFetch([paraNorman, dune])
    renderV2()
    const first = await rowOf('ParaNorman')

    first.focus()
    // Nothing selected yet: the first ↑↓ lands on the first row, the next one
    // walks from there.
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(await rowOf('ParaNorman')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(await rowOf('Dune: Parte Dos')).toHaveAttribute('aria-current', 'true')

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })

    expect(await screen.findByRole('region', { name: 'Panel de detalle' })).toHaveTextContent(
      'Dune: Parte Dos',
    )
  })

  it('selects with Espacio, without navigating (S4, S7)', async () => {
    renderV2()
    const row = await rowOf('ParaNorman')

    fireEvent.keyDown(row, { key: ' ' })

    expect(row).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('region', { name: 'Panel de detalle' })).toBeNull()
  })

  it('opens the detail from the chevron and comes back keeping the selection (S4)', async () => {
    renderV2()

    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ParaNorman' }))
    const panel = await screen.findByRole('region', { name: 'Panel de detalle' })
    expect(within(panel).getByRole('button', { name: 'Cerrar detalle' })).toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: 'Cerrar detalle' }))

    expect(await rowOf('ParaNorman')).toHaveAttribute('aria-current', 'true')
  })

  it('marks the selected row with the design label and its class badge (S6)', async () => {
    stubFetch([paraNorman, dune])
    renderV2()

    const row = await rowOf('Dune: Parte Dos')
    expect(row).not.toHaveTextContent('Seleccionado')
    fireEvent.click(row)

    expect(row).toHaveTextContent('Seleccionado')
    expect(within(row).getByText('4K')).toBeInTheDocument()
  })

  it('lights every resolution the disk proves, copies included (S1)', async () => {
    // The bug this fixes: the movie's own path can only be in ONE root, so a
    // 1080 copy plus a 4K remux and a 3D rip used to light a single chip.
    const alien = makeMovie({
      id: 21,
      title: 'Alien',
      year: 1979,
      libraries: ['4K', '3D', '1080p'],
    })
    stubFetch([alien])
    renderV2()

    const row = await rowOf('Alien')
    const lit = [...row.querySelectorAll('.sec-res-chip')]
      .filter((chip) => chip.classList.contains('is-on'))
      .map((chip) => chip.textContent)

    expect(lit).toEqual(['4K', '3D', '1080p'])
  })

  it('always names the four resolutions and lights the ones the file has (S6)', async () => {
    stubFetch([paraNorman, dune, missing])
    renderV2()

    const lit = (row: HTMLElement) =>
      [...row.querySelectorAll('.sec-res-chip')]
        .filter((chip) => chip.classList.contains('is-on'))
        .map((chip) => chip.textContent)

    // A 1080p file: every chip is drawn, exactly one is lit.
    const bluray = await rowOf('ParaNorman')
    expect([...bluray.querySelectorAll('.sec-res-chip')].map((c) => c.textContent)).toEqual([
      '4K',
      '3D',
      '1080p',
      'SD',
    ])
    expect(lit(bluray)).toEqual(['1080p'])

    // A 4K remux lights 4K — and nothing else.
    expect(lit(await rowOf('Dune: Parte Dos'))).toEqual(['4K'])

    // No file, no resolution: the four chips stay, dimmed, with the amber pill.
    const gone = await rowOf('Sin Copia')
    expect(lit(gone)).toEqual([])
    expect(gone).toHaveTextContent('Sin archivo')
  })

  it('serves the selection from the quick actions (S5)', async () => {
    renderV2()
    fireEvent.click(await rowOf('ParaNorman'))

    fireEvent.click(await screen.findByRole('button', { name: 'Acciones rápidas' }))
    const menu = await screen.findByRole('menu', { name: 'Acciones rápidas' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Ver detalle' }))

    expect(await screen.findByRole('region', { name: 'Panel de detalle' })).toBeInTheDocument()
  })

  it('opens the quick actions with no row selected and carries the library analysis (S2/S4)', async () => {
    renderV2()
    const trigger = await screen.findByRole('button', { name: 'Acciones rápidas' })
    expect(trigger).toBeEnabled()

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Acciones rápidas' })

    // Row actions need a row. The library's own action does not.
    expect(within(menu).queryByRole('menuitem', { name: 'Ver detalle' })).toBeNull()
    expect(within(menu).getByRole('button', { name: 'Analizar biblioteca' })).toBeInTheDocument()
  })

  it('starts the sweep from the menu and reports it there (S5)', async () => {
    const { calls } = stubFetch()
    renderV2()
    fireEvent.click(await screen.findByRole('button', { name: 'Acciones rápidas' }))
    const menu = await screen.findByRole('menu', { name: 'Acciones rápidas' })

    fireEvent.click(within(menu).getByRole('button', { name: 'Analizar biblioteca' }))

    await waitFor(() =>
      expect(calls.some((url) => url.includes('/api/mixer/probe-library'))).toBe(true),
    )
    expect(
      await within(menu).findByText(/analizados/),
    ).toBeInTheDocument()
  })
})

describe('V2 · el detalle tiene sus propias acciones (S1)', () => {
  it('offers exactly the movie actions: releases and folder scan', async () => {
    renderV2()
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ParaNorman' }))
    const panel = await screen.findByRole('region', { name: 'Panel de detalle' })

    // The list owns the library's actions and the list is hidden while the
    // detail is open (S8), so the detail needs its own trigger.
    fireEvent.click(within(panel).getByRole('button', { name: 'Acciones rápidas' }))
    const menu = await within(panel).findByRole('menu', { name: 'Acciones rápidas' })

    expect(within(menu).getByRole('menuitem', { name: 'Buscar releases' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Escanear carpeta' })).toBeInTheDocument()
    // «Ver detalle» is where you already are; the sweep is the list's (S4).
    expect(within(menu).queryByRole('menuitem', { name: 'Ver detalle' })).toBeNull()
    expect(within(menu).queryByRole('button', { name: 'Analizar biblioteca' })).toBeNull()
  })

  it('«Buscar releases» lands on the Releases tab, where the search already lives', async () => {
    renderV2()
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ParaNorman' }))
    const panel = await screen.findByRole('region', { name: 'Panel de detalle' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Archivos' }))

    fireEvent.click(within(panel).getByRole('button', { name: 'Acciones rápidas' }))
    const menu = await within(panel).findByRole('menu', { name: 'Acciones rápidas' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Buscar releases' }))

    expect(within(panel).getByRole('button', { name: 'Releases' })).toHaveClass('is-active')
  })

  it("the Releases tab carries the file's own facts, so its tags light up", async () => {
    // El panel de V2 construía su propio ítem de release sin `quality`,
    // `resolution` ni `file_name`: los cuatro chips salían apagados sobre una
    // película que sí está descargada, y el nombre del fichero, ausente.
    stubFetch([paraNorman])
    renderV2()
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ParaNorman' }))
    const panel = await screen.findByRole('region', { name: 'Panel de detalle' })

    fireEvent.click(within(panel).getByRole('button', { name: 'Acciones rápidas' }))
    const menu = await within(panel).findByRole('menu', { name: 'Acciones rápidas' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Buscar releases' }))

    const block = await within(panel).findByText('Fichero descargado')
    const tags = document.querySelectorAll('.has-file-tag')
    const lit = [...tags].filter((tag) => tag.classList.contains('is-on')).map((t) => t.textContent)
    expect(lit).toEqual(['1080'])
    expect(block.parentElement?.textContent).toContain('ParaNorman.mkv')
  })
})

describe('V2 · el detalle delega lo que es de la biblioteca', () => {
  it('shows the roots as cards in its Archivos tab, and no sweep (S3/S4)', async () => {
    renderV2()
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ParaNorman' }))
    const panel = await screen.findByRole('region', { name: 'Panel de detalle' })

    const tab = within(panel).getByRole('button', { name: 'Archivos' })
    fireEvent.click(tab)
    expect(tab).toHaveClass('is-active')

    // The V2 list keeps its rows under its own query key: the panel has to find
    // the selected row THERE, or it renders "row unreadable" with nothing to show.
    expect(within(panel).queryByText('No se pudo leer la fila seleccionada.')).toBeNull()
    const card = await within(panel).findByRole('region', { name: 'Archivos 1080' })
    expect(card).toHaveClass('sec-file-card')
    expect(within(card).getByText('/movies/ParaNorman', { selector: 'code' })).toBeInTheDocument()

    // The sweep is a library action: it lives in the list's menu, not here.
    expect(within(panel).queryByRole('button', { name: 'Analizar biblioteca' })).toBeNull()
  })
})

describe('V2 · el pie y la vuelta', () => {
  it('reports what is shown and pages with the design pager (S7)', async () => {
    const { calls } = stubFetch([paraNorman, dune], 60)
    renderV2()
    await rowOf('ParaNorman')

    expect(screen.getByText('Mostrando 2 de 60')).toBeInTheDocument()
    expect(screen.getByText('Pág 1 de 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))

    await waitFor(() => expect(lastWanted(calls)).toContain('page=2'))
    expect(screen.getByRole('button', { name: 'Página siguiente' })).toBeDisabled()
  })

  it('hides the list while the detail is open and gives it back untouched (S8)', async () => {
    stubFetch([paraNorman, dune])
    renderV2()
    await rowOf('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: /^4K/ }))
    fireEvent.change(screen.getByLabelText('Buscar película'), { target: { value: 'dune' } })
    await waitFor(() => expect(screen.getByLabelText('Buscar película')).toHaveValue('dune'))

    fireEvent.click(await screen.findByRole('button', { name: 'Abrir Dune: Parte Dos' }))
    await screen.findByRole('region', { name: 'Panel de detalle' })
    // Hidden, never unmounted: the way back has to find it as it was.
    expect(screen.getByText('ParaNorman')).not.toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalle' }))

    expect(await screen.findByLabelText('Buscar película')).toHaveValue('dune')
    expect(screen.getByRole('button', { name: /^4K/ })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('V2 · lo que no cambia', () => {
  it('still has no sub-view tabs and no side panel (S1, S2 del detalle)', async () => {
    renderV2()

    await screen.findByText('ParaNorman')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Panel de detalle' })).toBeNull()
  })

  it('leaves the V1 with its tabs and its side panel (S9)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <Peliculas />
      </QueryClientProvider>,
    )

    const tabs = await screen.findAllByRole('tab')
    expect(tabs.length).toBeGreaterThanOrEqual(3)
    expect(screen.getByRole('region', { name: 'Panel de detalle' })).toBeInTheDocument()
  })
})

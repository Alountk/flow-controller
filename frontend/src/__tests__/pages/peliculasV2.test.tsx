import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Peliculas } from '../../pages/Peliculas.tsx'

/**
 * V2 («detalle-pantalla» S1/S2/S3/S4): the same page with the detail as a
 * FULL-PAGE view — no sub-view tabs, the list owns the screen, a row opens the
 * detail and the ✕ comes back. The shipped V1 (`layout` default) keeps its
 * side panel and its tabs; these tests pin only the V2 shape.
 */

const movie = {
  id: 7,
  title: 'ParaNorman',
  year: 2012,
  remotePoster: '',
  has_file: true,
  path: '/movies/ParaNorman (2012)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-1080p',
  grabbed_at: null,
  grabbed_destination: null,
}

const dune = {
  id: 9,
  title: 'Dune: Parte Dos',
  year: 2024,
  remotePoster: '',
  has_file: false,
  path: '/movies/Dune Parte Dos (2024)',
  path_exists: false,
  monitored: true,
  quality: '',
  grabbed_at: null,
  grabbed_destination: null,
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

function stubFetch(movies: unknown[] = [movie]) {
  const calls: string[] = []
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/api/wanted/all')) {
      return ok({ items: movies, total: movies.length, page: 1, page_size: 0 })
    }
    if (url.includes('/api/mixer/quality/below')) {
      return ok({
        threshold: { min_class: '1080p', min_width: 0 },
        items: [],
        analyzed: 0,
        unanalyzed: 0,
      })
    }
    if (url.includes('/api/settings')) return ok({ paths: { path_4k: '', path_3d: '' } })
    return ok({})
  })
  vi.stubGlobal('fetch', mock)
  return { calls, mock }
}

/** The list's row for `title`: the detail panel repeats titles, so every
 *  lookup is scoped to the list the V2 draws. */
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

describe('V2 · el detalle sustituye la vista', () => {
  it('shows no sub-view tabs — Biblioteca / Estrenos / Calidad are gone (S2)', async () => {
    renderV2()

    await screen.findByText('ParaNorman')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('opens the detail from the row arrow, replacing the list (S3)', async () => {
    renderV2()

    await screen.findByText('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ParaNorman' }))

    const panel = await screen.findByRole('region', { name: 'Panel de detalle' })
    expect(within(panel).getByRole('button', { name: 'Cerrar detalle' })).toBeInTheDocument()
    // The list is gone: the detail took the screen.
    expect(document.querySelector('.sec-movie-list')).toBeNull()
  })

  it('comes back to the list with the ✕ (S4)', async () => {
    renderV2()

    await screen.findByText('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ParaNorman' }))
    await screen.findByRole('region', { name: 'Panel de detalle' })

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalle' }))

    expect(await screen.findByText('ParaNorman')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Panel de detalle' })).toBeNull()
  })

  it('selects the row on click and does NOT open the detail (S3 correction)', async () => {
    renderV2()

    const row = await rowOf('ParaNorman')
    fireEvent.click(row)

    // The row is marked and nothing navigates: the detail is the arrow's job.
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(document.querySelector('.sec-movie-list')).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Panel de detalle' })).toBeNull()
  })

  it('keeps the selection when the ✕ brings the list back (S4 + S3)', async () => {
    renderV2()

    await rowOf('ParaNorman')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ParaNorman' }))
    await screen.findByRole('region', { name: 'Panel de detalle' })

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalle' }))

    // Coming back is not a deselection: the row is still the chosen one.
    expect(await rowOf('ParaNorman')).toHaveAttribute('aria-current', 'true')
  })

  it('keeps V1 untouched: the default layout still has its tabs and side panel', async () => {
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

describe('V2 · la cabecera del diseño L2', () => {
  it('states the title and the catalogue counts (L2 header)', async () => {
    stubFetch([movie, dune])
    renderV2()

    const head = await screen.findByRole('heading', { name: 'Películas' })
    const block = head.closest('.sec-l2-head') as HTMLElement
    expect(block).not.toBeNull()
    expect(block).toHaveTextContent('2 películas · 1 sin archivo')
  })

  it('filters the list by name from its own search box', async () => {
    stubFetch([movie, dune])
    renderV2()
    await rowOf('Dune: Parte Dos')

    fireEvent.change(screen.getByLabelText('Buscar película'), { target: { value: 'dune' } })

    const rows = [...document.querySelectorAll('.sec-movie-row')].map((r) => r.textContent)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('Dune: Parte Dos')
  })

  it('puts the cursor in the search box with Ctrl+K', async () => {
    renderV2()
    await rowOf('ParaNorman')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    expect(screen.getByLabelText('Buscar película')).toHaveFocus()
  })

  it('refetches the catalogue from the Actualizar button, saying it is busy', async () => {
    const { calls, mock } = stubFetch()
    renderV2()
    await rowOf('ParaNorman')
    const wanted = () => calls.filter((url) => url.includes('/api/wanted/all')).length
    expect(wanted()).toBe(1)

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

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))

    expect(await screen.findByRole('button', { name: 'Actualizando…' })).toBeDisabled()
    release()
    expect(await screen.findByRole('button', { name: 'Actualizar' })).toBeEnabled()
    expect(wanted()).toBe(2)
  })

  it('enables the quick actions only once a row is selected, and opens the detail', async () => {
    renderV2()
    const trigger = await screen.findByRole('button', { name: 'Acciones rápidas' })
    // Nothing is selected: there is nothing for the menu to act on.
    expect(trigger).toBeDisabled()
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(await rowOf('ParaNorman'))

    expect(trigger).toBeEnabled()
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Acciones rápidas' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Ver detalle' }))

    expect(await screen.findByRole('region', { name: 'Panel de detalle' })).toBeInTheDocument()
  })
})

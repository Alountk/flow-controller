import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AlternativeModal,
  type AlternativeModalProps,
} from '../../../features/alternative/AlternativeModal.tsx'
import { searchIndexers } from '../../../shared/api/indexers.ts'

/**
 * «Buscar y descargar alternativa» sobre NUESTROS indexadores
 * («alternativa-indexadores» T3, specs S1-S4/S7/S8 + decisiones L6a-L6d):
 * el modal de alternativa deja de ser la lista de releases de Radarr y pasa a
 * checklist de indexadores → título precargado editable → resultados →
 * descargar, con «Búsqueda en idioma» (Prowlarr) conservado dentro.
 *
 * Contratos anclados aquí:
 * - S1: checklist desde `GET /api/indexers`; las filas `enabled` salen
 *   MARCADAS por defecto (L6a), las deshabilitadas visibles pero nunca
 *   marcables ni buscables, «aMule (EC)» marcado por defecto, y Prowlarr
 *   JAMÁS en el checklist (L6b).
 * - S2: el input de título sale precargado con el título del lookup y siempre
 *   editable.
 * - S3: sin auto-búsqueda al abrir (L6c) — botón «Buscar» explícito,
 *   deshabilitado con título vacío o sin fuentes, con GUARDA en el handler
 *   (jsdom `fireEvent.click` dispara botones deshabilitados); el body lleva
 *   `sources` + `indexer_ids` de las filas Torznab marcadas, sin `prowlarr`
 *   jamás; los resultados muestran nombre/tamaño/semillas/fuentes (aMule
 *   NUNCA etiquetado como semillas) y toda `skipped` con su motivo; y el body
 *   legacy sin tercer argumento sigue siendo byte-idéntico (llamantes de
 *   Settings intactos).
 * - S4: «Descargar» por fila → `downloadIndexer({ link ?? guid })` con el
 *   `detail` devuelto visible (aceptación Y rechazo) y guarda de doble clic.
 * - S7: «Búsqueda en idioma» montado con el contexto del lookup.
 * - S8: `audioLanguages` como chips informativos.
 * - S6: `movieId` 0 abre sin gate de biblioteca.
 *
 * RTL + fireEvent only — `@testing-library/user-event` is NOT installed.
 */

type MockFn = ReturnType<typeof vi.fn>

type RouteHandler = (body: Record<string, unknown> | null) => unknown

function mockFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const handler = routes[`${method} ${url}`]
    if (!handler) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    return Promise.resolve({ ok: true, status: 200, json: async () => handler(body) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function posts(fn: MockFn, url: string) {
  return fn.mock.calls.filter(
    ([input, init]) => String(input) === url && (init?.method ?? 'GET') === 'POST',
  )
}

function searchPosts(fn: MockFn) {
  return posts(fn, '/api/indexers/search')
}

function downloadPosts(fn: MockFn) {
  return posts(fn, '/api/indexers/download')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const ROWS = {
  indexers: [
    { id: 7, name: 'NoNaMe', url: 'https://noname.local', api_key: '****abcd', categories: '2000', enabled: 1 },
    { id: 9, name: 'Rutor', url: 'https://rutor.local', api_key: '****efgh', categories: '2000', enabled: 0 },
    { id: 12, name: 'Zamunda', url: 'https://zamunda.local', api_key: '****ijkl', categories: '2000', enabled: 1 },
  ],
}

const HAPPY = {
  ok: true,
  results: [
    {
      source: 'torznab',
      indexer: 'NoNaMe',
      name: 'Matrix 1999 1080p',
      size: 10 * 1024 * 1024,
      seeders: 5,
      link: 'magnet:?xt=urn:btih:abc123',
      guid: 'g-1',
    },
    { source: 'torznab', indexer: 'Zamunda', name: 'Matrix Reloaded 2003', size: 1000, guid: 'g-2' },
    {
      source: 'amule',
      name: 'Matrix Revolutions',
      size: 3000,
      sources: 4,
      link: 'ed2k://|file|MatrixRevolutions|3000|BBBB|/',
      guid: 'a'.repeat(32),
    },
  ],
  skipped: [],
}

const DEFAULT_PROPS: AlternativeModalProps = {
  title: 'Matrix 1999',
  originalTitle: 'The Matrix',
  alternateTitles: [{ title: 'Матрица', language: 'ru' }],
  movieId: 42,
  audioLanguages: ['spa', 'eng'],
  onClose: () => {},
}

function renderModal(overrides: Partial<AlternativeModalProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props: AlternativeModalProps = { ...DEFAULT_PROPS, ...overrides }
  return render(
    <QueryClientProvider client={client}>
      <AlternativeModal {...props} />
    </QueryClientProvider>,
  )
}

async function clickSearch() {
  fireEvent.click(await screen.findByRole('button', { name: 'Buscar' }))
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('.alt-modal-result-row') as HTMLElement
}

describe('AlternativeModal — checklist de indexadores → título → resultados → descargar', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('S1: enabled rows are visible AND checked by default; disabled rows visible but uncheckable; aMule (EC) checked', async () => {
    mockFetch({ 'GET /api/indexers': () => ROWS })
    renderModal()

    expect(await screen.findByRole('checkbox', { name: 'Buscar en NoNaMe' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Buscar en Zamunda' })).toBeChecked()
    const rutor = screen.getByRole('checkbox', { name: 'Buscar en Rutor' })
    expect(rutor).toBeInTheDocument()
    expect(rutor).toBeDisabled()
    expect(rutor).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Buscar en aMule (EC)' })).toBeChecked()
  })

  it('S1/L6b: Prowlarr never appears in the checklist', async () => {
    mockFetch({ 'GET /api/indexers': () => ROWS })
    const { container } = renderModal()

    await screen.findByRole('checkbox', { name: 'Buscar en aMule (EC)' })
    const checklist = container.querySelector('.alt-modal-sources') as HTMLElement
    expect(within(checklist).queryByRole('checkbox', { name: /prowlarr/i })).toBeNull()
    expect(within(checklist).queryByText(/prowlarr/i)).toBeNull()
  })

  it('S2: every source-row label links its checkbox with htmlFor/id/name', async () => {
    mockFetch({ 'GET /api/indexers': () => ROWS })
    renderModal()

    const expected: Array<[string, string]> = [
      ['Buscar en NoNaMe', 'alt-modal-source-7'],
      ['Buscar en Rutor', 'alt-modal-source-9'],
      ['Buscar en Zamunda', 'alt-modal-source-12'],
      ['Buscar en aMule (EC)', 'alt-modal-source-amule'],
    ]
    for (const [rowName, id] of expected) {
      const input = (await screen.findByRole('checkbox', { name: rowName })) as HTMLInputElement
      expect(input.id, rowName).toBe(id)
      expect(input.name, rowName).toBe(id)
      const label = input.closest('label')
      expect(label, rowName).not.toBeNull()
      expect(label!.getAttribute('for'), rowName).toBe(id)
    }
  })

  it('S2: the title input is prefilled from the prop and stays editable', async () => {
    mockFetch({ 'GET /api/indexers': () => ROWS })
    renderModal()

    const input = await screen.findByLabelText('Título a buscar')
    expect(input).toHaveValue('Matrix 1999')
    fireEvent.change(input, { target: { value: 'The Matrix 1999 Remaster' } })
    expect(input).toHaveValue('The Matrix 1999 Remaster')
  })

  it('S3: searches the edited title over the checked sources, sending the checked Torznab ids', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => ({ ok: true, results: [], skipped: [] }),
    })
    renderModal()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Buscar en Zamunda' }))
    fireEvent.change(await screen.findByLabelText('Título a buscar'), {
      target: { value: 'Matrix Recargado' },
    })
    await clickSearch()

    await waitFor(() => expect(searchPosts(fn)).toHaveLength(1))
    expect(JSON.parse(String(searchPosts(fn)[0][1]?.body))).toEqual({
      query: 'Matrix Recargado',
      sources: ['torznab', 'amule'],
      indexer_ids: [7],
    })
  })

  it('S3: aMule-only selection sends no indexer_ids and never a prowlarr source', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => ({ ok: true, results: [], skipped: [] }),
    })
    renderModal()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Buscar en NoNaMe' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Buscar en Zamunda' }))
    await clickSearch()

    await waitFor(() => expect(searchPosts(fn)).toHaveLength(1))
    const body = JSON.parse(String(searchPosts(fn)[0][1]?.body))
    expect(body).toEqual({ query: 'Matrix 1999', sources: ['amule'] })
    expect(body).not.toHaveProperty('indexer_ids')
  })

  it('S3: the legacy two-argument search body stays byte-identical for Settings callers', async () => {
    const fn = mockFetch({
      'POST /api/indexers/search': () => ({ ok: true, results: [], skipped: [] }),
    })

    await searchIndexers('matrix', ['torznab', 'amule', 'prowlarr'])

    const post = searchPosts(fn)[0]
    expect(String(post?.[1]?.body)).toBe(
      JSON.stringify({ query: 'matrix', sources: ['torznab', 'amule', 'prowlarr'] }),
    )
  })

  it('S3/L6c: never searches on open; «Buscar» is disabled with a blank title or zero sources, and the handler guards too', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => ({ ok: true, results: [], skipped: [] }),
    })
    renderModal()

    const buscar = await screen.findByRole('button', { name: 'Buscar' })
    // L6c: opening the modal is not a search.
    expect(searchPosts(fn)).toHaveLength(0)

    // Blank title → disabled, and a jsdom click on it must not search.
    fireEvent.change(screen.getByLabelText('Título a buscar'), { target: { value: '   ' } })
    expect(buscar).toBeDisabled()
    fireEvent.click(buscar)
    expect(searchPosts(fn)).toHaveLength(0)

    // Title back, zero sources → disabled, and the handler guards again.
    fireEvent.change(screen.getByLabelText('Título a buscar'), { target: { value: 'Matrix' } })
    for (const name of ['Buscar en NoNaMe', 'Buscar en Zamunda', 'Buscar en aMule (EC)']) {
      fireEvent.click(screen.getByRole('checkbox', { name }))
    }
    expect(buscar).toBeDisabled()
    fireEvent.click(buscar)
    expect(searchPosts(fn)).toHaveLength(0)
  })

  it('S3: renders every result row with name, formatted size, seeders when present, and aMule sources never labelled seeders', async () => {
    mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => HAPPY,
    })
    renderModal()
    await clickSearch()

    await screen.findByText('Matrix 1999 1080p')
    const torznabRow = rowOf('Matrix 1999 1080p')
    expect(within(torznabRow).getByText('10 MB')).toBeInTheDocument()
    expect(within(torznabRow).getByText('S: 5')).toBeInTheDocument()

    const guidRow = rowOf('Matrix Reloaded 2003')
    expect(within(guidRow).getByText('1000 B')).toBeInTheDocument()
    expect(within(guidRow).queryByText(/^S:/)).toBeNull()

    const amuleRow = rowOf('Matrix Revolutions')
    expect(within(amuleRow).getByText('fuentes: 4')).toBeInTheDocument()
    expect(within(amuleRow).queryByText(/seeders|semillas/i)).toBeNull()
    expect(within(amuleRow).queryByText(/^S:/)).toBeNull()
  })

  it('S3: renders every skipped entry with its reason (honesty per source)', async () => {
    mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => ({
        ok: true,
        results: [],
        skipped: [
          { source: 'torznab', reason: 'NoNaMe borrado en caliente' },
          { source: 'amule', reason: 'aMule no responde' },
        ],
      }),
    })
    renderModal()
    await clickSearch()

    expect(await screen.findByText('torznab: NoNaMe borrado en caliente')).toBeInTheDocument()
    expect(screen.getByText('amule: aMule no responde')).toBeInTheDocument()
  })

  it('S4: downloads a row with its link when it has one and with its guid otherwise', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => HAPPY,
      'POST /api/indexers/download': () => ({ ok: true, detail: 'Añadido a aMuTorrent' }),
    })
    renderModal()
    await clickSearch()

    await screen.findByText('Matrix 1999 1080p')
    fireEvent.click(
      within(rowOf('Matrix 1999 1080p')).getByRole('button', { name: 'Descargar' }),
    )
    await waitFor(() => expect(downloadPosts(fn)).toHaveLength(1))
    // link ?? guid: the row has BOTH, so only the link travels.
    expect(JSON.parse(String(downloadPosts(fn)[0][1]?.body))).toEqual({
      link: 'magnet:?xt=urn:btih:abc123',
    })

    fireEvent.click(
      within(rowOf('Matrix Reloaded 2003')).getByRole('button', { name: 'Descargar' }),
    )
    await waitFor(() => expect(downloadPosts(fn)).toHaveLength(2))
    expect(JSON.parse(String(downloadPosts(fn)[1][1]?.body))).toEqual({ guid: 'g-2' })
  })

  it('S4: renders the returned detail for an accepted download AND for a refusal', async () => {
    mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => HAPPY,
      'POST /api/indexers/download': (body) =>
        body?.link
          ? { ok: true, detail: 'Añadido a aMuTorrent (categoría flow)' }
          : { ok: false, detail: 'aMule no aceptó el hash' },
    })
    renderModal()
    await clickSearch()

    await screen.findByText('Matrix 1999 1080p')
    fireEvent.click(
      within(rowOf('Matrix 1999 1080p')).getByRole('button', { name: 'Descargar' }),
    )
    fireEvent.click(
      within(rowOf('Matrix Reloaded 2003')).getByRole('button', { name: 'Descargar' }),
    )

    expect(await screen.findByText('Añadido a aMuTorrent (categoría flow)')).toBeInTheDocument()
    expect(screen.getByText('aMule no aceptó el hash')).toBeInTheDocument()
  })

  it('S4: double-click guard — one row fires one download, and an added row never fires again', async () => {
    const gate = deferred<void>()
    const fn = mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/indexers/search': () => HAPPY,
      'POST /api/indexers/download': () =>
        gate.promise.then(() => ({ ok: true, detail: 'Añadido a aMuTorrent' })),
    })
    renderModal()
    await clickSearch()

    await screen.findByText('Matrix 1999 1080p')
    const button = within(rowOf('Matrix 1999 1080p')).getByRole('button', { name: 'Descargar' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(downloadPosts(fn)).toHaveLength(1)

    gate.resolve()
    expect(await screen.findByText('Añadido a aMuTorrent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Descargado ✓' }))
    expect(downloadPosts(fn)).toHaveLength(1)
  })

  it('S7: mounts «Búsqueda en idioma» with the lookup context (titles and movieId)', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ROWS,
      'POST /api/mixer/alternatives/language-search': () => ({ releases: [] }),
    })
    renderModal({
      originalTitle: 'Arthur et les Minimoys',
      alternateTitles: [
        { title: 'Grom', language: 'ru' },
        { title: 'Ton Nom', language: null },
      ],
      movieId: 42,
    })

    expect(screen.getByRole('heading', { name: 'Búsqueda en idioma' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'ORIGINAL: Arthur et les Minimoys' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'RU: Grom' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ton Nom' })).toBeInTheDocument()

    // The context's movieId rides the Prowlarr search — the context object is
    // really forwarded, not just its chips.
    fireEvent.change(screen.getByPlaceholderText('Título en el idioma que quieras'), {
      target: { value: 'Артур и минипуты' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))
    await waitFor(() => {
      expect(posts(fn, '/api/mixer/alternatives/language-search')).toHaveLength(1)
    })
    expect(
      JSON.parse(String(posts(fn, '/api/mixer/alternatives/language-search')[0][1]?.body)),
    ).toEqual({ query: 'Артур и минипуты', movieId: 42 })
  })

  it('S8: shows the audio languages as informational chips (not controls)', async () => {
    mockFetch({ 'GET /api/indexers': () => ROWS })
    renderModal({ audioLanguages: ['spa', 'eng'] })

    const heading = await screen.findByText('Idiomas de audio')
    const box = heading.closest('section') as HTMLElement
    expect(within(box).getByText('spa')).toBeInTheDocument()
    expect(within(box).getByText('eng')).toBeInTheDocument()
    expect(within(box).queryByRole('button')).toBeNull()
    expect(within(box).queryByRole('checkbox')).toBeNull()
  })

  it('S6: opens with movieId 0 (movie not in library) and no library gate', async () => {
    mockFetch({ 'GET /api/indexers': () => ROWS })
    renderModal({ movieId: 0 })

    expect(await screen.findByLabelText('Título a buscar')).toBeInTheDocument()
    expect(screen.queryByText(/no está en la librería/i)).toBeNull()
  })

  it('chrome: Escape and backdrop clicks close; inner clicks do not; the × button closes', async () => {
    const onClose = vi.fn()
    mockFetch({ 'GET /api/indexers': () => ROWS })
    const { container } = renderModal({ onClose })
    await screen.findByLabelText('Título a buscar')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('Título a buscar'))
    expect(onClose).toHaveBeenCalledTimes(1)

    const backdrop = container.querySelector('.alt-modal-backdrop') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

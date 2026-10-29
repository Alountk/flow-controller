import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IndexadoresSection } from '../../../features/settings/IndexadoresSection.tsx'

/**
 * «Indexadores» — the CRUD half of the section («indexadores-directos» T6/S5).
 *
 * config-1x1 T4 (S2) lleva el panel a fidelidad ESTRICTA 1:1 con
 * `odd/tasks/config-submenu/stitch-13-indexadores.html`: cabecera del panel
 * con «Importar de Prowlarr/Jackett…»/«Añadir indexador», cards apilados
 * (Búsqueda unificada → registrados → Nuevo indexador → callout), la tabla del
 * diseño y el callout literal. Estilos en `Settings.css` (sin inline styles).
 *
 * Adaptaciones documentadas (S3 — sólo por el cambio estructural, SIN aflojar):
 *  - el toggle ESTADO es `role="switch"` con aria-checked (antes button con
 *    texto «Sí»/«No»): mismo estado visible por fila, forma del diseño;
 *  - la cabecera del panel lleva el «Añadir indexador» (el del diseño) y el
 *    submit del formulario es «Guardar» (literal del diseño, sin duplicar el
 *    nombre de la cabecera), localizado dentro de la tarjeta «Nuevo
 *    indexador»: misma acción, mismo payload;
 *  - el enlace del callout conmuta a la pestaña aMule por la prop real `onOpenGeneral`
 *    (Settings → setTab('general')), no por el truco del anclaje DOM.
 *
 * What this panel has to get right, in order of how badly it fails otherwise:
 *
 * 1. the api_key renders MASKED and an empty edit field keeps the stored key —
 *    the backend contract (`routes/indexers.py` S3) and the historic bug of
 *    saving the mask back over the real credential;
 * 2. «Probar» reports the probe's own truth — caps on success, the Spanish
 *    `detail` on failure — never a silent button;
 * 3. delete asks for confirmation before anything leaves (repo pattern),
 *    because a deleted indexer silently shrinks every future search.
 *
 * config-1x1 T7 (S5) — «Fuentes integradas»: la tarjeta con aMule (EC) y
 * Prowlarr como fuentes de primer nivel (datos de `GET /api/services`,
 * presencia de configuración — jamás sondeo de red), ANTES del registro
 * Torznab. La fila aMule acciona `onOpenGeneral`; la de Prowlarr queda
 * estática (su importación es el paso 5 — sin acción inventada).
 *
 * COLISIONES — cada query se acota a su tarjeta/fila y aquí está el porqué
 * (regla: nunca aflojar el scope):
 *  - «Fuentes» suelta colisiona con «Fuentes:» (chips de la búsqueda) y con
 *    el subtítulo del panel «Fuentes Torznab directas…» → se busca el HEADING
 *    por nombre exacto «Fuentes integradas» (nivel 3) y todo lo demás se
 *    acota con `within(sourcesCard())`;
 *  - «Configurado»/«No configurado» pueden colisionar con cualquier otro
 *    texto de Settings → `within(sourceRow(...))`, jamás página completa;
 *  - «aMule (EC)» es substring del callout «la pestaña aMule (EC directo)» →
 *    texto EXACTO + scope a la tarjeta;
 *  - «Prowlarr» es substring de «Importar de Prowlarr/Jackett…» (cabecera) y
 *    del título de grupo «Resultados de Prowlarr» → texto EXACTO + scope;
 *  - el nombre accesible de la fila aMule contiene el del enlace del callout
 *    («la pestaña aMule (EC directo)») → se resuelve por ROL (button vs link)
 *    y nombre completo exacto.
 */

const LIST = [
  {
    id: 1,
    name: 'NoNaMe',
    url: 'http://indexer.test/torznab/api',
    api_key: '****9876',
    categories: '2000,100000',
    enabled: 1,
    created_at: 1700000000,
    updated_at: 1700000000,
  },
  {
    id: 2,
    name: 'Elite',
    url: 'http://elite.test/torznab/api',
    api_key: '****1234',
    categories: '',
    enabled: 0,
    created_at: 1700000000,
    updated_at: 1700000000,
  },
]

type RouteHandler = (body: Record<string, unknown> | null) => unknown

/** Dispatch on `METHOD /path` exactly the way the section calls the API. */
function mockFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`
    const handler = routes[key]
    if (!handler) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const answer = handler(body)
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve({ ok: true, status: 200, json: async () => answer } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection(onOpenGeneral: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <IndexadoresSection onOpenGeneral={onOpenGeneral} />
    </QueryClientProvider>,
  )
}

/** La tarjeta «Nuevo indexador» del diseño — los submits del formulario se
 *  localizan dentro de ella (ADAPTADO T4/S3: la cabecera del panel trae otro
 *  botón «Añadir indexador»). */
function formCard(): HTMLElement {
  return screen
    .getByRole('heading', { name: /Nuevo indexador|Editar indexador/ })
    .closest('.indexadores-card') as HTMLElement
}

describe('indexers section — the registry', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('renders the list with masked keys and an honest empty state', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    expect(await screen.findByText('NoNaMe')).toBeInTheDocument()
    expect(screen.getByText('Elite')).toBeInTheDocument()
    // The masked key — the only shape a response may ever carry.
    expect(screen.getByText('****9876')).toBeInTheDocument()
    expect(screen.getByText('http://indexer.test/torznab/api')).toBeInTheDocument()
    // Enabled state is visible per row. ADAPTADO (config-1x1 T4/S3, sin
    // aflojar): el toggle del diseño es `role="switch"` con aria-checked
    // (antes button con texto «Sí»/«No»); el estado por fila se reafirma.
    expect(screen.getByRole('switch', { name: 'Habilitado de NoNaMe' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('switch', { name: 'Habilitado de Elite' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('says so plainly when there are no indexers at all', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: [] }) })
    renderSection()

    expect(await screen.findByText(/No hay indexadores/)).toBeInTheDocument()
  })

  it('the add form posts a new indexer', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'POST /api/indexers': () => ({ ok: true, indexer: { ...LIST[0], id: 3, name: 'Ivy' } }),
    })
    renderSection()

    // Literales EXACTOS del formulario del diseño (stitch-13): «Nombre»,
    // «URL», «API Key» — sin el sufijo «del indexador» que era una libertad.
    fireEvent.change(await screen.findByLabelText('Nombre'), {
      target: { value: 'Ivy' },
    })
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'http://ivy.test/torznab/api' },
    })
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'secret-key' },
    })
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'secret-key' },
    })
    // T4/S3 adaptation (was `fireEvent.change` on the old free-text field
    // «Categorías (separadas por coma)» with '2000,100000'): the field is now
    // a checkbox grid, so the interaction is two box clicks. Assertions are
    // NOT loosened — still an exact payload match. '100000' was a custom id
    // the free text could type; custom-id survival is now pinned (edit load
    // «(personalizada)») in indexadoresCategorias.test.tsx.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Películas 2000' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Consola 1000' }))
    // ADAPTADO (config-1x1 T4/S2): el submit del formulario es «Guardar» (el
    // literal del diseño — el «Añadir indexador» vive sólo en la cabecera y no
    // hay dos botones con el mismo nombre); la query se acota a la tarjeta
    // «Nuevo indexador». Misma acción, mismo payload exacto.
    fireEvent.click(within(formCard()).getByRole('button', { name: 'Guardar' }))

    await waitFor(() => {
      const post = fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers' && init?.method === 'POST',
      )
      expect(post).toBeTruthy()
    })
    const post = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers' && init?.method === 'POST',
    )
    expect(JSON.parse(String(post![1]?.body))).toEqual({
      name: 'Ivy',
      url: 'http://ivy.test/torznab/api',
      api_key: 'secret-key',
      categories: '2000,1000',
    })
    expect(await screen.findByRole('status')).toHaveTextContent(/añadido/i)
  })

  it('toggling enabled sends a PUT with the flipped flag', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'PUT /api/indexers/1': () => ({ ok: true, indexer: { ...LIST[0], enabled: 0 } }),
    })
    renderSection()

    // ADAPTADO (config-1x1 T4/S3): mismo toggle, ahora `role="switch"`.
    fireEvent.click(await screen.findByRole('switch', { name: 'Habilitado de NoNaMe' }))

    await waitFor(() => {
      const put = fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
      )
      expect(put).toBeTruthy()
      expect(JSON.parse(String(put![1]?.body))).toEqual({ enabled: false })
    })
  })

  it('«Probar» shows the caps on success and the detail on failure', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'POST /api/indexers/1/test': () => ({
        ok: true,
        caps: { searches: { search: { available: true } }, categories: [{ id: 2000, name: 'Movies' }] },
      }),
      'POST /api/indexers/2/test': () => ({
        ok: false,
        detail: 'timeout leyendo las capabilities',
      }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar NoNaMe' }))
    expect(await screen.findByText(/capabilities recibidas/)).toBeInTheDocument()
    expect(screen.getByText(/Movies/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Probar Elite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/timeout leyendo las capabilities/)
  })

  it('editing keeps the stored key when the field is left empty', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'PUT /api/indexers/1': () => ({ ok: true, indexer: LIST[0] }),
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar NoNaMe' }))

    // The secret is never pre-filled: «(sin cambio)» means keep.
    const keyInput = screen.getByPlaceholderText('(sin cambio)')
    expect(keyInput).toHaveValue('')
    expect(screen.getByLabelText('Nombre')).toHaveValue('NoNaMe')

    // ADAPTADO (config-1x1 T4/S2): el submit del formulario es «Guardar»
    // (literal del diseño) en crear Y editar; «Cancelar» se conserva tal cual.
    fireEvent.click(within(formCard()).getByRole('button', { name: 'Guardar' }))

    await waitFor(() => {
      const put = fn.mock.calls.find(
        ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
      )
      expect(put).toBeTruthy()
    })
    const put = fn.mock.calls.find(
      ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'PUT',
    )
    const body = JSON.parse(String(put![1]?.body)) as { api_key: string; name: string }
    // Empty api_key = keep the stored one — the backend reads it that way.
    expect(body.api_key).toBe('')
    expect(body.name).toBe('NoNaMe')
  })

  it('delete asks for confirmation and only deletes when accepted', async () => {
    const fn = mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'DELETE /api/indexers/1': () => ({ ok: true }),
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Eliminar NoNaMe' }))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('NoNaMe'))
    expect(
      fn.mock.calls.find(([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'DELETE'),
    ).toBeUndefined()

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar NoNaMe' }))
    await waitFor(() => {
      expect(
        fn.mock.calls.find(
          ([input, init]) => String(input) === '/api/indexers/1' && init?.method === 'DELETE',
        ),
      ).toBeTruthy()
    })
    confirmSpy.mockRestore()
  })
})

describe('panel «Indexadores» — estructura del diseño (config-1x1 T4/S2)', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('renders the design header: title, subtitle and the two top-right actions', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    const heading = await screen.findByRole('heading', { name: 'Indexadores', level: 2 })
    const header = heading.closest('.settings-panel-header') as HTMLElement
    within(header).getByText('Fuentes Torznab directas para buscar y descargar')

    // Acciones del diseño, arriba a la derecha: bloque de acciones tras el título.
    const importBtn = within(header).getByRole('button', { name: 'Importar de Prowlarr/Jackett…' })
    const addBtn = within(header).getByRole('button', { name: 'Añadir indexador' })
    expect(header.lastElementChild).toContainElement(importBtn)
    expect(header.lastElementChild).toContainElement(addBtn)
  })

  it('the Import action is visible but honestly disabled — its step does not exist yet', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    // Regla de honestidad: elemento visible, SIN acción falsa y SIN ocultarlo.
    const importBtn = await screen.findByRole('button', { name: 'Importar de Prowlarr/Jackett…' })
    expect(importBtn).toBeDisabled()
    expect(importBtn).toHaveAttribute('title', 'Disponible al importar de Prowlarr (próximo paso)')
  })

  it('the header «Añadir indexador» is an honest anchor into the visible form', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    const heading = await screen.findByRole('heading', { name: 'Indexadores', level: 2 })
    const header = heading.closest('.settings-panel-header') as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: 'Añadir indexador' }))
    expect(screen.getByLabelText('Nombre')).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: '+ Añadir indexador' }))
    expect(screen.getByLabelText('Nombre')).toHaveFocus()
  })

  it('stacks the design cards in order with their literal heads', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    const search = await screen.findByRole('heading', { name: 'Búsqueda unificada' })
    const registry = screen.getByRole('heading', { name: 'Indexadores Torznab registrados' })
    const form = screen.getByRole('heading', { name: 'Nuevo indexador' })

    expect(search.compareDocumentPosition(registry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(registry.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const searchCard = search.closest('.indexadores-card') as HTMLElement
    within(searchCard).getByText(
      'Sondeo en tiempo real a través de fuentes Torznab locales y remotas configuradas.',
    )
    const registryCard = registry.closest('.indexadores-card') as HTMLElement
    within(registryCard).getByText(
      'Servidores y agregadores Torznab estándar para consultas automáticas.',
    )
    // El badge «N registrados» usa el dato REAL del listado (2 en LIST).
    await within(registryCard).findByText('2 registrados')
    const formCardEl = form.closest('.indexadores-card') as HTMLElement
    within(formCardEl).getByText('Configuración de un endpoint Torznab personalizado.')

    // Datos inventados del mockup («17 fuentes activas»): REPORTADOS, jamás
    // renderizados con números que el backend no devuelve.
    expect(screen.queryByText(/fuentes activas/)).toBeNull()
  })

  it('renders the registry as the design table and keeps every CRUD affordance', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    const table = await screen.findByRole('table')
    for (const col of ['Estado', 'Nombre', 'URL', 'Categorías', 'API Key', 'Acciones']) {
      within(table).getByRole('columnheader', { name: col })
    }
    expect(within(table).getAllByRole('switch')).toHaveLength(2)
    // La máscara de la API key — el único shape que viaja — sigue visible.
    within(table).getByText('****9876')
    // Categorías vacías = «— (todas)», como el diseño.
    within(table).getByText('— (todas)')
    within(table).getByRole('button', { name: 'Probar NoNaMe' })
    within(table).getByRole('button', { name: 'Editar NoNaMe' })
    within(table).getByRole('button', { name: 'Eliminar NoNaMe' })
    screen.getByRole('button', { name: '+ Añadir indexador' })
  })

  it('shows the design note and an honest disabled in-form probe', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    const card = formCard()
    expect(card).toHaveTextContent(
      'Prueba la conexión con t=caps antes de guardar. La clave se guarda cifrada y nunca se muestra completa.',
    )
    // La nota pide «probar antes de guardar»: la sonda con valores sin guardar
    // no existe aún en el backend — visible, honesta y REPORTADA, sin acción falsa.
    const probe = within(card).getByRole('button', { name: 'Probar' })
    expect(probe).toBeDisabled()
  })

  it('renders the closing callout literally and its link drives the onOpenGeneral prop', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    const onOpenGeneral = vi.fn()
    renderSection(onOpenGeneral)

    const callout = document.querySelector('.indexadores-callout') as HTMLElement
    expect(callout).toHaveTextContent(
      'La conexión a aMule no es un indexador: su host, puerto y contraseña EC se configuran en la pestaña aMule (EC directo). Los resultados de la fuente «amule» salen de esa conexión.',
    )
    const link = within(callout).getByRole('link', { name: 'la pestaña aMule (EC directo)' })
    expect(link).toHaveAttribute('href', '#')
    // El enlace YA NO depende del truco del anclaje DOM (`#settings-tab-general`):
    // en este render ese tab ni siquiera existe, y aún así el enlace conmuta —
    // por la prop real `onOpenGeneral`, su único mecanismo.
    expect(document.getElementById('settings-tab-general')).toBeNull()
    fireEvent.click(link)
    expect(onOpenGeneral).toHaveBeenCalledTimes(1)
  })

  it('the new chrome is styled in Settings.css, not with inline styles', async () => {
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    const cards = document.querySelector('.indexadores-cards') as HTMLElement
    expect(cards).not.toBeNull()
    expect(cards.querySelector('[style]')).toBeNull()
  })
})

describe('«Fuentes integradas» — fuentes de primer nivel, no registro (config-1x1 T7/S5)', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  /** SCOPED (colisión «Fuentes»): el heading exacto, nunca «Fuentes» suelto. */
  function sourcesCard(): HTMLElement {
    return screen
      .getByRole('heading', { name: 'Fuentes integradas', level: 3 })
      .closest('.indexadores-card') as HTMLElement
  }

  /** SCOPED (colisiones «aMule (EC)»/«Prowlarr»): texto exacto dentro de la
   *  tarjeta, y de ahí la fila. */
  function sourceRow(card: HTMLElement, name: string): HTMLElement {
    return within(card).getByText(name).closest('.indexadores-source-row') as HTMLElement
  }

  it('renders before the Torznab registry card and lists exactly aMule (EC) and Prowlarr', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'GET /api/services': () => ({
        services: [
          { key: 'radarr', kind: 'arr', url: 'http://radarr.test', configured: true },
          { key: 'prowlarr', kind: 'prowlarr', url: 'http://prowlarr.test:9696', configured: true },
          { key: 'amule', kind: 'amule', url: 'http://amule.test:4712', configured: true },
        ],
        configured: ['radarr', 'prowlarr', 'amule'],
      }),
    })
    renderSection()

    const card = sourcesCard()
    const registry = screen.getByRole('heading', { name: 'Indexadores Torznab registrados' })
    // Estructura/orden: la tarjeta nueva va ANTES del registro (S5).
    expect(
      screen
        .getByRole('heading', { name: 'Fuentes integradas', level: 3 })
        .compareDocumentPosition(registry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // Las dos filas de primer nivel…
    await within(card).findByText('aMule (EC)')
    within(card).getByText('Prowlarr')
    // …y SÓLO ellas: el registro de servicios trae más keys (radarr) que aquí
    // no pintan nada (triángulo negativo).
    expect(within(card).queryByText('radarr')).toBeNull()
  })

  it('status comes from GET /api/services: configured shows the URL, unconfigured tells the truth', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'GET /api/services': () => ({
        services: [
          { key: 'prowlarr', kind: 'prowlarr', url: '', configured: false },
          { key: 'amule', kind: 'amule', url: 'http://127.0.0.1:4712', configured: true },
        ],
        configured: ['amule'],
      }),
    })
    renderSection()

    const card = sourcesCard()
    const amule = await within(card).findByText('aMule (EC)')
    const amuleRow = amule.closest('.indexadores-source-row') as HTMLElement
    // SCOPED a la fila (colisión «Configurado»): nunca página completa.
    within(amuleRow).getByText('Configurado')
    within(amuleRow).getByText('http://127.0.0.1:4712')

    const prowlarrRow = sourceRow(card, 'Prowlarr')
    within(prowlarrRow).getByText('No configurado')
    within(prowlarrRow).getByText('sin configurar')
  })

  it('the inverse case: unconfigured keeps its URL visible, configured is never sticky', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'GET /api/services': () => ({
        services: [
          { key: 'prowlarr', kind: 'prowlarr', url: 'http://prowlarr.test:9696', configured: true },
          { key: 'amule', kind: 'amule', url: 'http://amule.test:4712', configured: false },
        ],
        configured: ['prowlarr'],
      }),
    })
    renderSection()

    const card = sourcesCard()
    // URL presente AUNQUE no configurado (falta otro dato): la URL se muestra,
    // el estado dice «No configurado» — jamás se oculta la verdad a medias.
    await within(card).findByText('aMule (EC)')
    const amuleRow = sourceRow(card, 'aMule (EC)')
    within(amuleRow).getByText('No configurado')
    within(amuleRow).getByText('http://amule.test:4712')

    const prowlarrRow = sourceRow(card, 'Prowlarr')
    within(prowlarrRow).getByText('Configurado')
    within(prowlarrRow).getByText('http://prowlarr.test:9696')
  })

  it('the aMule row is actionable: accessible name and onOpenGeneral on activation', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'GET /api/services': () => ({
        services: [{ key: 'amule', kind: 'amule', url: 'http://127.0.0.1:4712', configured: true }],
        configured: ['amule'],
      }),
    })
    const onOpenGeneral = vi.fn()
    renderSection(onOpenGeneral)

    const card = sourcesCard()
    // SCOPED por ROL + nombre completo (colisión con el enlace del callout,
    // «la pestaña aMule (EC directo)», que es substring de este nombre).
    const row = await within(card).findByRole('button', {
      name: 'aMule (EC) — Configurar en la pestaña aMule (EC directo)',
    })
    expect(row).toHaveAttribute('type', 'button')
    // Accesible por teclado: elemento enfocable nativo (Enter/Space activan
    // un <button> por contrato HTML — jsdom no dispara click desde keydown y
    // user-event no es dependencia del repo).
    row.focus()
    expect(row).toHaveFocus()

    fireEvent.click(row)
    expect(onOpenGeneral).toHaveBeenCalledTimes(1)
  })

  it('the Prowlarr row stays static: no invented action, click does nothing', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'GET /api/services': () => ({
        services: [{ key: 'prowlarr', kind: 'prowlarr', url: 'http://prowlarr.test:9696', configured: true }],
        configured: ['prowlarr'],
      }),
    })
    const onOpenGeneral = vi.fn()
    renderSection(onOpenGeneral)

    const card = sourcesCard()
    await within(card).findByText('Prowlarr')
    const prowlarrRow = sourceRow(card, 'Prowlarr')
    within(prowlarrRow).getByText('Configurado')
    // Sin acción inventada: ni botón, ni enlace, ni affordance falsa (su
    // importación real es el paso 5, ya presente como disabled-honesto en la
    // cabecera del panel).
    expect(within(prowlarrRow).queryAllByRole('button')).toHaveLength(0)
    expect(within(prowlarrRow).queryAllByRole('link')).toHaveLength(0)

    fireEvent.click(prowlarrRow)
    expect(onOpenGeneral).not.toHaveBeenCalled()
  })

  it('the copy distinguishes these sources from the Torznab registry', async () => {
    mockFetch({
      'GET /api/indexers': () => ({ indexers: LIST }),
      'GET /api/services': () => ({ services: [], configured: [] }),
    })
    renderSection()

    // SCOPED a la tarjeta (colisión «Fuentes»/«Torznab» con el subtítulo del
    // panel y el registro): frases clave de la distinción honesta.
    const card = sourcesCard()
    within(card).getByText(/consulta directamente/)
    within(card).getByText(/No son endpoints Torznab/)
    within(card).getByText(/sigue siendo sólo Torznab/)
  })

  it('a degenerate payload never invents a configured state', async () => {
    // El mock por defecto responde `{}` a GET /api/services: sin datos no hay
    // «Configurado» que valga — estado honesto «No configurado» + placeholder.
    mockFetch({ 'GET /api/indexers': () => ({ indexers: LIST }) })
    renderSection()

    const card = sourcesCard()
    await within(card).findByText('aMule (EC)')
    const amuleRow = sourceRow(card, 'aMule (EC)')
    within(amuleRow).getByText('No configurado')
    within(amuleRow).getByText('sin configurar')
    const prowlarrRow = sourceRow(card, 'Prowlarr')
    within(prowlarrRow).getByText('No configurado')
  })
})

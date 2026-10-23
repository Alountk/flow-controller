import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../../features/settings/Settings.tsx'
import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'

/**
 * Configuración con submenú (config-submenu T3/S1-S2 + config-1x1-fixes T3/S2):
 * la página deja de ser una pila única y pasa a doble raíl — «General» (por
 * defecto) e «Indexadores» — con la tarjeta «aMule — conexión directa (EC)» en
 * General. El diseño fuente es `odd/tasks/config-submenu/stitch-12-general.html`
 * (Engram 1453: HTML, no screenshots).
 *
 * config-1x1 T3 (S2) lleva la página a fidelidad ESTRICTA 1:1 con ese HTML:
 * sub-raíl VERTICAL (~320px) con su tarjeta de pie, cabecera del panel con
 * «Guardar cambios»/«Descartar» arriba a la derecha, tarjeta aMule con badge
 * «Protocolo Nativo», subtítulo del diseño y «Indexadores» como enlace
 * accionable. Estilos en `Settings.css` (sin inline styles).
 *
 * Adaptaciones documentadas (S3 — sólo por el cambio estructural, SIN aflojar):
 *  - los ítems del raíl pasan de `button` a `role="tab"` (semántica de
 *    pestañas que pide S2: tablist/tab/tabpanel con aria-selected/aria-hidden);
 *  - el guardado se llama «Guardar cambios» y vive en la cabecera del panel
 *    (antes «Guardar configuración», abajo): mismas aserciones, nueva copia;
 *  - el alcance de la tarjeta pasa de `.settings-section` a `.amule-ec-card`
 *    (la tarjeta ES el card del diseño, sin wrapper intermedio);
 *  - la segunda frase de la nota ahora contiene un enlace anidado, y
 *    `getByText` sólo ve nodos de texto directos: la frase literal completa se
 *    reafirma sobre `textContent` de la tarjeta (misma cadena, sin aflojar).
 *
 * Cero pérdidas: los comportamientos existentes se reafirman en su nueva
 * ubicación; los tests de los demás ficheros de Settings no se tocan salvo el
 * literal del botón de guardado (documentado allí).
 */

const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    opensubtitles: { api_key: '' },
    // GET /api/settings devuelve la contraseña EC SIEMPRE enmascarada (S2).
    amule: { url: 'http://192.168.1.10', ec_port: '4712', ec_password: '****abcd' },
  },
  security: { api_key: '', safe_mode: true },
  developer: false,
  paths: {
    download_amule: '/mnt/storage-6tb/shared-downloads/amule',
    download_torrent: '/mnt/storage/downloads/qbittorrent/completed',
    output_mixed: '/mnt/storage/mixed',
    allowed_roots: ['/mnt/storage', '/mnt/storage-6tb'],
  },
  intervals: { check: 15, max_retries: 3, retry_delay: 2, request_timeout: 5, import_timeout: 40 },
  tracing: { limit: 25 },
  retention: { amule_days: 7 },
  server: { port: 8000 },
}

type RouteHandler = (body: Record<string, unknown> | null) => unknown

/** Dispatch on `METHOD /path` the way the page calls the API (as #222 does). */
function mockFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`
    const handler = routes[key]
    const respond = (answer: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => answer } as Response)
    if (!handler) return respond({})
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const answer = handler(body)
    if (answer instanceof Error) return Promise.reject(answer)
    if (answer instanceof Promise) return answer.then(respond)
    return respond(answer)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const baseRoutes: Record<string, RouteHandler> = {
  'GET /api/settings': () => settings,
  'POST /api/settings': () => ({ ok: true, restart_required: [] }),
  'GET /api/logs': () => ({ logs: [] }),
  'GET /api/services/test': () => ({ results: [], ok: true }),
  'GET /api/indexers': () => ({ indexers: [] }),
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

/** El raíl vertical del diseño (stitch-12: aside w-80 con título/desc/navegación
 *  y la tarjeta de pie). El sub-nav cuelga de él. */
async function rail(): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' })
  return nav.closest('.settings-rail') as HTMLElement
}

/** The distinctive aMule (EC) card — scoped queries avoid the page's
 *  pre-existing "Puerto" label (Servidor). ADAPTADO (S3): el card del diseño
 *  es `.amule-ec-card` (antes `.settings-section`, que era el wrapper genérico). */
async function amuleCard(): Promise<HTMLElement> {
  const title = await screen.findByText(/aMule — conexión directa \(EC\)/)
  return title.closest('.amule-ec-card') as HTMLElement
}

describe('sub-raíl vertical de Configuración (config-1x1 T3/S2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('renders the rail chrome: title, description and the daemons footer card', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const r = await rail()
    // Título y descripción del raíl, copia literal del diseño.
    within(r).getByText('Configuración')
    within(r).getByText(
      'Parámetros operacionales, endpoints locales, demonios multimedia y credenciales de acceso.',
    )

    // Tarjeta de pie del diseño («Sincronización de Daemons…»).
    const footTitle = within(r).getByText('Sincronización de Daemons')
    const foot = footTitle.closest('.settings-rail-foot') as HTMLElement
    expect(foot).toHaveTextContent(
      'Los perfiles y conexiones críticas se sincronizan directamente con los daemons locales de Node y sockets UNIX. Cualquier cambio surte efecto de forma inmediata sin necesidad de reiniciar el host salvo que se modifique el puerto de escucha.',
    )
  })

  it('renders both rail tabs with aria-selected, General active by default', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' })
    const tabs = within(nav).getByRole('tablist')
    // ADAPTADO (S3): los ítems del raíl son `role="tab"` (semántica de
    // pestañas), antes `role="button"`. Misma conducta: conmutan paneles.
    const general = within(tabs).getByRole('tab', { name: 'General' })
    expect(general).toHaveAttribute('aria-selected', 'true')
    const indexadores = within(tabs).getByRole('tab', { name: 'Indexadores' })
    expect(indexadores).toHaveAttribute('aria-selected', 'false')
  })

  it('mounts both panels: General visible, Indexadores hidden (state preserved)', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    // Default: General is the visible panel, Indexadores is mounted but hidden.
    // OJO: el nombre accesible de un subárbol `hidden` se computa vacío en
    // jsdom, así que el panel oculto se localiza por su id (el anclaje
    // aria-controls del tab) y se reafirma su rol/aria-hidden/visibilidad.
    const generalPanel = await screen.findByRole('tabpanel', { name: 'General' })
    expect(generalPanel).toHaveAttribute('aria-labelledby', 'settings-tab-general')
    expect(generalPanel).toBeVisible()
    expect(generalPanel).toHaveAttribute('aria-hidden', 'false')
    await screen.findByText('Servicios')
    expect(screen.getByText('Servicios')).toBeVisible()

    const indexadoresPanel = document.getElementById('settings-panel-indexadores') as HTMLElement
    expect(indexadoresPanel).toHaveAttribute('role', 'tabpanel')
    expect(indexadoresPanel).toHaveAttribute('aria-labelledby', 'settings-tab-indexadores')
    expect(indexadoresPanel).toHaveAttribute('aria-hidden', 'true')
    expect(indexadoresPanel).not.toBeVisible()
    const indexadores = await screen.findByText(/No hay indexadores/)
    expect(indexadores).not.toBeVisible()
  })

  it('switching to Indexadores shows IndexadoresSection and hides General', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const indexadores = await screen.findByText(/No hay indexadores/)
    expect(indexadores).not.toBeVisible()

    // ADAPTADO (S3): el conmutador es ahora el tab del raíl (antes button).
    fireEvent.click(screen.getByRole('tab', { name: 'Indexadores' }))
    expect(indexadores).toBeVisible()
    expect(screen.getByText('Servicios')).not.toBeVisible()
    expect(screen.getByRole('heading', { name: 'Indexadores' })).toBeVisible()

    // And back: General returns, Indexadores hides again.
    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    expect(screen.getByText('Servicios')).toBeVisible()
    expect(indexadores).not.toBeVisible()
  })
})

describe('cabecera del panel «General» — Guardar cambios / Descartar (config-1x1 T3/S2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('shows the panel title and subtitle with both actions in the header', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const heading = await screen.findByRole('heading', { name: 'General', level: 2 })
    const header = heading.closest('.settings-panel-header') as HTMLElement
    within(header).getByText('Ajustes generales del panel y conexiones de los servicios')

    // Acciones del diseño, arriba a la derecha: bloque de acciones tras el
    // título, dentro de la cabecera del panel.
    const save = within(header).getByRole('button', { name: 'Guardar cambios' })
    const discard = within(header).getByRole('button', { name: 'Descartar' })
    expect(header.lastElementChild).toContainElement(save)
    expect(header.lastElementChild).toContainElement(discard)

    // El guardado ya no vive abajo (era «Guardar configuración» en .settings-actions).
    expect(document.querySelector('.settings-actions')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Guardar cambios' })).toHaveLength(1)
  })

  it('«Descartar» discards the typed edits and restores the fetched settings without saving', async () => {
    const fn = mockFetch(baseRoutes)
    renderSettings()

    const host = await screen.findByLabelText('Host / URL')
    fireEvent.change(host, { target: { value: 'http://cambiado' } })
    expect(host).toHaveValue('http://cambiado')

    // ADAPTADO (S3): «Descartar» hereda la semántica del antiguo «Restablecer»
    // (recarga lo guardado y limpia los avisos de reinicio), sólo cambia de
    // sitio y de nombre.
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(host).toHaveValue('http://192.168.1.10')
    expect(
      fn.mock.calls.some(
        ([input, init]) =>
          String(input).includes('/api/settings') && init?.method === 'POST',
      ),
    ).toBe(false)
  })
})

describe('aMule (EC) card — disposición del diseño (config-1x1 T3/S2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('General keeps every existing section and adds the aMule (EC) card', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    for (const title of [
      'Servicios',
      'Estado de las conexiones',
      'Seguridad',
      'Rutas',
      'Intervalos',
      'Seguimiento',
      'Servidor',
      'Logs del Sistema',
    ]) {
      expect(await screen.findByText(title)).toBeVisible()
    }

    const card = await amuleCard()
    // Los tres campos de la tarjeta, según stitch-12-general.html.
    const host = within(card).getByLabelText('Host / URL')
    expect(host).toHaveValue('http://192.168.1.10')
    const port = within(card).getByLabelText('Puerto')
    expect(port).toHaveAttribute('placeholder', '4712')
    const password = within(card).getByLabelText('Contraseña EC')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveValue('****abcd')

    // La nota literal del diseño (primera frase sobre el texto directo, como
    // siempre; ADAPTADO S3: la segunda frase ahora contiene un enlace anidado,
    // así que se reafirma la cadena completa sobre textContent — misma copia).
    expect(
      within(card).getByText(
        /Es la conexión al daemon aMule por el protocolo EC \(eD2k\/Kad\)\./,
      ),
    ).toBeInTheDocument()
    expect(card).toHaveTextContent(
      'No es un indexador Torznab: los indexadores se configuran en la pestaña Indexadores.',
    )
  })

  it('carries the design header copy and the «Protocolo Nativo» badge', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const card = await amuleCard()
    const title = within(card).getByText(/aMule — conexión directa \(EC\)/)
    const head = title.closest('.amule-ec-card-head') as HTMLElement
    // Subtítulo literal del diseño (sin markup intermedio).
    within(head).getByText('External Connection (EC) para telemetría directa con el core aMuled.')
    // Badge del diseño, en la cabecera de la tarjeta (a la derecha).
    within(head).getByText('Protocolo Nativo')
  })

  it('lays the three EC fields in the design row container', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const card = await amuleCard()
    const row = card.querySelector('.amule-ec-fields') as HTMLElement
    expect(row).not.toBeNull()
    within(row).getByLabelText('Host / URL')
    within(row).getByLabelText('Puerto')
    within(row).getByLabelText('Contraseña EC')
  })

  it('the note keeps «Indexadores» as an actionable link, not plain text', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const card = await amuleCard()
    // Liberty #2 undone: «Indexadores» vuelve a ser un control con nombre
    // accesible correcto (antes texto plano).
    const link = within(card).getByRole('link', { name: 'Indexadores' })
    expect(link).toHaveAttribute('href', '#')
  })

  it('the «Indexadores» link opens the Indexadores panel', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    const card = await amuleCard()
    fireEvent.click(within(card).getByRole('link', { name: 'Indexadores' }))

    const indexadores = await screen.findByText(/No hay indexadores/)
    expect(indexadores).toBeVisible()
    expect(screen.getByText('Servicios')).not.toBeVisible()
  })

  it('the new chrome is styled in Settings.css, not with inline styles', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    // Liberty #3 undone: nada de `style=` en las partes nuevas (raíl, tarjeta,
    // badge, enlace) — los estilos viven en Settings.css.
    const r = await rail()
    expect(r.querySelector('[style]')).toBeNull()
    const card = await amuleCard()
    expect(card.querySelector('[style]')).toBeNull()
    expect(card.querySelector('.amule-ec-badge')).not.toBeNull()
    expect(card.querySelector('.amule-ec-note-link')).not.toBeNull()
  })
})

describe('aMule (EC) card — «Probar conexión EC» (S2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('shows a successful probe as an ok toast with the returned detail', async () => {
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => ({ ok: true, detail: 'aMule 2.3.3 (EC0x0307)' }),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'aMule 2.3.3 (EC0x0307)', tone: 'ok' }),
      ),
    )
  })

  it('shows a refused probe as an error toast with the returned detail', async () => {
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => ({
        ok: false,
        detail: 'AmuleAuthError: contraseña EC rechazada',
      }),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({
          message: 'AmuleAuthError: contraseña EC rechazada',
          tone: 'error',
        }),
      ),
    )
  })

  it('reports a transport failure as an error toast, not silence', async () => {
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => new Error('network down'),
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts().some((t) => t.tone === 'error')).toBe(true),
    )
  })

  it('does not double-fire while a probe is pending', async () => {
    let resolveProbe!: (value: unknown) => void
    const pending = new Promise((r) => {
      resolveProbe = r
    })
    const fn = mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': () => pending,
    })
    renderSettings()

    const button = await screen.findByRole('button', { name: 'Probar conexión EC' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(
      fn.mock.calls.filter(([input]) => String(input).includes('/api/amule/test')),
    ).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Probando…' })).toBeVisible()

    resolveProbe({ ok: true, detail: 'conectado' })
    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    expect(
      screen.getByRole('button', { name: 'Probar conexión EC' }),
    ).toBeVisible()
  })

  it('flows the EC fields into the saved payload through update()', async () => {
    let saved: Record<string, unknown> | null = null
    mockFetch({
      ...baseRoutes,
      'POST /api/settings': (body) => {
        saved = body
        return { ok: true, restart_required: [] }
      },
    })
    renderSettings()

    const card = await amuleCard()
    fireEvent.change(within(card).getByLabelText('Host / URL'), {
      target: { value: 'http://10.0.0.5' },
    })
    fireEvent.change(within(card).getByLabelText('Puerto'), {
      target: { value: '4713' },
    })
    // Borrar la contraseña deja la cadena vacía: la semántica «vacío/máscara
    // = conservar la guardada» la aplica el backend (S2), aquí se comprueba
    // que el frontend no inventa ni retiene valores.
    fireEvent.change(within(card).getByLabelText('Contraseña EC'), {
      target: { value: '' },
    })
    // ADAPTADO (S3): el guardado es ahora «Guardar cambios» (cabecera).
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(saved).not.toBeNull())
    expect((saved as unknown as { services: { amule: unknown } }).services.amule).toEqual({
      url: 'http://10.0.0.5',
      ec_port: '4713',
      ec_password: '',
    })
  })

  it('posts the masked EC password back untouched when the field is left alone', async () => {
    let saved: Record<string, unknown> | null = null
    mockFetch({
      ...baseRoutes,
      'POST /api/settings': (body) => {
        saved = body
        return { ok: true, restart_required: [] }
      },
    })
    renderSettings()

    // ADAPTADO (S3): literal «Guardar cambios» en la cabecera del panel.
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(saved).not.toBeNull())
    expect(
      (saved as unknown as { services: { amule: { ec_password: string } } }).services.amule
        .ec_password,
    ).toBe('****abcd')
  })
})

describe('«Probar conexión EC» — sonda de lo ESCRITO (config-1x1 S1/T2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('probes the values just typed in the card, not the stored ones', async () => {
    let sent: unknown = 'sin llamada'
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': (body) => {
        sent = body
        return { ok: true, detail: 'conectado' }
      },
    })
    renderSettings()

    const card = await amuleCard()
    fireEvent.change(within(card).getByLabelText('Host / URL'), {
      target: { value: 'http://10.0.0.5' },
    })
    fireEvent.change(within(card).getByLabelText('Puerto'), {
      target: { value: '4713' },
    })
    fireEvent.change(within(card).getByLabelText('Contraseña EC'), {
      target: { value: 'clave-nueva-1' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    expect(sent).toEqual({
      url: 'http://10.0.0.5',
      ec_port: '4713',
      ec_password: 'clave-nueva-1',
    })
  })

  it('never sends the masked password as a candidate: omitted, stored wins', async () => {
    let sent: unknown = 'sin llamada'
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': (body) => {
        sent = body
        return { ok: true, detail: 'conectado' }
      },
    })
    renderSettings()

    // Sin tocar el form: la contraseña del campo es la máscara que devolvió GET.
    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    expect(sent).toEqual({ url: 'http://192.168.1.10', ec_port: '4712' })
    expect(sent).not.toHaveProperty('ec_password')
  })

  it('omits empty fields entirely so the probe falls back to the stored config', async () => {
    let sent: unknown = 'sin llamada'
    mockFetch({
      ...baseRoutes,
      'POST /api/amule/test': (body) => {
        sent = body
        return { ok: true, detail: 'conectado' }
      },
    })
    renderSettings()

    const card = await amuleCard()
    fireEvent.change(within(card).getByLabelText('Host / URL'), { target: { value: '' } })
    fireEvent.change(within(card).getByLabelText('Puerto'), { target: { value: '' } })
    fireEvent.change(within(card).getByLabelText('Contraseña EC'), { target: { value: '' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Probar conexión EC' }))

    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ message: 'conectado', tone: 'ok' }),
      ),
    )
    // Nada escrito → SIN body: la sonda usa la config guardada, como siempre.
    expect(sent).toBeNull()
  })
})

describe('callout «La conexión a aMule no es un indexador…» (config-1x1 T4/S2)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('the callout link opens General — the aMule (EC directo) card lives there', async () => {
    mockFetch(baseRoutes)
    renderSettings()

    fireEvent.click(await screen.findByRole('tab', { name: 'Indexadores' }))
    const callout = document.querySelector('.indexadores-callout') as HTMLElement
    expect(callout).toBeVisible()

    // El callout literal del diseño enlaza a «General → aMule (EC directo)» y
    // el enlace es ACCIONABLE (la libertad de T3 de dejar enlaces muertos no
    // se repite): conmuta al panel General donde vive la tarjeta aMule.
    fireEvent.click(within(callout).getByRole('link', { name: 'General → aMule (EC directo)' }))
    expect(await screen.findByText(/aMule — conexión directa \(EC\)/)).toBeVisible()
    expect(callout).not.toBeVisible()
  })
})

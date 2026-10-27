import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import {
  LanguageSearchSection,
  type LanguageSearchContext,
} from '../../../features/release-search/LanguageSearchSection.tsx'

/**
 * «Búsqueda en idioma» (S4/T3) — the section the ALTERNATIVE flow mounts in
 * `AlternativeModal` (T4/S7; S5: «Sólo en alternativa»).
 *
 * Radarr searches by id and never `alternateTitles`, so Russian releases hide
 * behind Russian titles the indexers know. The section offers the titles the
 * lookup payload carries (original + alternates as chips) plus a free-text
 * input for the ones TMDB does not have, and searches Prowlarr with the term
 * AS WRITTEN. Each row (title, indexer, seeders, size) carries T4/S7's single
 * action: «Descargar» sends the row's magnet or .torrent link straight to the
 * download client, with the pending/success/failure state kept per row.
 *
 * RTL + fireEvent only — `@testing-library/user-event` is not installed, and
 * `fireEvent.click` fires on disabled buttons, so the component must guard the
 * handler itself.
 */

/** The context the section takes — `AlternativeModal` builds it from the
 *  alternative lookup's titles and movie id. */
type LanguageSearchData = LanguageSearchContext

const languageSearch: LanguageSearchData = {
  originalTitle: 'Arthur et les Minimoys',
  alternateTitles: [
    { title: 'Grom', language: 'ru' },
    { title: 'Ton Nom', language: null },
  ],
  movieId: 42,
}

const indexers = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

const PROWLARR_ROW = {
  title: 'Артур и минипуты (2006) BDRip',
  indexer: 'NoNaMe Club',
  size: 2_000_000_000,
  seeders: 42,
  guid: 'real-1',
  magnet_url: 'magnet:?xt=urn:btih:abc123',
}

interface MockOptions {
  /** The language-search POST's answer body. */
  searchBody?: Record<string, unknown>
  /** The language-search POST's HTTP status (default 200). */
  searchStatus?: number
  /** Keep the language-search POST in flight until the test settles it. */
  searchDeferred?: Promise<unknown>
  /** The language-download POST's answer body. */
  downloadBody?: Record<string, unknown>
  /** The language-download POST's HTTP status (default 200). */
  downloadStatus?: number
  /** Keep the language-download POST in flight until the test settles it. */
  downloadDeferred?: Promise<unknown>
}

function mockFetch(options: MockOptions = {}) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => indexers } as Response)
    }
    if (url.includes('/api/settings')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          paths: { path_4k: '/mnt/storage-6tb/4k', path_3d: '/mnt/storage/6tb/3d' },
        }),
      } as Response)
    }
    if (url.includes('/api/mixer/alternatives/language-search')) {
      if (options.searchDeferred) return options.searchDeferred
      const status = options.searchStatus ?? 200
      return Promise.resolve({
        ok: status < 400,
        status,
        json: async () => options.searchBody ?? { releases: [] },
      } as Response)
    }
    if (url.includes('/api/mixer/alternatives/language-download')) {
      if (options.downloadDeferred) return options.downloadDeferred
      const status = options.downloadStatus ?? 200
      return Promise.resolve({
        ok: status < 400,
        status,
        json: async () => options.downloadBody ?? { ok: true, detail: 'Descarga añadida (categoría flow)' },
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type FetchMock = ReturnType<typeof mockFetch>

/** Every language-search request body the section has sent, in order. */
function searchBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes('/api/mixer/alternatives/language-search'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

/** Every language-download request body the section has sent, in order. */
function downloadBodies(fn: FetchMock): Record<string, unknown>[] {
  return fn.mock.calls
    .filter(([input]) => String(input).includes('/api/mixer/alternatives/language-download'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

/** T4/S7: the section lives in `AlternativeModal` now, so the behavior pins
 *  mount it DIRECTLY with the same lookup context the modal passes. */
function renderSection(context: LanguageSearchData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LanguageSearchSection context={context} />
    </QueryClientProvider>,
  )
}

/** The release-search modal — which must never carry the section (T4/S7). */
function renderReleaseModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 42, title: 'Arthur and the Invisibles', source: 'radarr' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

const queryInput = () =>
  screen.getByPlaceholderText('Título en el idioma que quieras') as HTMLInputElement

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Búsqueda en idioma — section gate (T4/S7)', () => {
  it('renders no section in ReleaseSearchModal — it belongs to AlternativeModal now', () => {
    mockFetch()
    renderReleaseModal()

    expect(screen.queryByText('Búsqueda en idioma')).toBeNull()
  })

  it('renders the section when it gets the lookup titles (the AlternativeModal mount)', () => {
    mockFetch()
    renderSection(languageSearch)

    expect(screen.getByText('Búsqueda en idioma')).toBeInTheDocument()
  })
})

describe('Búsqueda en idioma — chips fill the input (S4)', () => {
  it('renders an ORIGINAL chip and one chip per alternate, labeled with its language code', () => {
    mockFetch()
    renderSection(languageSearch)

    expect(
      screen.getByRole('button', { name: 'ORIGINAL: Arthur et les Minimoys' }),
    ).toBeInTheDocument()
    // Uppercase language code as the chip label; no language → bare title.
    expect(screen.getByRole('button', { name: 'RU: Grom' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ton Nom' })).toBeInTheDocument()
  })

  it('clicking a chip fills the editable input with that title', () => {
    mockFetch()
    renderSection(languageSearch)

    fireEvent.click(screen.getByRole('button', { name: 'RU: Grom' }))

    expect(queryInput().value).toBe('Grom')
    // Free text: the user can overwrite whatever the chip filled.
    fireEvent.change(queryInput(), { target: { value: 'Артур и минипуты' } })
    expect(queryInput().value).toBe('Артур и минипуты')
  })
})

describe('Búsqueda en idioma — search and results', () => {
  it('sends {query, movieId} and renders rows (title, indexer, seeders, size) with their one action', async () => {
    const fn = mockFetch({ searchBody: { releases: [PROWLARR_ROW] } })
    renderSection(languageSearch)

    // The input is free text — the titles TMDB does not carry are typed by hand.
    fireEvent.change(queryInput(), { target: { value: 'Артур и минипуты' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))

    await screen.findByText('Артур и минипуты (2006) BDRip')
    expect(searchBodies(fn)).toEqual([{ query: 'Артур и минипуты', movieId: 42 }])

    const row = screen
      .getByText('Артур и минипуты (2006) BDRip')
      .closest('.lang-search-row') as HTMLElement
    expect(within(row).getByText('NoNaMe Club')).toBeInTheDocument()
    expect(within(row).getByText('⬆ 42 semillas')).toBeInTheDocument()
    expect(within(row).getByText('1.9 GB')).toBeInTheDocument()
    // T3's "no buttons in rows" held BEFORE T4 enabled them — the row's
    // ONLY control is T4's download action, nothing else.
    expect(within(row).queryAllByRole('button').map((b) => b.textContent)).toEqual([
      'Descargar',
    ])
  })

  it('a chip-filled search carries the chip language alongside query and movieId', async () => {
    const fn = mockFetch({ searchBody: { releases: [PROWLARR_ROW] } })
    renderSection(languageSearch)

    fireEvent.click(screen.getByRole('button', { name: 'RU: Grom' }))
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))

    await screen.findByText('Артур и минипуты (2006) BDRip')
    expect(searchBodies(fn)).toEqual([{ query: 'Grom', language: 'ru', movieId: 42 }])
  })

  it('shows the 502 «no está configurado» detail inline in Spanish', async () => {
    mockFetch({
      searchStatus: 502,
      searchBody: { detail: 'prowlarr no está configurado (faltan la URL o la API key)' },
    })
    renderSection(languageSearch)

    fireEvent.change(queryInput(), { target: { value: 'Grom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))

    expect(
      await screen.findByText('prowlarr no está configurado (faltan la URL o la API key)'),
    ).toBeInTheDocument()
  })

  it('reports loading and the empty-result state in Spanish', async () => {
    let settle!: (value: unknown) => void
    const deferred = new Promise((resolve) => {
      settle = resolve
    })
    mockFetch({ searchDeferred: deferred })
    renderSection(languageSearch)

    fireEvent.change(queryInput(), { target: { value: 'Grom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))

    // Loading copy while Prowlarr is in flight…
    expect(await screen.findByText('Buscando en Prowlarr…')).toBeInTheDocument()

    // …and the Spanish empty state once it answers with nothing.
    settle({ ok: true, status: 200, json: async () => ({ releases: [] }) })
    expect(await screen.findByText('Sin resultados en Prowlarr')).toBeInTheDocument()
    expect(screen.queryByText('Buscando en Prowlarr…')).toBeNull()
  })
})

describe('Búsqueda en idioma — «Descargar» una fila (S7/T4)', () => {
  it('sends {url, title} and moves the row through «Descargando…» to «Descargado ✓»', async () => {
    let settle!: (value: unknown) => void
    const deferred = new Promise((resolve) => {
      settle = resolve
    })
    const fn = mockFetch({
      searchBody: { releases: [PROWLARR_ROW] },
      downloadDeferred: deferred,
    })
    renderSection(languageSearch)

    fireEvent.change(queryInput(), { target: { value: 'Артур и минипуты' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))
    const row = (await screen.findByText('Артур и минипуты (2006) BDRip')).closest(
      '.lang-search-row',
    ) as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: 'Descargar' }))

    // The add carries the row's magnet (or download url) and its title…
    expect(downloadBodies(fn)).toEqual([
      { url: 'magnet:?xt=urn:btih:abc123', title: 'Артур и минипуты (2006) BDRip' },
    ])
    // …the row shows the pending copy while qBittorrent answers…
    expect(within(row).getByRole('button', { name: 'Descargando…' })).toBeInTheDocument()

    settle({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, detail: 'Descarga añadida (categoría flow)' }),
    })
    // …and the success stays visible once the client accepted it.
    expect(
      await within(row).findByRole('button', { name: 'Descargado ✓' }),
    ).toBeInTheDocument()
    expect(within(row).queryByText('Descargando…')).toBeNull()
  })

  it('shows the client refusal inline in Spanish below the row and lets it retry', async () => {
    mockFetch({
      searchBody: { releases: [PROWLARR_ROW] },
      downloadBody: {
        ok: false,
        detail: 'aMuTorrent no aceptó la descarga: HTTP 400: magnet no soportado',
      },
    })
    renderSection(languageSearch)

    fireEvent.change(queryInput(), { target: { value: 'Артур и минипуты' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))
    const row = (await screen.findByText('Артур и минипуты (2006) BDRip')).closest(
      '.lang-search-row',
    ) as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: 'Descargar' }))

    expect(
      await within(row).findByText(
        'aMuTorrent no aceptó la descarga: HTTP 400: magnet no soportado',
      ),
    ).toBeInTheDocument()
    // The row is back to idle — the user may try again.
    expect(within(row).getByRole('button', { name: 'Descargar' })).not.toBeDisabled()
  })

  it('disables «Descargar» while pending and never sends a second add', async () => {
    let settle!: (value: unknown) => void
    const deferred = new Promise((resolve) => {
      settle = resolve
    })
    const fn = mockFetch({
      searchBody: { releases: [PROWLARR_ROW] },
      downloadDeferred: deferred,
    })
    renderSection(languageSearch)

    fireEvent.change(queryInput(), { target: { value: 'Артур и минипуты' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))
    const row = (await screen.findByText('Артур и минипуты (2006) BDRip')).closest(
      '.lang-search-row',
    ) as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: 'Descargar' }))
    const pending = within(row).getByRole('button', { name: 'Descargando…' })
    expect(pending).toBeDisabled()

    // `fireEvent.click` fires on disabled buttons too — the handler must
    // guard the double-click itself, one endpoint call per row.
    fireEvent.click(pending)
    expect(downloadBodies(fn)).toHaveLength(1)

    settle({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, detail: 'Descarga añadida (categoría flow)' }),
    })
    expect(
      await within(row).findByRole('button', { name: 'Descargado ✓' }),
    ).toBeInTheDocument()
  })

  it('keeps «Descargar» disabled for a row with neither url and sends nothing', async () => {
    const NO_URL_ROW = { ...PROWLARR_ROW, guid: 'no-url', magnet_url: null, download_url: null }
    const fn = mockFetch({ searchBody: { releases: [NO_URL_ROW] } })
    renderSection(languageSearch)

    fireEvent.change(queryInput(), { target: { value: 'Артур и минипуты' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))
    const row = (await screen.findByText('Артур и минипуты (2006) BDRip')).closest(
      '.lang-search-row',
    ) as HTMLElement

    const button = within(row).getByRole('button', { name: 'Descargar' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(downloadBodies(fn)).toHaveLength(0)
  })

  it('surfaces an HTTP refusal detail inline too', async () => {
    mockFetch({
      searchBody: { releases: [PROWLARR_ROW] },
      downloadStatus: 400,
      downloadBody: { detail: 'url no válida: se espera un magnet o una URL http(s)' },
    })
    renderSection(languageSearch)

    fireEvent.change(queryInput(), { target: { value: 'Артур и минипуты' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en Prowlarr' }))
    const row = (await screen.findByText('Артур и минипуты (2006) BDRip')).closest(
      '.lang-search-row',
    ) as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: 'Descargar' }))

    expect(
      await within(row).findByText('url no válida: se espera un magnet o una URL http(s)'),
    ).toBeInTheDocument()
  })
})

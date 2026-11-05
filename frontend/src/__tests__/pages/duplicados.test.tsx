import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Duplicados from '../../pages/Duplicados'

/** `/api/movies/duplicates/delete` también contiene el nombre del recorrido. */
const isWalk = (url: string) => url.includes('/api/movies/duplicates') && !url.includes('/delete')

/** La pantalla lee las raíces configuradas para ofrecer el alcance. */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Duplicados />
    </QueryClientProvider>,
  )
}
import { setApiKey } from '../../shared/api/auth'

/**
 * El caso de prueba es el del usuario, literal: dos ficheros 1080p en la carpeta
 * de «Now You See Me (2013)», y Radarr sólo conoce uno.
 */
const FOLDER = '/mnt/storage/movies/es/Now You See Me (2013)'
const WEBRIP = 'Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv'
const WEBDL = 'Now You See Me (2013) WEBDL-1080p - h265 TrueHD Atmos - [EN+ES].mkv'

const GROUP = {
  folder: FOLDER,
  folders: [FOLDER],
  classes: ['1080'],
  title: 'Now You See Me',
  files: [
    { path: `${FOLDER}/${WEBDL}`, name: WEBDL, size: 2_300_000_000, known: false, class: '1080' },
    { path: `${FOLDER}/${WEBRIP}`, name: WEBRIP, size: 2_100_000_000, known: true, class: '1080' },
  ],
  reclaimable: 2_300_000_000,
}

const ROOTS = { roots: [{ path: '/mnt/storage', name: 'storage', role: 'library', label: 'Biblioteca' }], detail: '' }

let calls: Array<{ url: string; body?: unknown; init?: RequestInit }> = []

function mockFetch(handler?: (url: string, init?: RequestInit) => unknown) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      init,
    })
    if (handler) {
      const result = handler(url, init)
      if (result) return result as Response
    }
    if (String(url).includes('/api/files/roots')) {
      return { ok: true, json: async () => ROOTS } as Response
    }
    if (isWalk(String(url))) {
      return { ok: true, json: async () => ({ groups: [GROUP], total: 1 }) } as Response
    }
    return { ok: true, json: async () => ({ deleted: `${FOLDER}/${WEBDL}` }) } as Response
  }))
}

beforeEach(() => {
  window.localStorage.clear()
  mockFetch()
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Duplicados', () => {
  it('never walks the library on mount: the button is the trigger', () => {
    renderPage()

    expect(screen.getByText(/pulsa «Buscar duplicados»/)).toBeTruthy()
    // Las raíces se leen para ofrecer el alcance; el disco no se camina.
    expect(calls.filter((c) => isWalk(c.url))).toHaveLength(0)
  })

  it('lists both files of the folder, marks which one Radarr knows', async () => {
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))

    await screen.findByText('Now You See Me')
    expect(screen.getByText(WEBRIP)).toBeTruthy()
    expect(screen.getByText(WEBDL)).toBeTruthy()
    expect(screen.getByText('en el catálogo')).toBeTruthy()
    expect(screen.getByText('sobra')).toBeTruthy()
    expect(screen.getByText(/1 título con duplicados · 2 copias · 2\.1 GB recuperables/)).toBeTruthy()
  })

  it('warns when you are about to delete the file Radarr tracks', async () => {
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))
    await screen.findByText('Now You See Me')

    // El que sobra va primero; el del arr es el segundo, y ese es el que avisa.
    fireEvent.click(screen.getAllByText('Borrar')[0])
    expect(screen.getByText('¿Borrar este fichero?')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancelar'))
    fireEvent.click(screen.getAllByText('Borrar')[1])
    expect(screen.getByText(/¿Borrar el que Radarr conoce\?/)).toBeTruthy()
  })

  it('asks before deleting and only then calls the API', async () => {
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))
    await screen.findByText('Now You See Me')

    fireEvent.click(screen.getAllByText('Borrar')[0])
    expect(screen.getByText('¿Borrar este fichero?')).toBeTruthy()
    expect(calls.filter((c) => c.url.includes('/delete'))).toHaveLength(0)

    fireEvent.click(screen.getByText('Sí, borrar'))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/delete'))).toBe(true))
    expect(calls.find((c) => c.url.includes('/delete'))?.body).toEqual({
      path: `${FOLDER}/${WEBDL}`,
    })
  })

  it('drops the folder from the list once you delete the extra file', async () => {
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))
    await screen.findByText('Now You See Me')

    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Sí, borrar'))

    await waitFor(() => expect(screen.getByText(/Ninguna carpeta repite fichero/)).toBeTruthy())
    expect(calls.filter((c) => isWalk(c.url))).toHaveLength(1)
  })

  it('shows the reason when the backend refuses to delete', async () => {
    mockFetch((url) => (url.includes('/delete')
      ? ({ ok: false, json: async () => ({ detail: 'fuera de las carpetas permitidas: /etc/passwd' }) } as Response)
      : undefined))
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))
    await screen.findByText('Now You See Me')

    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Sí, borrar'))

    expect((await screen.findByRole('alert')).textContent).toContain('fuera de las carpetas permitidas')
  })

  it('sends the stored key on both requests, like every other section', async () => {
    setApiKey('clave-de-prueba')
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))
    await screen.findByText('Now You See Me')
    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Sí, borrar'))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/delete'))).toBe(true))

    const headers = calls.map((c) => (c.init?.headers ?? {}) as Record<string, string>)
    expect(headers.every((h) => h['X-Api-Key'] === 'clave-de-prueba')).toBe(true)
  })

  it('does not crash when the payload has no groups (old backend, proxy HTML)', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ detail: 'Not Found' }) } as Response))
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))

    expect(await screen.findByText(/Ninguna carpeta repite fichero/)).toBeTruthy()
  })
})

describe('Duplicados con Radarr caído', () => {
  it('marks nothing as extra and says so, instead of inviting the wrong delete', async () => {
    mockFetch((url) => (isWalk(url)
      ? ({
        ok: true,
        json: async () => ({
          radarr: false,
          total: 1,
          groups: [{
            ...GROUP,
            reclaimable: 0,
            files: GROUP.files.map((f) => ({ ...f, known: null })),
          }],
        }),
      } as Response)
      : undefined))
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))

    await screen.findByText('Now You See Me')
    expect(screen.getAllByText('sin datos')).toHaveLength(2)
    expect(screen.queryByText('sobra')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Radarr no respondió')
    // Sin datos no hay cifra que prometer.
    expect(screen.queryByText(/reclamables/)).toBeNull()
  })
})


describe('Duplicados · dónde busca', () => {
  it('offers the configured roots and sends the chosen one', async () => {
    renderPage()
    const select = (await screen.findByLabelText('Buscar en')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe(''))

    fireEvent.change(select, { target: { value: '/mnt/storage' } })
    fireEvent.click(screen.getByText('Buscar duplicados'))

    await screen.findByText('Now You See Me')
    expect(calls.find((c) => isWalk(c.url))?.url).toContain('path=%2Fmnt%2Fstorage')
  })

  it('remembers the folder for the next search, and walks up from it', async () => {
    window.localStorage.setItem('duplicados.scope', '/mnt/storage/movies')
    renderPage()

    // La barra de ruta es la misma del explorador: raíz y carpeta, cada una
    // un botón.
    const crumbs = await screen.findByRole('navigation', { name: 'Ruta' })
    await waitFor(() => expect(crumbs.textContent).toContain('/mnt/storage'))
    expect(crumbs.textContent).toContain('movies')

    fireEvent.click(screen.getByRole('button', { name: /Subir/ }))
    await waitFor(() =>
      expect(window.localStorage.getItem('duplicados.scope')).toBe('/mnt/storage'),
    )
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Ruta' }).textContent).not.toContain('movies'),
    )
  })

  it('walks the whole library again when the scope is cleared', async () => {
    window.localStorage.setItem('duplicados.scope', '/mnt/storage/movies')
    renderPage()

    // «Todas las raíces» vuelve a recorrer la biblioteca entera.
    fireEvent.change(await screen.findByLabelText('Buscar en'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Buscar duplicados'))

    await screen.findByText('Now You See Me')
    expect(calls.find((c) => isWalk(c.url))?.url).not.toContain('path=')
  })
})

describe('Duplicados · un grupo por película', () => {
  it('puts every repeated class of one movie in a single group', async () => {
    // La detección es por carpeta y clase; la pantalla pregunta por películas.
    const twoClasses = {
      ...GROUP,
      classes: ['4K', '1080'],
      reclaimable: 100,
      files: [
        { path: `${FOLDER}/a.2160p.mkv`, name: 'a.2160p.mkv', size: 60, known: false, class: '4K' },
        { path: `${FOLDER}/b.2160p.mkv`, name: 'b.2160p.mkv', size: 40, known: true, class: '4K' },
        { path: `${FOLDER}/c.1080p.mkv`, name: 'c.1080p.mkv', size: 30, known: false, class: '1080' },
        { path: `${FOLDER}/d.1080p.mkv`, name: 'd.1080p.mkv', size: 20, known: true, class: '1080' },
      ],
    }
    mockFetch((url) => (isWalk(url)
      ? ({ ok: true, json: async () => ({ groups: [twoClasses], total: 1, radarr: true }) } as Response)
      : undefined))
    renderPage()
    fireEvent.click(screen.getByText('Buscar duplicados'))

    await screen.findByText('Now You See Me')
    expect(document.querySelectorAll('.duplicados-group')).toHaveLength(1)
    expect(screen.getByText(/1 título con duplicados · 4 copias/)).toBeTruthy()
    // La clase de cada copia, al lado de su fichero (las insignias del grupo
    // dicen qué clases se repiten, no cuántas copias hay de cada una).
    const labels = [...document.querySelectorAll('.duplicados-class')].map((n) => n.textContent)
    expect(labels).toEqual(['4K', '4K', '1080', '1080'])
  })
})

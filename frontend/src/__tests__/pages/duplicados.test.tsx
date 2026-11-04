import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Duplicados from '../../pages/Duplicados'
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
  class: '1080',
  title: 'Now You See Me',
  files: [
    { path: `${FOLDER}/${WEBDL}`, name: WEBDL, size: 2_300_000_000, known: false },
    { path: `${FOLDER}/${WEBRIP}`, name: WEBRIP, size: 2_100_000_000, known: true },
  ],
  reclaimable: 2_300_000_000,
}

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
    if (String(url).endsWith('/api/movies/duplicates')) {
      return { ok: true, json: async () => ({ groups: [GROUP], total: 1 }) } as Response
    }
    return { ok: true, json: async () => ({ deleted: `${FOLDER}/${WEBDL}` }) } as Response
  }))
}

beforeEach(() => mockFetch())
afterEach(() => vi.unstubAllGlobals())

describe('Duplicados', () => {
  it('never walks the library on mount: the button is the trigger', () => {
    render(<Duplicados />)

    expect(screen.getByText(/pulsa «Buscar duplicados»/)).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('lists both files of the folder, marks which one Radarr knows', async () => {
    render(<Duplicados />)
    fireEvent.click(screen.getByText('Buscar duplicados'))

    await screen.findByText('Now You See Me')
    expect(screen.getByText(WEBRIP)).toBeTruthy()
    expect(screen.getByText(WEBDL)).toBeTruthy()
    expect(screen.getByText('Radarr')).toBeTruthy()
    expect(screen.getByText('sobra')).toBeTruthy()
    expect(screen.getByText(/1 carpeta · 2\.1 GB reclamables/)).toBeTruthy()
  })

  it('warns when you are about to delete the file Radarr tracks', async () => {
    render(<Duplicados />)
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
    render(<Duplicados />)
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
    render(<Duplicados />)
    fireEvent.click(screen.getByText('Buscar duplicados'))
    await screen.findByText('Now You See Me')

    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Sí, borrar'))

    await waitFor(() => expect(screen.getByText(/Ninguna carpeta repite fichero/)).toBeTruthy())
    expect(calls.filter((c) => c.url.endsWith('/api/movies/duplicates'))).toHaveLength(1)
  })

  it('shows the reason when the backend refuses to delete', async () => {
    mockFetch((url) => (url.includes('/delete')
      ? ({ ok: false, json: async () => ({ detail: 'fuera de las carpetas permitidas: /etc/passwd' }) } as Response)
      : undefined))
    render(<Duplicados />)
    fireEvent.click(screen.getByText('Buscar duplicados'))
    await screen.findByText('Now You See Me')

    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Sí, borrar'))

    expect((await screen.findByRole('alert')).textContent).toContain('fuera de las carpetas permitidas')
  })

  it('sends the stored key on both requests, like every other section', async () => {
    setApiKey('clave-de-prueba')
    render(<Duplicados />)
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
    render(<Duplicados />)
    fireEvent.click(screen.getByText('Buscar duplicados'))

    expect(await screen.findByText(/Ninguna carpeta repite fichero/)).toBeTruthy()
  })
})

describe('Duplicados con Radarr caído', () => {
  it('marks nothing as extra and says so, instead of inviting the wrong delete', async () => {
    mockFetch((url) => (url.endsWith('/api/movies/duplicates')
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
    render(<Duplicados />)
    fireEvent.click(screen.getByText('Buscar duplicados'))

    await screen.findByText('Now You See Me')
    expect(screen.getAllByText('sin datos')).toHaveLength(2)
    expect(screen.queryByText('sobra')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Radarr no respondió')
    // Sin datos no hay cifra que prometer.
    expect(screen.queryByText(/reclamables/)).toBeNull()
  })
})

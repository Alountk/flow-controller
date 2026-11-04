import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Duplicados from '../../pages/Duplicados'
import { setApiKey } from '../../shared/api/auth'

/** jsdom no calcula layout ni habla HTTP: se finge el transporte, no la pantalla. */
const GROUP = {
  tmdb_id: 438631,
  class: '1080',
  titles: ['Dune', 'Дюна'],
  files: [
    { path: '/media/a/Dune.2021.1080p.mkv', size: 3_100_000_000, quality: 'Bluray-1080p', title: 'Dune' },
    { path: '/media/b/Dune.2021.1080p.mkv', size: 900_000_000, quality: 'WEBDL-1080p', title: 'Dune' },
  ],
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
    return { ok: true, json: async () => ({ deleted: '/media/a/Dune.2021.1080p.mkv' }) } as Response
  }))
}

beforeEach(() => mockFetch())
afterEach(() => vi.unstubAllGlobals())

describe('Duplicados', () => {
  it('lists each file of the group with its size and the other titles', async () => {
    render(<Duplicados />)

    await screen.findByText('Dune')
    expect(screen.getByText('/media/a/Dune.2021.1080p.mkv')).toBeTruthy()
    expect(screen.getByText('/media/b/Dune.2021.1080p.mkv')).toBeTruthy()
    expect(screen.getByText('2.9 GB')).toBeTruthy()
    expect(screen.getByText('Дюна')).toBeTruthy()
  })

  it('asks before deleting and does not call the API until confirmed', async () => {
    render(<Duplicados />)

    await screen.findByText('Dune')
    fireEvent.click(screen.getAllByText('Borrar')[0])

    expect(screen.getByText('¿Borrar este fichero?')).toBeTruthy()
    expect(calls.filter((c) => c.url.includes('/delete'))).toHaveLength(0)

    fireEvent.click(screen.getByText('Sí, borrar'))
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/delete'))).toBe(true)
    })
    expect(calls.find((c) => c.url.includes('/delete'))?.body).toEqual({
      path: '/media/a/Dune.2021.1080p.mkv',
    })
  })

  it('cancel closes the confirmation without deleting', async () => {
    render(<Duplicados />)

    await screen.findByText('Dune')
    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Cancelar'))

    expect(screen.queryByText('¿Borrar este fichero?')).toBeNull()
    expect(calls.filter((c) => c.url.includes('/delete'))).toHaveLength(0)
  })

  it('shows the reason when the backend refuses to delete', async () => {
    mockFetch((url) =>
      url.includes('/delete')
        ? ({ ok: false, json: async () => ({ detail: 'fuera de las carpetas permitidas: /etc/passwd' }) } as Response)
        : undefined,
    )
    render(<Duplicados />)

    await screen.findByText('Dune')
    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Sí, borrar'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('fuera de las carpetas permitidas')
  })

  it('says so when there is nothing to show', async () => {
    mockFetch((url) =>
      url.endsWith('/api/movies/duplicates')
        ? ({ ok: true, json: async () => ({ groups: [], total: 0 }) } as Response)
        : undefined,
    )
    render(<Duplicados />)

    expect(await screen.findByText(/Ningún duplicado/)).toBeTruthy()
  })
})

describe('Duplicados con un backend que no es el esperado', () => {
  it('does not crash when the payload has no groups (old backend, proxy HTML)', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ detail: 'Not Found' }) } as Response))
    render(<Duplicados />)

    expect(await screen.findByText(/Ningún duplicado/)).toBeTruthy()
  })
})

describe('Duplicados y la API key', () => {
  it('sends the stored key on both requests, like every other section', async () => {
    // El 401 en producción: esta pantalla usaba `fetch` a mano y no pasaba por
    // `apiFetch`, así que la clave no viajaba. Las demás secciones sí.
    setApiKey('clave-de-prueba')
    render(<Duplicados />)

    await screen.findByText('Dune')
    fireEvent.click(screen.getAllByText('Borrar')[0])
    fireEvent.click(screen.getByText('Sí, borrar'))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/delete'))).toBe(true))

    const headers = calls.map((c) => (c.init?.headers ?? {}) as Record<string, string>)
    expect(headers.every((h) => h['X-Api-Key'] === 'clave-de-prueba')).toBe(true)
  })
})

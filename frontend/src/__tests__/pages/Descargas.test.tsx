import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Descargas from '../../pages/Descargas.tsx'
import { Sidebar } from '../../app/Sidebar.tsx'
import { PAGE_PATHS } from '../../shared/hooks/usePageRoute.ts'
import { clearToasts, getToasts } from '../../shared/utils/toast.ts'
import type { AmuleDownloadRow } from '../../shared/types.ts'

/** Una fila de aMule realista; cada test anula sólo lo que le importa. */
function row(overrides: Partial<AmuleDownloadRow> = {}): AmuleDownloadRow {
  return {
    source: 'amule',
    hash: 'A1B2C3D4',
    name: 'Debian-12.iso',
    size_full: 4 * 1024 ** 3,
    size_done: 1024 ** 3,
    progress_pct: 25.5,
    speed: 512 * 1024,
    eta_seconds: 45,
    state: 'downloading',
    stopped: false,
    status_code: 2,
    priority: 1,
    category: 0,
    sources: 12,
    ed2k_link: 'ed2k://|file|Debian-12.iso|0|A1B2C3D4|/',
    ...overrides,
  }
}

const CATEGORIES: Record<string, number> = { Películas: 0, Series: 1 }

interface Call {
  url: string
  method: string
  body?: unknown
}

let calls: Call[] = []

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

interface Handlers {
  categories?: unknown
  action?: (action: string, body: unknown) => unknown
}

function mockFetch(downloadsBody: unknown, handlers: Handlers = {}) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (url === '/api/amule/downloads') return ok(downloadsBody)
      if (url === '/api/amule/categories') {
        return ok(handlers.categories ?? { ok: true, categories: CATEGORIES })
      }
      const action = url.match(/^\/api\/amule\/downloads\/(\w+)$/)?.[1]
      if (action) return ok(handlers.action?.(action, body) ?? { ok: true, detail: 'Hecho' })
      return ok({})
    }),
  )
}

function renderPage(downloadsBody: unknown, handlers: Handlers = {}) {
  mockFetch(downloadsBody, handlers)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Descargas />
    </QueryClientProvider>,
  )
}

function envelope(downloads: AmuleDownloadRow[]): unknown {
  return { ok: true, downloads, detail: `${downloads.length} descargas` }
}

function posted(action: string): Call | undefined {
  return calls.find((c) => c.url === `/api/amule/downloads/${action}`)
}

beforeEach(() => {
  clearToasts()
})
afterEach(() => {
  vi.unstubAllGlobals()
  clearToasts()
})

describe('Descargas (T3)', () => {
  it('pinta cada fila con su chip de estado y el código crudo en el título', async () => {
    renderPage(
      envelope([
        row(),
        row({ hash: 'BBBB', name: 'Pausada.mkv', state: 'paused', stopped: true, status_code: 7 }),
        row({ hash: 'CCCC', name: 'Completa.mkv', state: 'completed', status_code: 0 }),
        row({ hash: 'DDDD', name: 'Espera.mkv', state: 'waiting', status_code: 1 }),
      ]),
    )

    expect(await screen.findByText('Descargando')).toBeInTheDocument()
    expect(screen.getByText('En pausa')).toBeInTheDocument()
    expect(screen.getByText('Completada')).toBeInTheDocument()
    expect(screen.getByText('En espera')).toBeInTheDocument()

    // El chip pinta `state`; el código crudo viaja en el title, sin interpretar.
    expect(screen.getByText('Descargando')).toHaveAttribute('title', '2')
    expect(screen.getByText('En pausa')).toHaveAttribute('title', '7')
  })

  it('muestra los valores de la fila con los formatos de la casa', async () => {
    renderPage(envelope([row()]))

    expect(await screen.findByText('Debian-12.iso')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25.5')
    expect(screen.getByText('25.5%')).toBeInTheDocument()
    expect(screen.getByText('512 KB/s')).toBeInTheDocument()
    expect(screen.getByText('45 s')).toBeInTheDocument()
    expect(screen.getByText('1.0 GB / 4.0 GB')).toBeInTheDocument()
    expect(screen.getByText('12 fuentes')).toBeInTheDocument()
    // Índice 0 → título del endpoint, pintado en el chip (no en el option del select).
    expect(document.querySelector('.dl-category')).toHaveTextContent('Películas')
  })

  it('sin categoría (null) no pinta chip de categoría', async () => {
    renderPage(envelope([row({ category: null })]))

    await screen.findByText('Debian-12.iso')
    expect(document.querySelector('.dl-category')).toBeNull()
  })

  it('sólo pide a aMule: nada de qBittorrent todavía (S4)', async () => {
    renderPage(envelope([row()]))

    await screen.findByText('Debian-12.iso')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.url.startsWith('/api/amule/'))).toBe(true)
  })

  it('pausar publica el cuerpo correcto', async () => {
    renderPage(envelope([row()]))

    fireEvent.click(await screen.findByRole('button', { name: 'Pausar' }))

    await waitFor(() => expect(posted('pause')).toBeDefined())
    expect(posted('pause')?.method).toBe('POST')
    expect(posted('pause')?.body).toEqual({ file_hash: 'A1B2C3D4' })
  })

  it('continuar en una fila en pausa publica el cuerpo correcto', async () => {
    renderPage(envelope([row({ state: 'paused', stopped: true })]))

    fireEvent.click(await screen.findByRole('button', { name: 'Continuar' }))

    await waitFor(() => expect(posted('resume')).toBeDefined())
    expect(posted('resume')?.method).toBe('POST')
    expect(posted('resume')?.body).toEqual({ file_hash: 'A1B2C3D4' })
  })

  it('el selector de prioridad publica el índice elegido, con etiquetas en español', async () => {
    renderPage(envelope([row()]))

    const select = (await screen.findByLabelText('Prioridad')) as HTMLSelectElement
    expect([...select.options].map((o) => o.text)).toEqual([
      'Muy baja',
      'Baja',
      'Normal',
      'Alta',
      'Muy alta',
      'Auto',
      'Release',
    ])

    fireEvent.change(select, { target: { value: '3' } })

    await waitFor(() => expect(posted('priority')).toBeDefined())
    expect(posted('priority')?.body).toEqual({ file_hash: 'A1B2C3D4', priority: 3 })
  })

  it('el selector de categoría se llena del endpoint y publica el índice elegido', async () => {
    renderPage(envelope([row({ category: 0 })]))

    const select = (await screen.findByLabelText('Categoría')) as HTMLSelectElement
    expect([...select.options].map((o) => o.text)).toEqual(['Películas', 'Series'])

    fireEvent.change(select, { target: { value: '1' } })

    await waitFor(() => expect(posted('category')).toBeDefined())
    expect(posted('category')?.body).toEqual({ file_hash: 'A1B2C3D4', category: 1 })
  })

  it('borrar avisa de que la descarga sale de aMule y cancelar no publica nada', async () => {
    renderPage(envelope([row()]))

    fireEvent.click(await screen.findByRole('button', { name: 'Borrar' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(/quitará de la cola de aMule/)

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('borrar sin marcar la casilla manda delete_files: false', async () => {
    renderPage(envelope([row()]))

    fireEvent.click(await screen.findByRole('button', { name: 'Borrar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }))

    await waitFor(() => expect(posted('delete')).toBeDefined())
    expect(posted('delete')?.body).toEqual({ file_hash: 'A1B2C3D4', delete_files: false })
  })

  it('delete_files: true sólo sale con la casilla marcada', async () => {
    renderPage(envelope([row()]))

    fireEvent.click(await screen.findByRole('button', { name: 'Borrar' }))
    fireEvent.click(screen.getByLabelText('Borrar también los ficheros descargados'))
    fireEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }))

    await waitFor(() => expect(posted('delete')).toBeDefined())
    expect(posted('delete')?.body).toEqual({ file_hash: 'A1B2C3D4', delete_files: true })
  })

  it('una negativa del servidor (SAFE_MODE) se muestra una sola vez, como aviso', async () => {
    const detail = 'SAFE_MODE activo: el borrado está bloqueado'
    renderPage(envelope([row()]), { action: () => ({ ok: false, detail }) })

    fireEvent.click(await screen.findByRole('button', { name: 'Borrar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }))

    await waitFor(() => expect(getToasts().some((t) => t.message === detail)).toBe(true))
    // Una sola copia: el detalle vive en el aviso, la página no lo repite.
    expect(screen.queryByText(detail)).not.toBeInTheDocument()
  })

  it('ok: false muestra el detalle del servidor y lo deja a la vista', async () => {
    renderPage({ ok: false, detail: 'aMule no está configurado' })

    expect(await screen.findByText('aMule no está configurado')).toBeInTheDocument()
    expect(screen.getByText('aMule no está configurado')).toHaveAttribute('role', 'alert')
  })

  it('cola vacía: «No hay descargas en aMule»', async () => {
    renderPage(envelope([]))

    expect(await screen.findByText('No hay descargas en aMule')).toBeInTheDocument()
  })
})

describe('Descargas · navegación (S1)', () => {
  it('vive en /descargas y el Sidebar la lista justo tras Seguimiento', () => {
    expect(PAGE_PATHS.descargas).toBe('/descargas')

    const { container } = render(
      <Sidebar active="dashboard" onNavigate={() => {}} developer={false} />,
    )
    expect(screen.getByText('Descargas')).toBeInTheDocument()
    expect(screen.getByText('Descargas').closest('a')).toHaveAttribute('href', '/descargas')

    const names = [...container.querySelectorAll('.sb-link')].map((a) => a.textContent ?? '')
    const seguimiento = names.findIndex((n) => n.includes('Seguimiento'))
    expect(seguimiento).toBeGreaterThanOrEqual(0)
    expect(names[seguimiento + 1]).toContain('Descargas')
  })
})

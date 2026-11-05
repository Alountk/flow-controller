import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Renombrar } from '../../pages/Renombrar.tsx'
import type { RenameCandidate } from '../../shared/api/files.ts'

/**
 * S1, S3, S6 y S7 de `odd/tasks/renombrar-registro-y-manual.md`.
 *
 * Lo que se fija aquí es la pantalla que el usuario ve: dos vistas con sus
 * contadores, el par nombre viejo / nombre nuevo, una copia sin propuesta que NO
 * desaparece, y el registro de lo ya hecho — que es lo único que distingue «se
 * renombró» de «nunca estuvo».
 */

const FOUR_K = '/mnt/4k'

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function candidate(over: Partial<RenameCandidate> = {}): RenameCandidate {
  return {
    ok: true,
    detail: '',
    src: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
    loose: true,
    named: true,
    folder: 'The Batman (2022)',
    // El backend propone el TALLO; la extensión viaja aparte y se añade al pintar.
    name: 'The Batman (2022) [Bluray-2160p][HDR]',
    extension: '.mkv',
    sidecars: [],
    warnings: [],
    movie: { id: 7, title: 'The Batman', year: 2022 },
    ...over,
  }
}

const DUNE = candidate({
  src: `${FOUR_K}/Dune.2021.2160p.mkv`,
  name: 'Dune - Parte Dos (2024) [Bluray-2160p]',
  folder: 'Dune Parte Dos (2024)',
  movie: { id: 9, title: 'Dune: Parte Dos', year: 2024 },
})

const NO_PROPOSAL = candidate({
  src: `${FOUR_K}/Gravity.2013.mkv`,
  ok: false,
  named: false,
  movie: null,
  folder: '',
  name: '',
  warnings: ['la plantilla necesita la duración y no se pudo medir el fichero'],
})

interface Mock {
  applied: Record<string, unknown>[]
}

function stub(items: RenameCandidate[], log: unknown[] = []): Mock {
  const applied: Record<string, unknown>[] = []
  const mock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/files/rename-candidates')) {
      return ok({ ok: true, items, scanned: items.length, detail: '' })
    }
    if (url.includes('/api/files/renames')) return ok({ ok: true, items: log })
    if (url.includes('/api/files/rename-apply')) {
      applied.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ok({ ok: true, detail: 'Renombrado', moved: [] })
    }
    if (url.includes('/api/files/roots')) {
      return ok({
        roots: [{ path: FOUR_K, name: '4k', role: '4k', label: '4K · 2160p' }],
        detail: '',
      })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', mock)
  return { applied }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Renombrar />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Renombrar · dos vistas (S1)', () => {
  it('draws both chips with their counts', async () => {
    stub([candidate(), DUNE], [
      { src: '/a/viejo.mkv', dst: '/a/nuevo.mkv', movie_id: 7, origin: 'lote', renamed_at: 1, exists: true },
    ])
    renderPage()

    const tabs = await screen.findByRole('tablist', { name: 'Vistas de renombrado' })
    await waitFor(() =>
      expect(within(tabs).getByRole('tab', { name: /Candidatos 2/ })).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(within(tabs).getByRole('tab', { name: /Renombrados 1/ })).toBeInTheDocument(),
    )
    expect(within(tabs).getByRole('tab', { name: /Candidatos 2/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('shows the current name above the proposed one, with its folder and class', async () => {
    stub([candidate()])
    renderPage()

    expect(await screen.findByText('The.Batman.2022.2160p.mkv')).toBeInTheDocument()
    expect(screen.getByText('The Batman (2022) [Bluray-2160p][HDR].mkv')).toBeInTheDocument()
    expect(screen.getByTitle(`${FOUR_K}/The Batman (2022)`)).toBeInTheDocument()
    expect(screen.getByText('4K')).toBeInTheDocument()
  })

  it('keeps a copy with no proposal in the table, marked Revisar with its reason (S6)', async () => {
    stub([NO_PROPOSAL])
    renderPage()

    expect(await screen.findByText('Gravity.2013.mkv')).toBeInTheDocument()
    expect(screen.getByText('Revisar')).toBeInTheDocument()
    expect(
      screen.getByText('la plantilla necesita la duración y no se pudo medir el fichero'),
    ).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('sends only the rows that still have a proposal, in batch (S6)', async () => {
    const mock = stub([candidate(), DUNE, NO_PROPOSAL])
    renderPage()

    await screen.findByText('The.Batman.2022.2160p.mkv')
    expect(screen.getByRole('button', { name: 'Aplicar 2 cambios' })).toBeEnabled()

    // Omitting is the comfortable button, so it has to actually remove the row
    // from the batch — and say the new count.
    fireEvent.click(screen.getAllByRole('button', { name: 'Omitir' })[0])
    expect(screen.getByRole('button', { name: 'Aplicar 1 cambio' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Aplicar 1 cambio' }))
    await waitFor(() => expect(mock.applied).toHaveLength(1))
    expect(mock.applied[0]).toMatchObject({ remote_path: DUNE.src, origin: 'lote', movie_id: 9 })
  })
})

describe('Renombrar · la vista Renombrados (S3, S7)', () => {
  const log = [
    {
      src: '/mnt/4k/Dune.2021.2160p.mkv',
      dst: '/mnt/4k/Dune Parte Dos (2024)/Dune - Parte Dos (2024) [Bluray-2160p].mkv',
      movie_id: 9,
      origin: 'lote',
      renamed_at: 1_790_000_000,
      exists: true,
    },
    {
      src: '/movies/Heat (1995)/heat.mkv',
      dst: '/movies/Heat (1995)/Heat (1995) [Bluray-1080p].mkv',
      movie_id: 949,
      origin: 'a mano',
      renamed_at: 1_789_000_000,
      exists: false,
    },
  ]

  it('lists what was renamed, its previous name, its origin and when', async () => {
    stub([], log)
    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: /Renombrados/ }))

    expect(await screen.findByText('Dune - Parte Dos (2024) [Bluray-2160p].mkv')).toBeInTheDocument()
    expect(screen.getByText('Dune.2021.2160p.mkv')).toBeInTheDocument()
    expect(screen.getByText('lote')).toBeInTheDocument()
    expect(screen.getByText('a mano')).toBeInTheDocument()
    expect(screen.getByText(/2 copias renombradas · la última hace/)).toBeInTheDocument()
  })

  it('says the file is gone instead of offering a folder that is not there', async () => {
    stub([], log)
    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: /Renombrados/ }))

    expect(await screen.findByText('El fichero ya no está')).toBeInTheDocument()
  })

  it('opens the folder in Archivos instead of only naming it', async () => {
    stub([], log)
    window.history.replaceState(null, '', '/renombrar')
    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: /Renombrados/ }))

    const open = await screen.findByRole('button', { name: '/mnt/4k/Dune Parte Dos (2024)' })
    fireEvent.click(open)

    // El enlace lleva la carpeta dentro: el explorador tiene que abrir EN ella.
    expect(window.location.pathname).toBe('/archivos')
    const hash = window.location.hash.replace(/^#\/?/, '')
    const params = new URLSearchParams(hash.split('?')[1] ?? '')
    expect(params.get('path')).toBe('/mnt/4k/Dune Parte Dos (2024)')

    // La fila cuyo fichero ya no existe sigue sin ofrecer una carpeta.
    expect(screen.queryByRole('button', { name: /Heat/ })).toBeNull()
  })

  it('has nothing to select: this view only reports', async () => {
    stub([], log)
    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: /Renombrados/ }))
    await screen.findByText('lote')

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('says so when nothing has been renamed yet', async () => {
    stub([], [])
    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: /Renombrados/ }))

    expect(await screen.findByText('Todavía no se ha renombrado nada.')).toBeInTheDocument()
  })
})

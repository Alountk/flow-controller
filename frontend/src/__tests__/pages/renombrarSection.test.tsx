import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Renombrar } from '../../pages/Renombrar.tsx'
import { FileManager } from '../../features/file-manager/FileManager.tsx'
import type { RenameCandidate } from '../../shared/api/files.ts'
import type { RootsResponse } from '../../shared/types.ts'

/**
 * The «Renombrar» section (S1–S5 of `odd/tasks/renombrar-seccion.md`).
 *
 * These are the tests that used to guard the explorer's `🏷` action. That
 * action is gone on purpose — the section is now the only place a 4K/3D copy is
 * renamed — so what they guard moved with it: the pair is shown before anything
 * moves, a copy nobody could identify is never batch-applied, and what reaches
 * `/api/files/rename-apply` is exactly what the user saw or edited.
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
    name: 'The Batman (2022) Remux-2160p',
    extension: '.mkv',
    sidecars: [{ from: 'The.Batman.2022.2160p.srt', to: 'The Batman (2022) Remux-2160p.srt' }],
    warnings: [],
    movie: { id: 7, title: 'The Batman', year: 2022 },
    ...over,
  }
}

interface Mock {
  applied: Record<string, unknown>[]
  previews: string[]
}

function mockFetch(options: {
  items?: RenameCandidate[]
  detail?: string
  apply?: { ok: boolean; detail: string; moved?: { from: string; to: string }[] }
} = {}): Mock {
  const applied: Record<string, unknown>[] = []
  const previews: string[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/files/rename-candidates')) {
      return ok({
        ok: true,
        items: options.items ?? [candidate()],
        scanned: 1,
        detail: options.detail ?? '',
      })
    }
    if (url.includes('/api/files/rename-preview')) {
      previews.push(url)
      // A movie picked by hand arrives with its id and gets the pattern applied.
      if (url.includes('movie_id=9')) {
        return ok({
          ...candidate(),
          ok: true,
          detail: '',
          folder: 'Batman Begins (2005)',
          name: 'Batman Begins (2005) Bluray-2160p',
          movie: { id: 9, title: 'Batman Begins', year: 2005 },
          warnings: [],
        })
      }
      return ok({ ...candidate(), ok: true, detail: '' })
    }
    if (url.includes('/api/files/rename-movies')) {
      return ok({
        ok: true,
        detail: '',
        items: [
          { id: 7, title: 'The Batman', year: 2022, folder: 'The Batman (2022)' },
          { id: 9, title: 'Batman Begins', year: 2005, folder: 'Batman Begins (2005)' },
        ],
      })
    }
    if (url.includes('/api/files/rename-apply')) {
      applied.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ok(options.apply ?? { ok: true, detail: 'Renombrado', moved: [] })
    }
    if (url.includes('/api/files/roots')) {
      const roots: RootsResponse['roots'] = [
        { path: FOUR_K, name: '4k', role: '4k', label: '4K · 2160p' },
      ]
      return ok({ roots, detail: '' })
    }
    if (url.includes('/api/files/browse')) {
      return ok({
        ok: true,
        path: FOUR_K,
        items: [
          {
            name: 'The.Batman.2022.2160p.mkv',
            path: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
            is_dir: false,
            is_video: true,
            size: 1,
            modified: 0,
          },
        ],
      })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return { applied, previews }
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Renombrar />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('la sección Renombrar', () => {
  it('shows the pair — what it is now and what it would become — before applying', async () => {
    mockFetch()
    renderSection()

    expect(await screen.findByText('The.Batman.2022.2160p.mkv')).toBeTruthy()
    expect(
      screen.getByText('The Batman (2022) Remux-2160p.mkv'),
    ).toBeTruthy()
    expect(screen.getByText(/También: The\.Batman\.2022\.2160p\.srt/)).toBeTruthy()
  })

  it('applies the folder only when the copy is loose, and the name the row showed', async () => {
    const mock = mockFetch({
      items: [
        candidate(),
        candidate({
          src: `${FOUR_K}/Dune (2021)/Dune.Part.Two.2024.mkv`,
          loose: false,
          folder: '',
          name: 'Dune: Parte dos (2024) 2160p',
          sidecars: [],
          movie: { id: 9, title: 'Dune: Parte dos', year: 2024 },
        }),
      ],
    })
    renderSection()

    await screen.findByText('The.Batman.2022.2160p.mkv')
    fireEvent.click(screen.getByRole('button', { name: /Aplicar 2 cambio/ }))

    await waitFor(() => expect(mock.applied).toHaveLength(2))
    expect(mock.applied[0]).toEqual({
      remote_path: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
      folder: 'The Batman (2022)',
      name: 'The Batman (2022) Remux-2160p',
      origin: 'lote',
      movie_id: 7,
    })
    // Inside a folder the folder field travels empty: it is not renamed.
    expect(mock.applied[1]).toEqual({
      remote_path: `${FOUR_K}/Dune (2021)/Dune.Part.Two.2024.mkv`,
      folder: '',
      name: 'Dune: Parte dos (2024) 2160p',
      origin: 'lote',
      movie_id: 9,
    })
  })

  it('never batch-applies a copy nobody could identify', async () => {
    const mock = mockFetch({
      items: [
        candidate({
          name: 'Mystery.Film.1999.2160p',
          folder: '',
          sidecars: [],
          warnings: ['no coincide ninguna película del catálogo con el nombre del archivo'],
          movie: null,
        }),
      ],
    })
    renderSection()

    const checkbox = (await screen.findByRole('checkbox', {
      name: `Seleccionar ${FOUR_K}/The.Batman.2022.2160p.mkv`,
    })) as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(checkbox.checked).toBe(false)
    expect(screen.getByText(/no coincide ninguna película/)).toBeTruthy()
    // Nothing selected ⇒ the batch button cannot move anything.
    expect(screen.getByRole('button', { name: /Aplicar 0 cambio/ })).toBeDisabled()
    expect(mock.applied).toHaveLength(0)
  })

  it('never batch-applies a copy the template could not name', async () => {
    // Reported from the real instance: the folder appeared, the file kept its
    // scene name, and the run read as a failure. No name, no plan.
    const mock = mockFetch({
      items: [
        candidate(),
        candidate({
          src: `${FOUR_K}/Dune.2021.2160p.mkv`,
          named: false,
          folder: '',
          name: 'Dune.2021.2160p',
          sidecars: [],
          warnings: ['la plantilla de Radarr no se pudo reproducir con el archivo de esa película'],
        }),
      ],
    })
    renderSection()

    await screen.findByText('The.Batman.2022.2160p.mkv')
    expect(screen.getByRole('button', { name: /Aplicar 1 cambio/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Aplicar 1 cambio/ }))

    await waitFor(() => expect(mock.applied).toHaveLength(1))
    expect(mock.applied[0]).toEqual({
      remote_path: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
      folder: 'The Batman (2022)',
      name: 'The Batman (2022) Remux-2160p',
      origin: 'lote',
      movie_id: 7,
    })
  })

  it('says so when a move only filed the copy without renaming it', async () => {
    mockFetch({
      apply: {
        ok: true,
        detail: 'Renombrado',
        moved: [{ from: `${FOUR_K}/Dune.2021.mkv`, to: `${FOUR_K}/Dune (2021)/Dune.2021.mkv` }],
      },
    })
    renderSection()

    await screen.findByText('The.Batman.2022.2160p.mkv')
    fireEvent.click(screen.getByRole('button', { name: /Aplicar 1 cambio/ }))

    expect(await screen.findByText(/solo se movió a su carpeta/)).toBeTruthy()
  })

  it('says why it has nothing to list instead of showing an empty library', async () => {
    mockFetch({
      items: [],
      detail:
        'Radarr no está configurado o su catálogo está vacío: sin identificar las películas no se propone ningún nombre',
    })
    renderSection()

    expect(await screen.findByText(/Radarr no está configurado/)).toBeTruthy()
  })

  it('reports every moved file so the rename can be undone by hand', async () => {
    mockFetch({
      apply: {
        ok: true,
        detail: 'Renombrado',
        moved: [
          {
            from: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
            to: `${FOUR_K}/The Batman (2022)/The Batman (2022) Remux-2160p.mkv`,
          },
        ],
      } as never,
    })
    renderSection()

    await screen.findByText('The.Batman.2022.2160p.mkv')
    fireEvent.click(screen.getByRole('button', { name: /Aplicar 1 cambio/ }))

    expect(await screen.findByText(/The Batman \(2022\) Remux-2160p\.mkv/)).toBeTruthy()
  })

  it("applies edits made in the dialog, and keeps the backend's own words on refusal", async () => {
    const mock = mockFetch({
      apply: { ok: false, detail: 'Ya existe Taken.mkv: no se sobreescribe' },
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    const nameField = (await screen.findByLabelText('Nombre del archivo')) as HTMLInputElement
    await waitFor(() => expect(nameField.value).toBe('The Batman (2022) Remux-2160p'))

    fireEvent.change(nameField, { target: { value: 'The Batman (2022) 2160p' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(mock.applied).toHaveLength(1))
    expect(mock.applied[0]).toEqual({
      remote_path: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
      folder: 'The Batman (2022)',
      name: 'The Batman (2022) 2160p',
      origin: 'lote',
      movie_id: 7,
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no se sobreescribe')
    expect(screen.getByRole('dialog', { name: 'Renombrar como Radarr' })).toBeTruthy()
  })
})

describe('elegir la película a mano', () => {
  it('names a copy the filename alone could not identify', async () => {
    // Reported from the instance: the row said «Película sin identificar» and
    // there was nothing to apply. Naming the film is the missing proof.
    const mock = mockFetch({
      items: [
        candidate({
          named: false,
          folder: '',
          name: 'The.Batman.2022.2160p',
          movie: null,
          warnings: ['no coincide ninguna película del catálogo con el nombre del archivo'],
        }),
      ],
    })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    expect(await screen.findByText('Película sin identificar')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Elegir película' }))
    fireEvent.change(screen.getByLabelText('Buscar película'), { target: { value: 'batman' } })

    // Two rows: The Batman (the copy's own film) and Batman Begins.
    const picks = await screen.findAllByRole('button', { name: /Batman Begins/ })
    fireEvent.click(picks[0])

    await waitFor(() =>
      expect((screen.getByLabelText('Nombre del archivo') as HTMLInputElement).value).toBe(
        'Batman Begins (2005) Bluray-2160p',
      ),
    )
    expect((screen.getByLabelText('Carpeta') as HTMLInputElement).value).toBe(
      'Batman Begins (2005)',
    )
    expect(mock.previews.at(-1)).toContain('movie_id=9')
    expect(screen.getByText('Batman Begins (2005)')).toBeTruthy()
  })

  it('does not search the catalog until the person asks for it', async () => {
    const mock = mockFetch()
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    await screen.findByRole('dialog', { name: 'Renombrar como Radarr' })

    expect(mock.previews.some((url) => url.includes('movie_id='))).toBe(false)
    expect(screen.queryByLabelText('Buscar película')).toBeNull()
  })
})

describe('el explorador renombra un fichero elegido a mano', () => {
  /**
   * S4 de `odd/tasks/renombrar-registro-y-manual.md` SUSTITUYE la regla de
   * `renombrar-seccion.md` que quitó esta acción del explorador. Sigue sin haber
   * dos puertas con reglas distintas: es el MISMO diálogo y el mismo endpoint;
   * lo que cambia es que ahora se puede empezar por el fichero que ves.
   */
  it('offers the Radarr action on a video row and opens the same dialog', async () => {
    const mock = mockFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <FileManager />
      </QueryClientProvider>,
    )

    expect(await screen.findAllByText('The.Batman.2022.2160p.mkv')).not.toHaveLength(0)
    fireEvent.click(
      screen.getAllByRole('button', { name: /Renombrar The.Batman.2022.2160p.mkv con la plantilla/ })[0],
    )

    await screen.findByRole('dialog', { name: 'Renombrar como Radarr' })
    expect(mock.previews.at(-1)).toContain('The.Batman.2022.2160p.mkv')
  })

  it('sends the rename as a hand-made one, with the movie it identified', async () => {
    // Sin `origin` la fila diría «lote»: un acto distinto contado igual.
    const mock = mockFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <FileManager />
      </QueryClientProvider>,
    )

    await screen.findAllByText('The.Batman.2022.2160p.mkv')
    fireEvent.click(
      screen.getAllByRole('button', { name: /Renombrar The.Batman.2022.2160p.mkv con la plantilla/ })[0],
    )
    await screen.findByRole('dialog', { name: 'Renombrar como Radarr' })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(mock.applied).toHaveLength(1))
    expect(mock.applied[0]).toMatchObject({ origin: 'a mano', movie_id: 7 })
  })
})

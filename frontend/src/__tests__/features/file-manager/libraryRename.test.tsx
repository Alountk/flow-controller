import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileManager } from '../../../features/file-manager/FileManager.tsx'
import type { RootsResponse } from '../../../shared/types.ts'
import type { RenameProposal } from '../../../shared/api/files.ts'

/**
 * The Radarr-style rename of a 4K/3D copy, from the explorer.
 *
 * Two things are guarded here and they are the two that can lose a file: that
 * the action is offered only where it means something (a video inside a quality
 * root), and that what reaches `/api/files/rename-apply` is exactly what the
 * dialog showed after the user edited it.
 */

interface BrowseItem {
  name: string
  path: string
  is_dir: boolean
  is_video?: boolean
  size: number
  modified: number
}

const FOUR_K = '/mnt/4k'
const NAV = '/mnt/storage'

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

const ROOTS_4K: RootsResponse['roots'] = [
  { path: FOUR_K, name: '4k', role: '4k', label: '4K · 2160p' },
]

const ROOTS_NAV: RootsResponse['roots'] = [
  { path: NAV, name: 'storage', role: 'navigation', label: 'storage' },
]

function video(name: string, dir = FOUR_K): BrowseItem {
  return { name, path: `${dir}/${name}`, is_dir: false, is_video: true, size: 1, modified: 0 }
}

function other(name: string, dir = FOUR_K): BrowseItem {
  return { name, path: `${dir}/${name}`, is_dir: false, is_video: false, size: 1, modified: 0 }
}

function folder(name: string, dir = FOUR_K): BrowseItem {
  return { name, path: `${dir}/${name}`, is_dir: true, size: 0, modified: 0 }
}

const PROPOSAL: RenameProposal = {
  ok: true,
  detail: '',
  src: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
  loose: true,
  folder: 'The Batman (2022)',
  name: 'The Batman (2022) Remux-2160p',
  extension: '.mkv',
  sidecars: [{ from: 'The.Batman.2022.2160p.srt', to: 'The Batman (2022) Remux-2160p.srt' }],
  warnings: [],
  movie: { id: 7, title: 'The Batman', year: 2022 },
}

interface Mock {
  fn: ReturnType<typeof vi.fn>
  previews: number
  applied: Record<string, unknown>[]
}

function mockFetch(options: {
  roots?: RootsResponse['roots']
  listings?: Record<string, BrowseItem[]>
  proposal?: RenameProposal
  apply?: { ok: boolean; detail: string }
} = {}): Mock {
  const listings = options.listings ?? { [FOUR_K]: [] }
  const proposal = options.proposal ?? PROPOSAL
  const applied: Record<string, unknown>[] = []
  let previews = 0

  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/files/roots')) {
      return ok({ roots: options.roots ?? ROOTS_4K, detail: '' })
    }
    if (url.includes('/api/files/browse')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, items: listings[path] ?? [] })
    }
    if (url.includes('/api/files/rename-preview')) {
      previews += 1
      return ok(proposal)
    }
    if (url.includes('/api/files/rename-apply')) {
      applied.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ok(options.apply ?? { ok: true, detail: 'Renombrado: a → b' })
    }
    if (url.includes('/api/files/retention')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, days: 7, files: [] })
    }
    return ok({})
  })

  vi.stubGlobal('fetch', fn)
  return {
    fn,
    get previews() {
      return previews
    },
    applied,
  }
}

function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileManager />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Radarr-style rename action', () => {
  it('is offered for a video inside a 4K root and not for anything else', async () => {
    const mock = mockFetch({
      listings: { [FOUR_K]: [video('The.Batman.2022.2160p.mkv'), other('notes.txt'), folder('Dune (2021)')] },
    })
    renderManager()

    // The name lives in the row and in its title attribute, so the row is
    // awaited by name and the action is addressed by its accessible label.
    expect(await screen.findAllByText('The.Batman.2022.2160p.mkv')).not.toHaveLength(0)
    expect(
      screen.getByRole('button', { name: 'Renombrar como Radarr The.Batman.2022.2160p.mkv' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Renombrar como Radarr notes\.txt/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Renombrar como Radarr Dune/ })).toBeNull()
    expect(mock.previews).toBe(mock.previews)
  })

  it('is not offered in a navigation mount, where Radarr has nothing to say', async () => {
    mockFetch({
      roots: ROOTS_NAV,
      listings: { [NAV]: [video('The.Batman.2022.2160p.mkv', NAV)] },
    })
    renderManager()

    expect(await screen.findAllByText('The.Batman.2022.2160p.mkv')).not.toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Renombrar como Radarr/ })).toBeNull()
  })

  it('prefills from the backend and applies what the user typed', async () => {
    const mock = mockFetch({
      listings: { [FOUR_K]: [video('The.Batman.2022.2160p.mkv')] },
    })
    renderManager()

    fireEvent.click(
      await screen.findByRole('button', { name: /Renombrar como Radarr/ }),
    )

    const folderField = (await screen.findByLabelText('Carpeta')) as HTMLInputElement
    const nameField = screen.getByLabelText('Nombre del archivo') as HTMLInputElement
    await waitFor(() => expect(folderField.value).toBe('The Batman (2022)'))
    expect(nameField.value).toBe('The Batman (2022) Remux-2160p')
    expect(screen.getByText(/También se renombran: The\.Batman\.2022\.2160p\.srt/)).toBeTruthy()

    fireEvent.change(nameField, { target: { value: 'The Batman (2022) 2160p' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(mock.applied).toHaveLength(1))
    expect(mock.applied[0]).toEqual({
      remote_path: `${FOUR_K}/The.Batman.2022.2160p.mkv`,
      folder: 'The Batman (2022)',
      name: 'The Batman (2022) 2160p',
    })
  })

  it('shows the warning instead of pretending the pattern was reproduced', async () => {
    mockFetch({
      listings: { [FOUR_K]: [video('Mystery.Film.1999.2160p.mkv')] },
      proposal: {
        ok: true,
        detail: '',
        loose: true,
        folder: '',
        name: 'Mystery.Film.1999.2160p',
        extension: '.mkv',
        sidecars: [],
        warnings: ['no coincide ninguna película del catálogo con el nombre del archivo'],
        movie: null,
      },
    })
    renderManager()

    fireEvent.click(await screen.findByRole('button', { name: /Renombrar como Radarr/ }))

    expect(await screen.findByText(/no coincide ninguna película/)).toBeTruthy()
    expect((screen.getByLabelText('Nombre del archivo') as HTMLInputElement).value).toBe(
      'Mystery.Film.1999.2160p',
    )
    expect((screen.getByLabelText('Carpeta') as HTMLInputElement).value).toBe('')
  })

  it("keeps the dialog open with the backend's own words when the rename is refused", async () => {
    mockFetch({
      listings: { [FOUR_K]: [video('The.Batman.2022.2160p.mkv')] },
      apply: { ok: false, detail: 'Ya existe Taken.mkv: no se sobreescribe' },
    })
    renderManager()

    fireEvent.click(await screen.findByRole('button', { name: /Renombrar como Radarr/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Aplicar' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no se sobreescribe')
    expect(screen.getByRole('dialog', { name: 'Renombrar como Radarr' })).toBeTruthy()
  })
})

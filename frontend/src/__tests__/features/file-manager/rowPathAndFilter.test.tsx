import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileManager } from '../../../features/file-manager/FileManager.tsx'

/**
 * Two row-level deltas (stitch-delta T2/T3):
 *
 * - each row shows its OWN full path in monospace (the toolbar path answers
 *   "where am I"; this answers "where is this row"), and a row with no path
 *   renders no path cell rather than a fabricated one,
 * - the toolbar can filter the visible rows by name (case-insensitive
 *   substring), with the FilterBar's accessible-name convention.
 *
 * fetch is stubbed at the network boundary, like the other FileManager tests.
 */

interface BrowseItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
}

const file = (name: string, path = `/mnt/storage/${name}`): BrowseItem => ({
  name,
  path,
  is_dir: false,
  size: 1_500_000_000,
  modified: 0,
})

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function mockBrowse(listings: Record<string, BrowseItem[]>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/files/roots')) {
      return ok({
        roots: [{ path: '/mnt/storage', name: 'storage', role: 'navigation', label: 'storage' }],
        detail: '',
      })
    }
    if (url.includes('/api/files/browse')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, items: listings[path] ?? [] })
    }
    if (url.includes('/api/files/retention')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return ok({ ok: true, path, days: 7, files: [] })
    }
    void init
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderFileManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileManager />
    </QueryClientProvider>,
  )
}

/** Drop comments so commented-out CSS cannot satisfy the contract. */
const fileManagerCss = readFileSync('src/features/file-manager/FileManager.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

/** The brace-delimited body of the first rule for `selector`. */
function ruleBody(selector: string): string {
  const match = new RegExp(`(?:^|[\\s}])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).exec(
    fileManagerCss,
  )
  if (!match) return ''
  const open = fileManagerCss.indexOf('{', match.index)
  let depth = 1
  let i = open + 1
  while (i < fileManagerCss.length && depth > 0) {
    if (fileManagerCss[i] === '{') depth++
    else if (fileManagerCss[i] === '}') depth--
    i++
  }
  return fileManagerCss.slice(open + 1, depth === 0 ? i - 1 : i)
}

describe('FileManager row path', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the row’s full path in a monospace cell, drawn from the row’s own data', async () => {
    mockBrowse({ '/mnt/storage': [file('A.mkv')] })
    renderFileManager()
    await screen.findByText('A.mkv')

    const rowPath = document.querySelector('.fm-row-path')
    expect(rowPath).not.toBeNull()
    expect(rowPath!.textContent).toBe('/mnt/storage/A.mkv')
    expect(rowPath!.getAttribute('title')).toBe('/mnt/storage/A.mkv')
    // The C-06 token contract: paths wear `--mono`.
    expect(ruleBody('.fm-row-path')).toMatch(/font-family:\s*var\(--mono\)/)
  })

  it('a row that genuinely has no path renders no path cell', async () => {
    mockBrowse({ '/mnt/storage': [file('B.mkv', '')] })
    renderFileManager()
    await screen.findByText('B.mkv')

    expect(document.querySelector('.fm-row-path')).toBeNull()
  })
})

describe('FileManager name filter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('narrows the visible rows by case-insensitive substring and restores them on clear', async () => {
    mockBrowse({
      '/mnt/storage': [file('Alpha.mkv'), file('Beta.mkv'), file('gamma.txt')],
    })
    renderFileManager()
    await screen.findByText('Alpha.mkv')

    // The FilterBar convention: a search field, Spanish accessible name.
    const filter = screen.getByRole('searchbox', { name: 'Filtrar archivos' })
    expect(filter).toHaveAttribute('placeholder', 'Filtrar archivos...')

    fireEvent.change(filter, { target: { value: 'ALP' } })
    expect(screen.getByText('Alpha.mkv')).toBeInTheDocument()
    expect(screen.queryByText('Beta.mkv')).toBeNull()
    expect(screen.queryByText('gamma.txt')).toBeNull()

    fireEvent.change(filter, { target: { value: '' } })
    expect(screen.getByText('Beta.mkv')).toBeInTheDocument()
    expect(screen.getByText('gamma.txt')).toBeInTheDocument()
  })

  it('an empty result shows the empty-state line instead of a silent blank list', async () => {
    mockBrowse({ '/mnt/storage': [file('Alpha.mkv')] })
    renderFileManager()
    await screen.findByText('Alpha.mkv')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar archivos' }), {
      target: { value: 'zzz' },
    })

    expect(screen.queryByText('Alpha.mkv')).toBeNull()
    expect(screen.getByText('Sin resultados')).toBeInTheDocument()
    expect(document.querySelector('.fm-empty')).not.toBeNull()
  })
})

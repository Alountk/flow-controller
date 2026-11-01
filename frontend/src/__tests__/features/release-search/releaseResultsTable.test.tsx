import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { ReleaseResultsTable } from '../../../features/release-search/ReleaseResultsTable.tsx'

/**
 * S1/S2/S3/S4 («buscador-tabla»): ONE table lists every release whatever its
 * indexer, the indexer rides as a badge under the name, the four destination
 * actions survive, and the columns sort.
 */

const LIB = 'Biblioteca (la del arr)'

const release = (title: string, over: Record<string, unknown> = {}) => ({
  guid: title,
  title,
  indexer: 'TorrentLand',
  size: 1_000_000_000,
  languages: ['Castellano'],
  seeders: 10,
  quality: '1080p',
  ...over,
})

function setup(releases = [release('Alien.1979.1080p'), release('Dune.2021.2160p', { indexer: 'DivisionToro' })]) {
  const actions = {
    isProcessing: false,
    path4k: '/mnt/4k',
    path3d: '/mnt/3d',
    libraryValue: LIB,
    destinationFor: () => LIB,
    isThreeD: () => false,
    onToggleThreeD: vi.fn(),
    onGrab: vi.fn(),
    onPickFolder: vi.fn(),
  }
  render(<ReleaseResultsTable releases={releases} actions={actions} />)
  return actions
}

describe('S1 · una sola tabla, mezclada', () => {
  it('renders one table for releases of several indexers', () => {
    setup()

    expect(screen.getAllByRole('table')).toHaveLength(1)
    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(3) // header + 2 releases
    expect(screen.queryByText('🌐 TorrentLand')).toBeNull()
  })

  it('keeps the indexer as a badge under the name', () => {
    setup()

    const row = screen.getByText('Alien.1979.1080p').closest('tr') as HTMLElement
    expect(within(row).getByText('TorrentLand')).toBeInTheDocument()
    const other = screen.getByText('Dune.2021.2160p').closest('tr') as HTMLElement
    expect(within(other).getByText('DivisionToro')).toBeInTheDocument()
  })
})

describe('S2 · columnas y destinos', () => {
  it('shows the five columns with the library labelled 1080', () => {
    setup()

    for (const name of ['Nombre', 'Tamaño', 'Idioma', 'Seeders', 'Destino']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument()
    }
    const row = screen.getByText('Alien.1979.1080p').closest('tr') as HTMLElement
    expect(within(row).getByRole('button', { name: '→ 1080' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '→ 4K' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '→ 3D' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '→ Carpeta' })).toBeInTheDocument()
    expect(screen.queryByText(/Biblioteca/)).toBeNull()
  })

  it('fires the same handlers the cards used', () => {
    const actions = setup()
    const row = screen.getByText('Alien.1979.1080p').closest('tr') as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: '→ 1080' }))
    fireEvent.click(within(row).getByRole('button', { name: '→ 4K' }))
    fireEvent.click(within(row).getByRole('button', { name: '→ Carpeta' }))
    // Exact name: «→ 3D» is a destination, this is the routing mark.
    fireEvent.click(within(row).getByRole('button', { name: 'Marcar Alien.1979.1080p como 3D' }))

    expect(actions.onGrab).toHaveBeenNthCalledWith(1, 'Alien.1979.1080p', 'library')
    expect(actions.onGrab).toHaveBeenNthCalledWith(2, 'Alien.1979.1080p', '4k')
    expect(actions.onPickFolder).toHaveBeenCalledWith('Alien.1979.1080p')
    expect(actions.onToggleThreeD).toHaveBeenCalledWith('Alien.1979.1080p')
  })

  it('disables the folders when they are not configured and the row while processing', () => {
    render(
      <ReleaseResultsTable
        releases={[release('Alien.1979.1080p')]}
        actions={{
          isProcessing: true,
          path4k: '',
          path3d: '',
          libraryValue: LIB,
          destinationFor: () => LIB,
          isThreeD: () => false,
          onToggleThreeD: vi.fn(),
          onGrab: vi.fn(),
          onPickFolder: vi.fn(),
        }}
      />,
    )

    expect(screen.getByRole('button', { name: '→ 4K' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '→ 3D' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '→ 1080' })).toBeDisabled()
  })
})

describe('S3 · ordenación desde las cabeceras', () => {
  it('sorts by size when its header is clicked and reports aria-sort', () => {
    setup([release('small', { size: 900 }), release('big', { size: 90_000 })])

    const sizeHeader = screen.getByRole('columnheader', { name: 'Tamaño' })
    fireEvent.click(within(sizeHeader).getByRole('button'))

    const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent)
    expect(names[0]).toContain('small')
    expect(sizeHeader).toHaveAttribute('aria-sort', 'ascending')
  })
})

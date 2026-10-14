import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ActivityTable } from '../../app/ActivityTable.tsx'
import type { ActivityItem } from '../../shared/types.ts'

/**
 * The dashboard's recent-activity table (Stitch 01, section 3 — S2..S5 of
 * odd/tasks/stitch-actividad.md): the design's columns, the frontend-owned
 * state vocabulary (raw values pass through when unknown — never invented),
 * the client-side name filter, the refresh button and the honest footer
 * (`Mostrando N …` + the timestamp of the data the table actually shows).
 */

const operation: ActivityItem = {
  kind: 'operation',
  at: 1_700_000_600,
  service: 'radarr',
  name: 'Dune.Part.Two.mkv',
  destination: '/media/peliculas/Dune (2024)',
  size_bytes: 51_753_517_056,
  status: 'done',
  import_status: '',
  op_type: 'copy',
}

const download: ActivityItem = {
  kind: 'download',
  at: 1_700_000_700,
  service: 'sonarr',
  name: 'Severance.S02E01',
  destination: null,
  size_bytes: 1_073_741_824,
  status: 'downloading',
  import_status: '',
  op_type: '',
  problem: false,
}

const UPDATED_AT = 1_700_000_700

function renderTable(items: ActivityItem[], overrides: Record<string, unknown> = {}) {
  const onRefresh = vi.fn()
  const onOpenSeguimiento = vi.fn()
  render(
    <ActivityTable
      items={items}
      updatedAt={UPDATED_AT}
      onRefresh={onRefresh}
      onOpenSeguimiento={onOpenSeguimiento}
      {...overrides}
    />,
  )
  return { onRefresh, onOpenSeguimiento }
}

const rows = () => document.querySelectorAll<HTMLElement>('.act-table tbody tr')

describe('ActivityTable · columns and rows (S2)', () => {
  it('renders the design columns', () => {
    renderTable([operation])

    for (const heading of [
      'Servicio',
      'Nombre del medio / Release',
      'Destino / Ruta',
      'Tamaño',
      'Estado',
      'Acción',
    ]) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument()
    }
    expect(
      screen.getByRole('heading', { name: 'Actividad reciente de transferencias e indexación' }),
    ).toBeInTheDocument()
  })

  it('draws an operation with its service dot, mono fields and status pill', () => {
    renderTable([operation])

    const row = rows()[0]
    expect(within(row).getByText('Radarr')).toBeInTheDocument()
    expect(within(row).getByText('Dune.Part.Two.mkv').className).toContain('act-mono')
    expect(within(row).getByText('/media/peliculas/Dune (2024)')).toBeInTheDocument()
    expect(within(row).getByText('48.2 GB')).toBeInTheDocument()
    const pill = within(row).getByText('Hecha')
    expect(pill.className).toContain('act-ok')
  })

  it('shows an em dash where a download has no destination', () => {
    renderTable([download])

    const row = rows()[0]
    expect(within(row).getByText('—')).toBeInTheDocument()
    expect(within(row).getByText('Descargando').className).toContain('act-warn')
  })

  it('prefers an active import_status over the operation status', () => {
    renderTable([{ ...operation, import_status: 'importing' }])

    expect(within(rows()[0]).getByText('Importando')).toBeInTheDocument()
    expect(within(rows()[0]).queryByText('Hecha')).toBeNull()
  })

  it('passes an unknown status through raw — never invents a label', () => {
    renderTable([{ ...operation, status: 'weird-state' }])

    expect(within(rows()[0]).getByText('weird-state')).toBeInTheDocument()
  })

  it('renders an em dash for a row with no service', () => {
    renderTable([{ ...operation, service: null }])

    expect(within(rows()[0]).getByText('—')).toBeInTheDocument()
    expect(within(rows()[0]).queryByText('Radarr')).toBeNull()
  })
})

describe('ActivityTable · toolbar and footer (S3/S4)', () => {
  it('filters the shown rows by name, client-side', () => {
    renderTable([operation, download])
    expect(rows()).toHaveLength(2)

    fireEvent.change(screen.getByLabelText('Filtrar actividad'), {
      target: { value: 'sever' },
    })
    expect(rows()).toHaveLength(1)
    expect(within(rows()[0]).getByText('Severance.S02E01')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filtrar actividad'), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('Sin coincidencias')).toBeInTheDocument()
  })

  it('refreshes on demand through the caller', () => {
    const { onRefresh } = renderTable([operation])

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('states the shown count and the data timestamp in the footer', () => {
    renderTable([operation, download])

    expect(screen.getByText('Mostrando 2 transferencias recientes')).toBeInTheDocument()
    const stamp = new Date(UPDATED_AT * 1000).toLocaleTimeString()
    expect(screen.getByText(`Actualizado ${stamp}`)).toBeInTheDocument()
  })

  it('routes every row to Seguimiento through its action', () => {
    const { onOpenSeguimiento } = renderTable([operation])

    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Ver en Seguimiento' }))
    expect(onOpenSeguimiento).toHaveBeenCalledTimes(1)
  })
})

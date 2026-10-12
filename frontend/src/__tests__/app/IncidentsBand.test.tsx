import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { IncidentsBand } from '../../app/IncidentsBand.tsx'
import type { TraceSummary } from '../../shared/types.ts'

function summaryOf(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    downloading: 0,
    downloaded: 0,
    import_blocked: 0,
    failed: 0,
    sent: 0,
    category_mismatches: 0,
    ...overrides,
  }
}

describe('IncidentsBand (diseño Stitch 01 — banda de incidencias)', () => {
  it('announces the total with an honest breakdown and the CTA count', () => {
    render(
      <IncidentsBand
        summary={summaryOf({ import_blocked: 2, failed: 1 })}
        onOpenSeguimiento={() => {}}
      />,
    )

    expect(
      screen.getByText('3 incidencias pendientes requieren atención'),
    ).toBeInTheDocument()
    expect(screen.getByText('2 bloqueos de importación, 1 fallo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ver en Seguimiento (3)' })).toBeInTheDocument()
  })

  it('uses the singular form for a single incident', () => {
    render(<IncidentsBand summary={summaryOf({ failed: 1 })} onOpenSeguimiento={() => {}} />)

    expect(
      screen.getByText('1 incidencia pendiente requiere atención'),
    ).toBeInTheDocument()
    expect(screen.getByText('1 fallo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ver en Seguimiento (1)' })).toBeInTheDocument()
  })

  it('renders nothing when there are no incidents or no payload yet', () => {
    const { container, rerender } = render(
      <IncidentsBand summary={summaryOf()} onOpenSeguimiento={() => {}} />,
    )
    expect(container.querySelector('.incidents-band')).not.toBeInTheDocument()

    rerender(<IncidentsBand summary={undefined} onOpenSeguimiento={() => {}} />)
    expect(container.querySelector('.incidents-band')).not.toBeInTheDocument()
  })

  it('routes the CTA to Seguimiento', () => {
    const onOpenSeguimiento = vi.fn()
    render(
      <IncidentsBand summary={summaryOf({ import_blocked: 1 })} onOpenSeguimiento={onOpenSeguimiento} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ver en Seguimiento (1)' }))
    expect(onOpenSeguimiento).toHaveBeenCalledTimes(1)
  })
})

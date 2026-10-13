import type { TraceSummary } from '../shared/types.ts'

interface IncidentsBandProps {
  summary: TraceSummary | undefined
  onOpenSeguimiento: () => void
}

/**
 * The incidents band of Stitch design 01: everything the trace layer marks as
 * blocked or failed, announced once with a count that links to Seguimiento.
 * Hidden when there is nothing to announce — an empty alarm is a lie.
 */
export function IncidentsBand({ summary, onOpenSeguimiento }: IncidentsBandProps) {
  const blocked = summary?.import_blocked ?? 0
  const failed = summary?.failed ?? 0
  const total = blocked + failed
  if (total === 0) return null

  const parts: string[] = []
  if (blocked > 0) parts.push(`${blocked} bloqueo${blocked > 1 ? 's' : ''} de importación`)
  if (failed > 0) parts.push(`${failed} fallo${failed > 1 ? 's' : ''}`)

  return (
    <section className="incidents-band" aria-label="Incidencias pendientes">
      <div className="incidents-text">
        <p className="incidents-title">
          {total === 1
            ? '1 incidencia pendiente requiere atención'
            : `${total} incidencias pendientes requieren atención`}
        </p>
        <p className="incidents-desc">{parts.join(', ')}</p>
      </div>
      <button type="button" className="incidents-cta" onClick={onOpenSeguimiento}>
        {`Ver en Seguimiento (${total})`}
        <span aria-hidden="true"> →</span>
      </button>
    </section>
  )
}

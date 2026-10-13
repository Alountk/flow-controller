import type { ServiceStatus } from '../shared/types.ts'
import './ServiceChips.css'

/** Design 01 chips: one short honest label per service state. */
const STATE_TEXT: Record<ServiceStatus['state'], string> = {
  online: 'Conectado',
  offline: 'Alerta',
  // The API key was rejected — different fix from offline, so it says so.
  misconfigured: 'Clave rechazada',
  unknown: 'Sin datos',
}

const STATE_VARIANT: Record<ServiceStatus['state'], string> = {
  online: 'ok',
  offline: 'bad',
  misconfigured: 'bad',
  unknown: 'unknown',
}

/**
 * Service health chips for the topbar (Stitch 01). The design puts service
 * status in the header instead of a health strip below it.
 */
export function ServiceChips({ services }: { services: ServiceStatus[] }) {
  if (services.length === 0) return null

  return (
    <div className="service-chips" role="group" aria-label="Estado de servicios">
      {services.map((service) => (
        <span
          key={service.key}
          className={`service-chip ${STATE_VARIANT[service.state]}`}
          title={service.reason || undefined}
        >
          <span className="service-chip-dot" aria-hidden="true" />
          {`${service.label}: ${STATE_TEXT[service.state]}`}
        </span>
      ))}
    </div>
  )
}

import type { ServiceStatus } from '../types'
import { ServiceNode } from './ServiceNode'
import { Connector } from './Connector'
import './PipelineVisual.css'

interface Props {
  services: ServiceStatus[]
}

/**
 * Pipeline Visual: Radarr → AmuTorrent → Sonarr
 * El conector se marca como roto cuando alguno de los nodos que une
 * no está online, mostrando exactamente dónde se corta el flujo.
 */
export function PipelineVisual({ services }: Props) {
  return (
    <div className="pipeline">
      {services.map((service, i) => (
        <div key={service.key} style={{ display: 'contents' }}>
          {i > 0 && (
            <Connector
              flowing={services[i - 1].state === 'online' && service.state === 'online'}
            />
          )}
          <ServiceNode service={service} />
        </div>
      ))}
    </div>
  )
}

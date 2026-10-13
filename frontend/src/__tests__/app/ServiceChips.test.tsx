import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ServiceChips } from '../../app/ServiceChips.tsx'
import type { ServiceStatus } from '../../shared/types.ts'

const services: ServiceStatus[] = [
  { key: 'radarr', label: 'Radarr', state: 'online', reason: '' },
  { key: 'amutorrent', label: 'AmuTorrent', state: 'offline', reason: 'timeout' },
  { key: 'sonarr', label: 'Sonarr', state: 'unknown', reason: 'Sin datos' },
]

describe('ServiceChips (diseño Stitch 01 — topbar)', () => {
  it('renders one chip per service with the design label format', () => {
    const { container } = render(<ServiceChips services={services} />)

    expect(screen.getByText('Radarr: Conectado')).toBeInTheDocument()
    expect(screen.getByText('AmuTorrent: Alerta')).toBeInTheDocument()
    expect(screen.getByText('Sonarr: Sin datos')).toBeInTheDocument()
    expect(container.querySelectorAll('.service-chip')).toHaveLength(3)
  })

  it('maps each service state to its own variant class', () => {
    const { container } = render(<ServiceChips services={services} />)

    const chips = container.querySelectorAll('.service-chip')
    expect(chips[0].classList.contains('ok')).toBe(true)
    expect(chips[1].classList.contains('bad')).toBe(true)
    expect(chips[2].classList.contains('unknown')).toBe(true)
  })

  it('distinguishes a rejected API key from an offline service', () => {
    const { container } = render(
      <ServiceChips
        services={[{ key: 'sonarr', label: 'Sonarr', state: 'misconfigured', reason: '401' }]}
      />,
    )

    expect(screen.getByText('Sonarr: Clave rechazada')).toBeInTheDocument()
    expect(container.querySelector('.service-chip.bad')).not.toBeNull()
  })

  it('renders nothing when there are no services', () => {
    const { container } = render(<ServiceChips services={[]} />)

    expect(container.querySelector('.service-chips')).not.toBeInTheDocument()
  })
})

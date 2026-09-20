import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PipelineVisual } from '../components/PipelineVisual'
import type { ServiceStatus } from '../types'

const services: ServiceStatus[] = [
  { key: 'radarr', label: 'Radarr', state: 'online', reason: 'OK' },
  { key: 'amutorrent', label: 'aMuTorrent', state: 'online', reason: 'OK' },
  { key: 'sonarr', label: 'Sonarr', state: 'online', reason: 'OK' },
]

describe('PipelineVisual', () => {
  it('renders one node per service', () => {
    const { container } = render(<PipelineVisual services={services} />)

    expect(container.querySelectorAll('.pipeline-node')).toHaveLength(3)
    expect(screen.getByText('Radarr')).toBeInTheDocument()
    expect(screen.getByText('aMuTorrent')).toBeInTheDocument()
    expect(screen.getByText('Sonarr')).toBeInTheDocument()
  })

  it('renders connectors between nodes but not before the first one', () => {
    const { container } = render(<PipelineVisual services={services} />)

    expect(container.querySelectorAll('.connector')).toHaveLength(2)
  })

  it('keeps every connector flowing when all services are online', () => {
    const { container } = render(<PipelineVisual services={services} />)

    expect(container.querySelectorAll('.connector.flowing')).toHaveLength(2)
    expect(container.querySelectorAll('.connector.broken')).toHaveLength(0)
  })

  it('breaks the connector touching an offline service', () => {
    const withOffline: ServiceStatus[] = [
      services[0],
      { ...services[1], state: 'offline' },
      services[2],
    ]
    const { container } = render(<PipelineVisual services={withOffline} />)

    expect(container.querySelectorAll('.connector.broken')).toHaveLength(2)
    expect(container.querySelectorAll('.connector.flowing')).toHaveLength(0)
  })

  it('breaks only the affected connector', () => {
    const lastOffline: ServiceStatus[] = [services[0], services[1], { ...services[2], state: 'offline' }]
    const { container } = render(<PipelineVisual services={lastOffline} />)

    expect(container.querySelectorAll('.connector.flowing')).toHaveLength(1)
    expect(container.querySelectorAll('.connector.broken')).toHaveLength(1)
  })
})

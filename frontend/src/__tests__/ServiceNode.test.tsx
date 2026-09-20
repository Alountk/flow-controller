import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ServiceNode } from '../components/ServiceNode'
import type { ServiceStatus } from '../types'

const base: ServiceStatus = {
  key: 'radarr',
  label: 'Radarr',
  state: 'online',
  reason: 'OK',
}

describe('ServiceNode', () => {
  it('renders label, state and reason', () => {
    render(<ServiceNode service={base} />)

    expect(screen.getByText('Radarr')).toBeInTheDocument()
    expect(screen.getByText('online')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
  })

  it('applies the service state as a class on the root node', () => {
    const { container } = render(<ServiceNode service={{ ...base, state: 'offline' }} />)

    expect(container.querySelector('.pipeline-node.offline')).toBeInTheDocument()
  })

  it('uses a service-specific icon and falls back to a generic one', () => {
    const { container: radarr } = render(<ServiceNode service={base} />)
    expect(radarr.querySelector('.node-icon')).toHaveTextContent('🎬')

    const { container: unknown } = render(
      <ServiceNode service={{ ...base, key: 'sonarr' }} />,
    )
    expect(unknown.querySelector('.node-icon')).toHaveTextContent('📺')
  })

  it('shows the version tag without a duplicated leading v', () => {
    render(<ServiceNode service={{ ...base, meta: { version: 'v4.5.1' } }} />)

    expect(screen.getByText('v4.5.1')).toBeInTheDocument()
  })

  it('renders torrent stats when present', () => {
    render(
      <ServiceNode
        service={{
          ...base,
          key: 'amutorrent',
          meta: { torrents: { total: 10, downloading: 2, completed: 7, errors: 1 } },
        }}
      />,
    )

    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('errores')).toBeInTheDocument()
  })

  it('hides the errors stat when there are no errors', () => {
    render(
      <ServiceNode
        service={{
          ...base,
          key: 'amutorrent',
          meta: { torrents: { total: 10, downloading: 3, completed: 7, errors: 0 } },
        }}
      />,
    )

    expect(screen.queryByText('errores')).not.toBeInTheDocument()
  })

  it('does not render meta or stats sections without metadata', () => {
    const { container } = render(<ServiceNode service={base} />)

    expect(container.querySelector('.node-meta')).not.toBeInTheDocument()
    expect(container.querySelector('.node-stats')).not.toBeInTheDocument()
  })
})

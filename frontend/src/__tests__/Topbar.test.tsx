import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Topbar } from '../components/Topbar'

describe('Topbar', () => {
  it('renders the title and the live indicator', () => {
    render(<Topbar title="Dashboard" loading={false} lastUpdated={null} />)

    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('En vivo')).toBeInTheDocument()
  })

  it('shows the connecting label and hides the live dot styling while loading', () => {
    const { container } = render(<Topbar title="Dashboard" loading={true} lastUpdated={null} />)

    expect(screen.getByText('Conectando…')).toBeInTheDocument()
    expect(container.querySelector('.topbar-dot.live')).not.toBeInTheDocument()
  })

  it('renders the last update time when provided', () => {
    const timestamp = new Date('2026-09-20T14:30:00').getTime()
    render(<Topbar title="Dashboard" loading={false} lastUpdated={timestamp} />)

    expect(screen.getByText(new Date(timestamp).toLocaleTimeString())).toBeInTheDocument()
  })

  it('renders no time when lastUpdated is null', () => {
    const { container } = render(<Topbar title="Dashboard" loading={false} lastUpdated={null} />)

    expect(container.querySelector('.topbar-time')).not.toBeInTheDocument()
  })

  it('renders the right slot content', () => {
    render(
      <Topbar
        title="Dashboard"
        loading={false}
        lastUpdated={null}
        right={<button type="button">Acción</button>}
      />,
    )

    expect(screen.getByRole('button', { name: 'Acción' })).toBeInTheDocument()
  })
})

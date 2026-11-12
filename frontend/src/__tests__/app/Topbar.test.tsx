import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Topbar } from '../../app/Topbar.tsx'

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

  it('renders the design subtitle when provided and omits it otherwise', () => {
    const { rerender, container } = render(
      <Topbar
        title="Dashboard"
        subtitle="Vista general del servidor multimedia"
        loading={false}
        lastUpdated={null}
      />,
    )

    expect(screen.getByText('Vista general del servidor multimedia')).toBeInTheDocument()
    rerender(<Topbar title="Películas" loading={false} lastUpdated={null} />)
    expect(container.querySelector('.topbar-subtitle')).not.toBeInTheDocument()
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

  it('offers no logout unless an account protects the panel', () => {
    render(<Topbar title="Dashboard" loading={false} lastUpdated={null} />)

    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull()
  })

  it('calls onLogout when the user signs out', () => {
    const onLogout = vi.fn()
    render(<Topbar title="Dashboard" loading={false} lastUpdated={null} onLogout={onLogout} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }))

    expect(onLogout).toHaveBeenCalledOnce()
  })
})

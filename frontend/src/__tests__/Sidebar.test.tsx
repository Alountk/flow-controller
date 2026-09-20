import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'

describe('Sidebar', () => {
  it('renders the main navigation items', () => {
    render(<Sidebar active="dashboard" onNavigate={() => {}} developer={false} />)

    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Trazabilidad')).toBeInTheDocument()
    expect(screen.getByText('Faltantes')).toBeInTheDocument()
    expect(screen.getByText('Media Mixer')).toBeInTheDocument()
  })

  it('marks the active page link', () => {
    const { container } = render(<Sidebar active="mixer" onNavigate={() => {}} developer={false} />)

    const active = container.querySelector('.sb-link.active')
    expect(active).toHaveTextContent('Media Mixer')
  })

  it('hides the developer section by default', () => {
    render(<Sidebar active="dashboard" onNavigate={() => {}} developer={false} />)

    expect(screen.queryByText('Prototipos')).not.toBeInTheDocument()
  })

  it('shows the developer section when developer mode is on', () => {
    render(<Sidebar active="dashboard" onNavigate={() => {}} developer={true} />)

    expect(screen.getByText('Prototipos')).toBeInTheDocument()
    expect(screen.getByText('Desarrollo')).toBeInTheDocument()
  })

  it('calls onNavigate with the page key and prevents default navigation', () => {
    const onNavigate = vi.fn()
    render(<Sidebar active="dashboard" onNavigate={onNavigate} developer={false} />)

    fireEvent.click(screen.getByText('Calendario'))

    expect(onNavigate).toHaveBeenCalledWith('calendar')
  })

  it('renders anchors pointing at the page paths', () => {
    render(<Sidebar active="dashboard" onNavigate={() => {}} developer={false} />)

    expect(screen.getByText('Archivos').closest('a')).toHaveAttribute('href', '/archivos')
  })
})

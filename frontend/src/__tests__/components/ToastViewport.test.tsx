import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ToastViewport } from '../../components/ToastViewport'
import { clearToasts, toast } from '../../utils/toast'

/**
 * The one viewport (F-13): a status region that announces additions and
 * dismisses on click. It renders nothing when there is nothing to say —
 * an empty fixed box over the UI would be worse than silence.
 */

afterEach(() => {
  clearToasts()
})

describe('ToastViewport', () => {
  it('renders nothing when the stack is empty', () => {
    const { container } = render(<ToastViewport />)

    expect(container.querySelector('.toast-viewport')).toBeNull()
  })

  it('announces through a polite status region', () => {
    toast('Descarga encolada')

    render(<ToastViewport />)

    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(within(region).getByText('Descarga encolada')).toBeInTheDocument()
  })

  it('paints the tone and dismisses on click', () => {
    toast('todo bien')
    toast('algo fue mal', 'error')

    render(<ToastViewport />)

    expect(screen.getByText('todo bien')).toHaveClass('toast-ok')
    expect(screen.getByText('algo fue mal')).toHaveClass('toast-error')

    fireEvent.click(screen.getByText('todo bien'))
    expect(screen.queryByText('todo bien')).toBeNull()
    expect(screen.getByText('algo fue mal')).toBeInTheDocument()
  })
})

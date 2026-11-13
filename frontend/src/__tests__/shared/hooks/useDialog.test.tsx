import { useRef } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useDialog } from '../../../shared/hooks/useDialog.ts'

function Dialog({ label, onClose }: { label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialog(ref, onClose)
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label}>
      <button>{label} first</button>
      <button>{label} last</button>
    </div>
  )
}

function Host({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <button>opener</button>
      {open && <Dialog label="A" onClose={onClose} />}
    </>
  )
}

describe('useDialog', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<Dialog label="A" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sends Escape only to the top-most dialog', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    render(<><Dialog label="A" onClose={outer} /><Dialog label="B" onClose={inner} /></>)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog on open', () => {
    render(<Dialog label="A" onClose={() => {}} />)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    render(<Dialog label="A" onClose={() => {}} />)
    const first = screen.getByText('A first')
    const last = screen.getByText('A last')
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('returns focus to the opener on close', () => {
    const { rerender } = render(<Host open={false} onClose={() => {}} />)
    screen.getByText('opener').focus()
    rerender(<Host open onClose={() => {}} />)
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    rerender(<Host open={false} onClose={() => {}} />)
    expect(screen.getByText('opener')).toHaveFocus()
  })
})

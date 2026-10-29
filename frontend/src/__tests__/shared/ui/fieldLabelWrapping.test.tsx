import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Field } from '../../../shared/ui/Field.tsx'

/** labels-wrap T1 (family C): the <label> wraps the control it names. The
 *  input's aria-label stays and keeps pinning the exact accessible name. */
describe('Field — the label wraps its control', () => {
  it('the input is a descendant of the label and the visible text is exactly the label', () => {
    render(<Field label="URL" value="http://x" onChange={() => {}} />)

    const input = screen.getByLabelText('URL')
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(within(label!).getByText('URL')).toBeInTheDocument()
  })

  it('with a restart badge the label still wraps the input', () => {
    render(<Field label="Puerto" value={8080} onChange={() => {}} restart />)

    const input = screen.getByLabelText('Puerto')
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(within(label!).getByText('Puerto')).toBeInTheDocument()
    expect(within(label!).getByText('Requiere reinicio')).toBeInTheDocument()
  })

  it('the toggle button is also a descendant of the label', () => {
    render(<Field label="Modo seguro" value onChange={() => {}} type="toggle" />)

    // The button's accessible name now comes from the label (label→control
    // semantics); «Sí» remains its visible text.
    const toggle = screen.getByLabelText('Modo seguro')
    const label = toggle.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(toggle)
    expect(within(label!).getByText('Modo seguro')).toBeInTheDocument()
    expect(within(label!).getByText('Sí')).toBeInTheDocument()
  })
})

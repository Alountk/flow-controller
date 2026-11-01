import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { QualityThresholdSection } from '../../../features/settings/QualityThresholdSection.tsx'

/**
 * S2 («umbral-calidad»): the threshold is a slider over the resolution
 * classes plus a manual width in pixels that overrides it.
 */

function renderSection(values: { minClass?: string; minWidth?: number } = {}) {
  const onClass = vi.fn()
  const onWidth = vi.fn()
  render(
    <QualityThresholdSection
      minClass={values.minClass ?? '1080p'}
      minWidth={values.minWidth ?? 0}
      onClass={onClass}
      onWidth={onWidth}
    />,
  )
  return { onClass, onWidth }
}

describe('S2 · umbral de calidad en Settings', () => {
  it('shows the slider on the current class with every stop available', () => {
    renderSection({ minClass: '1080p' })

    const slider = screen.getByRole('slider', { name: /umbral de calidad/i })
    expect(slider).toHaveValue('2')
    expect(slider).toHaveAttribute('aria-valuetext', '1080p')
    for (const label of ['SD', '720p', '1080p', '4K']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('saves the class the operator slides to', () => {
    const { onClass } = renderSection()

    fireEvent.change(screen.getByRole('slider', { name: /umbral de calidad/i }), {
      target: { value: '1' },
    })

    expect(onClass).toHaveBeenCalledWith('720p')
  })

  it('saves a manual width and clears back to the class with 0', () => {
    // A controlled input only fires `change` when its value actually changes,
    // so the harness has to behave like the real form: it owns the state.
    const onWidth = vi.fn()
    function Harness() {
      const [minWidth, setMinWidth] = useState(0)
      return (
        <QualityThresholdSection
          minClass="1080p"
          minWidth={minWidth}
          onClass={() => {}}
          onWidth={(value) => {
            onWidth(value)
            setMinWidth(value)
          }}
        />
      )
    }
    render(<Harness />)

    const field = () => screen.getByLabelText(/ancho manual/i)
    fireEvent.change(field(), { target: { value: '2000' } })
    fireEvent.change(field(), { target: { value: '' } })

    expect(onWidth).toHaveBeenNthCalledWith(1, 2000)
    expect(onWidth).toHaveBeenNthCalledWith(2, 0)
  })

  it('says that a manual width wins over the class', () => {
    renderSection({ minWidth: 2000 })

    expect(screen.getByText(/manda sobre la clase/i)).toBeInTheDocument()
  })
})

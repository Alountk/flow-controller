import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Connector } from '../components/Connector'

describe('Connector', () => {
  it('shows a flowing connector when connected', () => {
    const { container } = render(<Connector flowing={true} />)

    expect(container.querySelector('.connector.flowing')).toBeInTheDocument()
    expect(container.querySelector('.connector-line')).toBeInTheDocument()
    expect(container.querySelector('.connector-x')).not.toBeInTheDocument()
  })

  it('marks the connector as broken and shows the x when not flowing', () => {
    const { container } = render(<Connector flowing={false} />)

    expect(container.querySelector('.connector.broken')).toBeInTheDocument()
    expect(container.querySelector('.connector-x')).toHaveTextContent('✕')
  })
})

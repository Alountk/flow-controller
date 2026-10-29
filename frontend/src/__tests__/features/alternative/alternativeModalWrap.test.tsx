import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AlternativeModal,
  type AlternativeModalProps,
} from '../../../features/alternative/AlternativeModal.tsx'

/** labels-wrap T1 (family B, S2): the label wraps «Título a buscar» + input. */

function mockFetch() {
  const fn = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({ indexers: [] }) } as Response),
  )
  vi.stubGlobal('fetch', fn)
}

const PROPS: AlternativeModalProps = {
  title: 'Matrix 1999',
  originalTitle: 'The Matrix',
  alternateTitles: [],
  movieId: 0,
  audioLanguages: [],
  onClose: () => {},
}

describe('AlternativeModal S2 — the label wraps the input', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('«Título a buscar»: input descendant of the label with the exact text', async () => {
    mockFetch()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <AlternativeModal {...PROPS} />
      </QueryClientProvider>,
    )

    const input = await screen.findByLabelText('Título a buscar')
    const label = input.closest('label')
    expect(label).not.toBeNull()
    expect(label).toContainElement(input)
    expect(within(label!).getByText('Título a buscar')).toBeInTheDocument()
  })
})

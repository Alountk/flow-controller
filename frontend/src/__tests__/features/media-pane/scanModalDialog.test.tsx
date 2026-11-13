import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ScanModal, type ScanItem } from '../../../features/media-pane/components/ScanModal.tsx'

const item: ScanItem = { type: 'movie', id: 7, title: 'Ronin', source: 'radarr' }

function open(onClose = () => {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ScanModal item={item} onClose={onClose} />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('ScanModal as a dialog', () => {
  it('is a named modal dialog with focus inside', () => {
    open()
    const dialog = screen.getByRole('dialog', { name: /Ronin/ })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('closes on Escape and from the close button', () => {
    const onClose = vi.fn()
    open(onClose)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

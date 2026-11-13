import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LibraryRenameDialog } from '../../../features/file-manager/LibraryRenameDialog.tsx'

function open(onClose = () => {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)))
  return render(<LibraryRenameDialog path="/mnt/x/Ronin.mkv" onClose={onClose} onRenamed={() => {}} />)
}

afterEach(() => vi.unstubAllGlobals())

describe('LibraryRenameDialog keyboard', () => {
  it('is a named modal dialog with focus inside', () => {
    open()
    const dialog = screen.getByRole('dialog', { name: 'Renombrar como Radarr' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('closes on Escape and on a backdrop click, not on an inner click', () => {
    const onClose = vi.fn()
    const { container } = open(onClose)

    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(container.querySelector('.fm-rename-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('keeps Tab inside the dialog', () => {
    open()
    const dialog = screen.getByRole('dialog')
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'))
    items[items.length - 1].focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(items[0])
  })
})

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Open dialogs, oldest first: Escape only reaches the one on top.
const stack: symbol[] = []

/**
 * Keyboard behaviour every modal dialog needs: Escape closes only the top-most
 * one, focus moves in on open, Tab stays inside, and focus returns to the opener.
 * The dialog element still carries role="dialog", aria-modal and its name.
 * `enabled` is for dialogs that stay mounted while closed.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const node = ref.current
    if (!enabled || !node) return
    const id = Symbol('dialog')
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    stack.push(id)

    if (!node.contains(document.activeElement)) {
      if (!node.hasAttribute('tabindex')) node.tabIndex = -1
      node.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return
      if (e.key === 'Escape') {
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (!node.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stack.splice(stack.indexOf(id), 1)
      if (opener?.isConnected) opener.focus()
    }
  }, [ref, enabled])
}

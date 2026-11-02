import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The «Acciones rápidas» trigger and its menu, shared by the list and the
 * detail (S1 of «peliculas-acciones-y-pares»).
 *
 * It exists because both places need the SAME behaviour — one open menu, close
 * on outside click and on Escape, items that close it before acting — and two
 * copies of that would drift. The caller decides which actions it can offer;
 * `children` is for blocks that are not actions (the library sweep's card).
 */

export interface QuickAction {
  label: string
  onSelect: () => void
}

export function QuickActionsMenu({
  items,
  children,
  primary = false,
}: {
  items: QuickAction[]
  children?: ReactNode
  /** The list's trigger is the design's primary button; the detail's is quiet. */
  primary?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="sec-l2-quick" ref={ref}>
      <button
        type="button"
        className={`sec-l2-btn${primary ? ' is-primary' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⚡</span>
        Acciones rápidas
      </button>
      {open && (
        <div className="sec-l2-menu" role="menu" aria-label="Acciones rápidas">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
          {children}
        </div>
      )}
    </div>
  )
}

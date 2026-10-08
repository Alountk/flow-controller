import { dismissToast, useToasts } from '../utils/toast'
import './ToastViewport.css'

/**
 * The one viewport for ambient messages (F-13). Mounted once at the app
 * root: a grab inside the release panel and a sweep inside Seguimiento
 * announce through the same door.
 *
 * `role="status"` + `aria-live="polite"` on the CONTAINER is the screen
 * reader's contract: additions are announced without stealing focus, and
 * one status region is enough — the live region exists even when empty
 * (the container only unmounts at zero, and even then a new message
 * remounts it before being announced... which is exactly why the region
 * stays: mount-and-announce in the same frame is reliable for polite
 * announcements).
 */
export function ToastViewport() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`toast toast-${t.tone}`}
          onClick={() => dismissToast(t.id)}
          title="Cerrar"
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}

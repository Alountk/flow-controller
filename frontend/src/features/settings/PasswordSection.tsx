/** "Cambiar contraseña" — the administrator's own password.
 *
 * Outside the settings form on purpose: it takes effect on its own button and
 * must never ride along with "Guardar cambios".
 */

import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { changePassword, fetchAuthState } from '../../shared/api/auth.ts'
import './Settings.css'

const MIN_LENGTH = 8

export function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const auth = useQuery({ queryKey: ['auth-state'], queryFn: fetchAuthState })
  // Installs without a login account have no password to change.
  if (auth.data?.has_user !== true) return null

  async function submit(event: FormEvent) {
    event.preventDefault()
    setDone(false)
    if (next.length < MIN_LENGTH) return setError(`La nueva contraseña necesita al menos ${MIN_LENGTH} caracteres`)
    if (next !== repeat) return setError('Las contraseñas nuevas no coinciden')
    setBusy(true)
    setError(null)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setRepeat('')
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar la contraseña')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span className="settings-section-icon" aria-hidden="true">🔑</span>
        <div>
          <h3 className="settings-section-title">Cambiar contraseña</h3>
          <p className="settings-section-subtitle">
            Al cambiarla se cierran las demás sesiones abiertas; esta sigue activa.
          </p>
        </div>
      </div>
      <form onSubmit={submit}>
        <label className="settings-field">
          Contraseña actual
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="settings-field">
          Nueva contraseña
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label className="settings-field">
          Repite la nueva contraseña
          <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        </label>
        {error && <p className="settings-hint settings-hint-error" role="alert">{error}</p>}
        {done && <p className="settings-hint" role="status">Contraseña actualizada</p>}
        <button type="submit" className="settings-btn settings-btn-primary" disabled={busy}>
          {busy ? 'Guardando...' : 'Cambiar contraseña'}
        </button>
      </form>
    </div>
  )
}

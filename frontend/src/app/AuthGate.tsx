import { useState } from 'react'
import { AuthError, login, register } from '../shared/api/auth.ts'
import './AuthGate.css'

const MIN_PASSWORD = 8

interface AuthGateProps {
  /** `create`: nobody has an account yet. `login`: the administrator exists. */
  mode: 'create' | 'login'
  /** An install that still has its old API key must present it to create the admin. */
  needsApiKey?: boolean
  onAuthenticated: () => void
}

/**
 * The first thing the app shows: create the administrator, or sign in.
 *
 * Creating the administrator signs the browser in, so the first-run wizard that
 * follows already runs as that account.
 */
export function AuthGate({ mode, needsApiKey = false, onAuthenticated }: AuthGateProps) {
  const creating = mode === 'create'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const name = username.trim()
    if (!name || !password) return

    if (creating) {
      if (password.length < MIN_PASSWORD) {
        setError(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`)
        return
      }
      if (password !== repeat) {
        setError('Las contraseñas no coinciden')
        return
      }
    }

    setBusy(true)
    setError('')
    try {
      if (creating) await register(name, password, needsApiKey ? apiKey.trim() : '')
      else await login(name, password)
      onAuthenticated()
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'No se pudo completar la operación')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-gate">
      <form className="auth-gate-card" onSubmit={submit}>
        <h1>Flow Controller</h1>
        <p className="auth-gate-hint">
          {creating
            ? 'Crea la cuenta de administrador para empezar. Con ella entrarás a la aplicación.'
            : 'Inicia sesión para continuar.'}
        </p>
        <input
          type="text"
          className="auth-gate-input"
          aria-label="Usuario"
          placeholder="Usuario"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          className="auth-gate-input"
          aria-label="Contraseña"
          placeholder="Contraseña"
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {creating && (
          <input
            type="password"
            className="auth-gate-input"
            aria-label="Repite la contraseña"
            placeholder="Repite la contraseña"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        )}
        {creating && needsApiKey && (
          <>
            <p className="auth-gate-hint">
              Esta instalación ya tenía una API key. Introdúcela una vez para demostrar que es tuya.
            </p>
            <input
              type="password"
              className="auth-gate-input"
              aria-label="API key actual"
              placeholder="API key actual"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </>
        )}
        {error && (
          <div className="auth-gate-error" role="alert">
            {error}
          </div>
        )}
        <button
          type="submit"
          className="auth-gate-button"
          disabled={busy || !username.trim() || !password || (creating && needsApiKey && !apiKey.trim())}
        >
          {busy ? 'Comprobando…' : creating ? 'Crear administrador' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

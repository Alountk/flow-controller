import { useState } from 'react'
import { rememberApiKey, verifyApiKey } from '../api/auth'
import './AuthGate.css'

/**
 * Asks for the API key when the backend requires one.
 *
 * The backend no longer serves the key (that let anyone reaching the port
 * bootstrap to every stored credential), so the user supplies it once and the
 * browser remembers it.
 */
export function AuthGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const candidate = key.trim()
    if (!candidate) return

    setChecking(true)
    setError('')
    const ok = await verifyApiKey(candidate)
    setChecking(false)

    if (ok) {
      rememberApiKey(candidate)
      onAuthenticated()
    } else {
      setError('API key incorrecta')
    }
  }

  return (
    <div className="auth-gate">
      <form className="auth-gate-card" onSubmit={submit}>
        <h1>Flow Controller</h1>
        <p className="auth-gate-hint">
          Introduce tu API key para continuar. Se guardará en este navegador.
        </p>
        <input
          type="password"
          className="auth-gate-input"
          aria-label="API key"
          placeholder="API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoFocus
        />
        {error && (
          <div className="auth-gate-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="auth-gate-button" disabled={checking || !key.trim()}>
          {checking ? 'Comprobando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

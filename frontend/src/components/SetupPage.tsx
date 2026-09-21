import { useState } from 'react'
import { rememberApiKey } from '../api/auth'
import { runSetup, type ServiceSetup } from '../api/setup'
import { testServiceConnections, type ServiceTestResult } from '../api/services'
import './SetupPage.css'

type ServiceKey = 'radarr' | 'sonarr' | 'amutorrent'

const SERVICES: { key: ServiceKey; label: string; placeholder: string; needsUser?: boolean }[] = [
  { key: 'radarr', label: 'Radarr', placeholder: 'http://localhost:7878' },
  { key: 'sonarr', label: 'Sonarr', placeholder: 'http://localhost:8989' },
  { key: 'amutorrent', label: 'aMuTorrent', placeholder: 'http://localhost:4000', needsUser: true },
]

const EMPTY: Record<ServiceKey, ServiceSetup> = {
  radarr: { url: '', api_key: '' },
  sonarr: { url: '', api_key: '' },
  amutorrent: { url: '', api_key: '', user: '', password: '' },
}

/**
 * First-run configuration.
 *
 * Shown instead of the key prompt on an install that has nothing configured.
 * Without it, a fresh deployment can only be set up by editing files on the
 * volume — and the settings page that would do it is behind a key that does not
 * exist yet.
 */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<Record<ServiceKey, ServiceSetup>>({ ...EMPTY })
  const [apiKey, setApiKey] = useState('')
  const [results, setResults] = useState<ServiceTestResult[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function update(key: ServiceKey, field: keyof ServiceSetup, value: string) {
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }))
  }

  const anyService = SERVICES.some(
    ({ key }) => form[key].url?.trim() || form[key].api_key?.trim(),
  )

  async function testConnections() {
    setBusy(true)
    setError('')
    try {
      const response = await testServiceConnections()
      setResults(response.results)
    } catch {
      setError('No se pudo comprobar. Revisa la conexión con el backend.')
    } finally {
      setBusy(false)
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await runSetup(form, apiKey.trim())
      // The key takes effect immediately, so the browser must already hold it
      // or the next request would be rejected.
      if (apiKey.trim()) rememberApiKey(apiKey.trim())
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la configuración')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-page">
      <form className="setup-card" onSubmit={save}>
        <h1>Bienvenido a Flow Controller</h1>
        <p className="setup-hint">
          Configura al menos un servicio para empezar. Todo se guarda cifrado y se puede
          cambiar después desde <strong>Configuración</strong>.
        </p>

        {SERVICES.map(({ key, label, placeholder, needsUser }) => (
          <fieldset key={key} className="setup-group">
            <legend>{label}</legend>
            <label className="setup-field">
              <span>URL</span>
              <input
                type="text"
                value={form[key].url ?? ''}
                placeholder={placeholder}
                onChange={(e) => update(key, 'url', e.target.value)}
                aria-label={`URL de ${label}`}
              />
            </label>
            <label className="setup-field">
              <span>API Key</span>
              <input
                type="password"
                value={form[key].api_key ?? ''}
                onChange={(e) => update(key, 'api_key', e.target.value)}
                aria-label={`API Key de ${label}`}
              />
            </label>
            {needsUser && (
              <>
                <label className="setup-field">
                  <span>Usuario</span>
                  <input
                    type="text"
                    value={form[key].user ?? ''}
                    onChange={(e) => update(key, 'user', e.target.value)}
                    aria-label={`Usuario de ${label}`}
                  />
                </label>
                <label className="setup-field">
                  <span>Contraseña</span>
                  <input
                    type="password"
                    value={form[key].password ?? ''}
                    onChange={(e) => update(key, 'password', e.target.value)}
                    aria-label={`Contraseña de ${label}`}
                  />
                </label>
              </>
            )}
          </fieldset>
        ))}

        <fieldset className="setup-group">
          <legend>Protección de la app</legend>
          <p className="setup-hint setup-hint-inline">
            Opcional. Sin clave, cualquiera que alcance el puerto puede entrar.
          </p>
          <label className="setup-field">
            <span>API key de la app</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label="API key de la app"
              placeholder="Déjalo vacío para no protegerla"
            />
          </label>
        </fieldset>

        {results && (
          <div className="setup-results">
            {results.map((result) => (
              <div key={result.key} className={`service-test ${result.ok ? 'ok' : 'fail'}`}>
                <div className="service-test-head">
                  <span className="service-test-name">
                    {result.ok ? '✅' : '❌'} {result.key}
                  </span>
                  <span className="service-test-url">{result.url}</span>
                </div>
                <div className="service-test-detail">{result.detail}</div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="setup-error" role="alert">
            {error}
          </div>
        )}

        <div className="setup-actions">
          <button type="button" className="action-btn" onClick={testConnections} disabled={busy}>
            🔌 Probar conexiones
          </button>
          <button
            type="submit"
            className="action-btn search-all"
            disabled={busy || (!anyService && !apiKey.trim())}
          >
            {busy ? 'Guardando…' : 'Guardar y entrar'}
          </button>
        </div>
      </form>
    </div>
  )
}

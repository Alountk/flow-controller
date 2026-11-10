/** «aMule API» — the Configuración card for it (amule-api-card).
 *
 * Anatomy copied from `AmuleEcSection` on the user's request: host, port and
 * password apart, a probe, the card's OWN «Guardar cambios» (the SAME
 * `saveMutation` through `onSave` — never a second save path), and a status
 * line. The line watches THIS service — the user's pick (status-api): it is
 * not the daemon watchdog badge of the EC card right above.
 *
 * The poll is plain on purpose, the watchdog's shape (one snapshot every 30 s,
 * no cache layer): a failed poll claims no state — absence beats a stale badge.
 * No call at all while unconfigured: «Sin configurar» is not «Caído».
 */

import { useEffect, useState } from 'react'
import { Field } from '../../shared/ui/Field.tsx'
import {
  testServiceConnections,
  probeService,
  type ServiceCandidate,
} from '../../shared/api/services.ts'
import { toast } from '../../shared/utils/toast.ts'
import './Settings.css'

export interface AmuleApiValues {
  url: string
  /** Like the EC's `ec_port`: a string from the form, a number if stored. */
  port: string | number
  password: string
}

const POLL_MS = 30_000

const VERDICT_LABELS = { vivo: 'Vivo', caido: 'Caído', sin: 'Sin configurar' } as const

export function AmuleApiSection({
  values,
  update,
  isRestarting = () => false,
  onSave,
  saving = false,
}: {
  values: AmuleApiValues
  update: (path: string, value: string) => void
  isRestarting?: (path: string) => boolean
  /** The SAME save as the header (`saveMutation` → POST /api/settings). */
  onSave: () => void
  /** Pending literal of that shared save: «Guardando...», like the EC card. */
  saving?: boolean
}) {
  const [pending, setPending] = useState(false)
  const [verdict, setVerdict] = useState<{ ok: boolean; detail: string } | null>(null)

  const configured = values.url.trim() !== '' && values.password !== ''

  useEffect(() => {
    if (!configured) {
      setVerdict(null)
      return
    }
    let active = true
    const load = () => {
      testServiceConnections('amuleapi')
        .then((answer) => {
          const hit = answer.results.find((r) => r.key === 'amuleapi')
          if (active) setVerdict(hit ? { ok: hit.ok, detail: hit.detail } : null)
        })
        .catch(() => {
          if (active) setVerdict(null)
        })
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [configured])

  async function runProbe() {
    setPending(true)
    try {
      const candidate: ServiceCandidate = { service: 'amuleapi' }
      const url = values.url.trim()
      if (url) candidate.url = url
      // Puerto con la misma regla de vacío que la url: ausente = guardada.
      const port = String(values.port).trim()
      if (port) candidate.port = port
      const password = values.password
      if (password !== '' && !password.startsWith('****')) candidate.password = password
      const result = await probeService(candidate)
      toast(result.detail, result.ok ? 'ok' : 'error')
    } catch {
      toast('No se pudo probar la conexión con el backend.', 'error')
    } finally {
      setPending(false)
    }
  }

  const badge = !configured
    ? VERDICT_LABELS.sin
    : verdict
      ? verdict.ok
        ? VERDICT_LABELS.vivo
        : VERDICT_LABELS.caido
      : null

  return (
    <section className="amule-ec-card">
      <div className="amule-ec-card-accent" aria-hidden="true" />
      <div className="amule-ec-card-head">
        <div className="amule-ec-card-heading">
          <h3 className="amule-ec-card-title">aMule API</h3>
        </div>
      </div>
      <div className="amule-ec-fields">
        <Field
          label="Host / URL"
          value={values.url}
          onChange={(v) => update('services.amuleapi.url', v)}
          restart={isRestarting('services.amuleapi.url')}
          placeholder="http://localhost"
        />
        <Field
          label="Puerto"
          value={values.port}
          onChange={(v) => update('services.amuleapi.port', v)}
          restart={isRestarting('services.amuleapi.port')}
          placeholder="4713"
        />
        <Field
          label="Contraseña"
          value={values.password}
          onChange={(v) => update('services.amuleapi.password', v)}
          restart={isRestarting('services.amuleapi.password')}
          type="password"
        />
      </div>
      <div className="amule-ec-watchdog">
        <span className="amule-ec-watchdog-caption">Estado del servicio:</span>
        {badge && (
          <span
            className={`amule-ec-watchdog-badge${
              badge === VERDICT_LABELS.caido ? ' amule-ec-watchdog-badge-problem' : ''
            }`}
          >
            {badge}
          </span>
        )}
      </div>
      {verdict ? (
        <p className="amule-ec-watchdog-detail" role="status">
          {verdict.detail}
        </p>
      ) : null}
      <div className="amule-ec-actions">
        <button
          type="button"
          className="settings-btn settings-btn-secondary"
          onClick={pending ? undefined : runProbe}
        >
          {pending ? 'Probando…' : 'Probar conexión'}
        </button>
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          onClick={saving ? undefined : onSave}
          disabled={saving}
        >
          {saving ? 'Guardando...' : 'Guardar cambios'}
        </button>
      </div>
    </section>
  )
}

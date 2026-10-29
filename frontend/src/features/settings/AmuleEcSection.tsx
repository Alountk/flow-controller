/** «aMule — conexión directa (EC)» — the Configuración card for it (config-submenu S2).
 *
 * Copy and layout come from `odd/tasks/config-submenu/stitch-12-general.html`
 * (the design source of truth — HTML, not screenshots). These settings belong
 * to the settings form (unlike `SharedDirsSection`, which writes aMule's own
 * files): the fields are plain `form.services.amule.*` bindings and only
 * «Guardar configuración» persists them. The password always arrives MASKED
 * from `GET /api/settings`; an empty or masked value on save keeps the stored
 * one — the backend applies that rule (`_restore_masked_secrets`), so the
 * frontend just shows and posts what the form holds.
 *
 * The probe («Probar conexión EC») is read-only: `POST /api/amule/test` does a
 * connect + EC handshake and closes. Its verdict comes back as `{ok, detail}`
 * and is surfaced with the F-13 toast. It probes WHAT THE FORM HOLDS NOW —
 * the values just typed, before saving them (the `POST /api/services/test`
 * candidate pattern, config-1x1 S1): an empty or masked field is omitted so
 * the stored value wins, which is the common path after the first save (the
 * password field then holds the mask GET returned). The click handler is
 * removed while a probe is pending instead of disabling the button — a guard
 * that also holds under jsdom, where a click on a disabled button still fires
 * handlers.
 *
 * config-1x1 T3 (S2) brings the card to STRICT 1:1 with the design: header
 * with the title + the exact subtitle and the «Protocolo Nativo» badge on the
 * right, the three fields in the design's row, and the note with «Indexadores»
 * as an ACCIONABLE link (liberty #2 of #224 — plain text — is undone) that
 * switches to the Indexadores panel. All styling lives in `Settings.css`
 * (liberty #3 — inline styles — is undone).
 *
 * config-1x1 T6 (S4, user amendment): the card gets its OWN «Guardar cambios»
 * beside «Probar conexión EC» («el boton de probar solo seria para probar la
 * conexion y si quiero guardar los datos un boton de guardar seria lo más
 * ideal»). It is the SAME save as the header — `saveMutation` →
 * `POST /api/settings` → `rebuild()` — reached through the `onSave` callback
 * (mirror of `onOpenIndexadores`), with the header's pending literal
 * («Guardando...») driven by `saving`. The probe remains a pure probe: it
 * never saves, and saving never re-probes (the save→probe chain is the
 * backend's `config.rebuild()`, not a frontend POST).
 */

import { useEffect, useState } from 'react'
import { Field } from '../../shared/ui/Field.tsx'
import {
  testAmuleEc,
  getAmuleHealth,
  type AmuleEcCandidate,
  type AmuleHealth,
} from '../../shared/api/services.ts'
import { toast } from '../../shared/utils/toast.ts'
import './Settings.css'

export interface AmuleEcValues {
  url: string
  /** A string from the env-backed defaults ("4712"); a number if settings.json
   *  stored one. The sibling service fields behave the same way. */
  ec_port: string | number
  ec_password: string
}

/** What «Probar conexión EC» sends: the CURRENT form values, with the same
 *  mask/empty rules the backend applies to a save (`_restore_masked_secrets`).
 *  An empty field is omitted (stored wins); the masked round-trip
 *  (`****…`, what GET returns for the stored secret) is NEVER a password —
 *  omitting it is exactly what makes the stored one win. The password is
 *  never trimmed: spaces are legal in it. */
function candidateFrom(values: AmuleEcValues): AmuleEcCandidate {
  const candidate: AmuleEcCandidate = {}
  const url = values.url.trim()
  if (url) candidate.url = url
  const port = String(values.ec_port).trim()
  if (port) candidate.ec_port = values.ec_port
  const password = values.ec_password
  if (password !== '' && !password.startsWith('****')) {
    candidate.ec_password = password
  }
  return candidate
}

const HEALTH_POLL_MS = 30_000

const HEALTH_LABELS: Record<AmuleHealth['state'], string> = {
  sano: 'Sano',
  'sin-datos': 'Sin datos',
  'sin-configurar': 'Sin configurar',
  colgado: 'Colgado',
  reiniciando: 'Reiniciando…',
  recuperado: 'Recuperado',
  alerta: 'Alerta',
}

export function AmuleEcSection({
  values,
  update,
  isRestarting = () => false,
  onOpenIndexadores,
  onSave,
  saving = false,
}: {
  values: AmuleEcValues
  update: (path: string, value: string) => void
  isRestarting?: (path: string) => boolean
  /** El enlace «Indexadores» de la nota conmuta al panel Indexadores. */
  onOpenIndexadores: () => void
  /** T6/S4 — «Guardar cambios» local: el MISMO guardado que la cabecera
   *  (`saveMutation` → `POST /api/settings`), nunca una vía aparte. */
  onSave: () => void
  /** Estado pendiente del guardado compartido; copia «Guardando...», la de la
   *  cabecera. */
  saving?: boolean
}) {
  const [pending, setPending] = useState(false)
  const [health, setHealth] = useState<AmuleHealth | null>(null)

  // Plain poll on purpose (amule-watchdog S6): one snapshot every 30 s, no cache layer.
  useEffect(() => {
    let active = true
    const load = () => {
      getAmuleHealth()
        .then((snapshot) => {
          if (active) setHealth(snapshot)
        })
        // A failed poll claims no state: absence beats a stale badge.
        .catch(() => {
          if (active) setHealth(null)
        })
    }
    load()
    const id = setInterval(load, HEALTH_POLL_MS)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  async function probe() {
    setPending(true)
    try {
      const result = await testAmuleEc(candidateFrom(values))
      toast(result.detail, result.ok ? 'ok' : 'error')
    } catch {
      toast('No se pudo probar la conexión EC con el backend.', 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="amule-ec-card">
      <div className="amule-ec-card-accent" aria-hidden="true" />
      <div className="amule-ec-card-head">
        <div className="amule-ec-card-heading">
          <h3 className="amule-ec-card-title">aMule — conexión directa (EC)</h3>
          <p className="amule-ec-card-subtitle">
            External Connection (EC) para telemetría directa con el core aMuled.
          </p>
        </div>
        <span className="amule-ec-badge">Protocolo Nativo</span>
      </div>
      <div className="amule-ec-fields">
        <Field
          label="Host / URL"
          value={values.url}
          onChange={(v) => update('services.amule.url', v)}
          restart={isRestarting('services.amule.url')}
          placeholder="http://localhost"
        />
        <Field
          label="Puerto"
          value={values.ec_port}
          onChange={(v) => update('services.amule.ec_port', v)}
          restart={isRestarting('services.amule.ec_port')}
          placeholder="4712"
        />
        <Field
          label="Contraseña EC"
          value={values.ec_password}
          onChange={(v) => update('services.amule.ec_password', v)}
          restart={isRestarting('services.amule.ec_password')}
          type="password"
        />
      </div>
      <div className="amule-ec-watchdog">
        <span className="amule-ec-watchdog-caption">Estado del watchdog:</span>
        {health && HEALTH_LABELS[health.state] && (
          <span
            className={`amule-ec-watchdog-badge${
              health.state === 'colgado' || health.state === 'alerta' || health.state === 'reiniciando'
                ? ' amule-ec-watchdog-badge-problem'
                : ''
            }`}
          >
            {HEALTH_LABELS[health.state]}
          </span>
        )}
      </div>
      {health?.detail ? (
        <p className="amule-ec-watchdog-detail" role="status">
          {health.detail}
        </p>
      ) : null}
      <div className="amule-ec-actions">
        <button
          type="button"
          className="settings-btn settings-btn-secondary"
          onClick={pending ? undefined : probe}
        >
          {pending ? 'Probando…' : 'Probar conexión EC'}
        </button>
        {/* T6/S4 — el guardado del usuario, junto a la sonda (que sigue sin
            guardar). Mismo saveMutation que la cabecera, vía onSave. */}
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          onClick={saving ? undefined : onSave}
          disabled={saving}
        >
          {saving ? 'Guardando...' : 'Guardar cambios'}
        </button>
      </div>
      <div className="amule-ec-note">
        <p className="amule-ec-note-text">
          <strong>Nota:</strong> Es la conexión al daemon aMule por el protocolo EC (eD2k/Kad).
          No es un indexador Torznab: los indexadores se configuran en la pestaña{' '}
          <a
            className="amule-ec-note-link"
            href="#"
            onClick={(e) => {
              e.preventDefault()
              onOpenIndexadores()
            }}
          >
            Indexadores
          </a>
          .
        </p>
      </div>
    </section>
  )
}

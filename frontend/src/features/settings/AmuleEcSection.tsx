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
 * and is surfaced with the F-13 toast. The click handler is removed while a
 * probe is pending instead of disabling the button — a guard that also holds
 * under jsdom, where a click on a disabled button still fires handlers.
 */

import { useState } from 'react'
import { Field } from '../../shared/ui/Field.tsx'
import { testAmuleEc } from '../../shared/api/services.ts'
import { toast } from '../../shared/utils/toast.ts'
import './Settings.css'

export interface AmuleEcValues {
  url: string
  /** A string from the env-backed defaults ("4712"); a number if settings.json
   *  stored one. The sibling service fields behave the same way. */
  ec_port: string | number
  ec_password: string
}

/** The card's distinctive look (mockup: highlighted border + left accent bar).
 *  Inline styles on purpose: `Settings.css` is outside this task's edit
 *  surfaces, and the accent exists only for this card. */
const cardStyle: React.CSSProperties = {
  border: '2px solid var(--accent, #b48ead)',
  borderLeft: '6px solid var(--accent, #b48ead)',
  background: 'var(--surface-1)',
}

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid var(--accent, #b48ead)',
  color: 'var(--text)',
  fontSize: 11,
  fontWeight: 600,
}

export function AmuleEcSection({
  values,
  update,
  isRestarting = () => false,
}: {
  values: AmuleEcValues
  update: (path: string, value: string) => void
  isRestarting?: (path: string) => boolean
}) {
  const [pending, setPending] = useState(false)

  async function probe() {
    setPending(true)
    try {
      const result = await testAmuleEc()
      toast(result.detail, result.ok ? 'ok' : 'error')
    } catch {
      toast('No se pudo probar la conexión EC con el backend.', 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">aMule — conexión directa (EC)</h3>
      <div className="settings-group amule-ec-card" style={cardStyle}>
        <p className="settings-hint">
          <strong>External Connection (EC)</strong> para telemetría directa con el core aMuled.{' '}
          <span style={badgeStyle}>Protocolo Nativo</span>
        </p>
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
        <div className="settings-logs-controls">
          <button
            type="button"
            className="action-btn"
            onClick={pending ? undefined : probe}
          >
            {pending ? 'Probando…' : 'Probar conexión EC'}
          </button>
        </div>
        <p className="shared-dirs-hint">
          <strong>Nota:</strong> Es la conexión al daemon aMule por el protocolo EC (eD2k/Kad).
          No es un indexador Torznab: los indexadores se configuran en la pestaña Indexadores.
        </p>
      </div>
    </div>
  )
}

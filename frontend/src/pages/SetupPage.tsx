import { useEffect, useState } from 'react'
import { apiFetch, rememberApiKey } from '../shared/api/auth.ts'
import { saveSetupStep, type SetupSaveResult, type SetupStepBody } from '../shared/api/setup.ts'
import { probeService, type ServiceTestResult } from '../shared/api/services.ts'
import { Field } from '../shared/ui/Field.tsx'
import './SetupPage.css'

/**
 * First-run setup wizard.
 *
 * Shown instead of the key prompt on an install that has nothing configured.
 * Structure follows `prototypes/setup-02-focus-card.html`: one centred card,
 * a counter row with dots instead of a step list, and Atrás/Siguiente only —
 * there is no jump-to-step. Verification follows `setup-03-verify-inline.html`
 * (an inline probe under each service field).
 *
 * Three backend constraints shape every decision here:
 *
 * 1. Each step saves with `POST /api/setup`, sending only its own group. That
 *    endpoint is partial-safe and anonymous while unconfigured; `POST
 *    /api/settings` is NOT partial-safe and would reset every omitted group.
 * 2. The `['setup']` query is never invalidated until `onDone`: `needs_setup`
 *    flips to false as soon as one service has url+api_key, and invalidating
 *    it mid-wizard unmounts the wizard.
 * 3. Step 7 is the last step that can write — after the app key exists,
 *    `POST /api/setup` answers 403. The key is remembered the moment step 7
 *    saves, and step 8 sends nothing.
 *
 * Product rule: Radarr and Sonarr are required — at least one of them — while
 * aMuTorrent is optional. Steps 2-4 are all skippable while walking through;
 * the requirement is enforced once, on step 8.
 */

type ServiceKey = 'radarr' | 'sonarr' | 'amutorrent'
type Tone = 'ok' | 'fail' | 'warn'

type StepId =
  | 'welcome'
  | 'radarr'
  | 'sonarr'
  | 'amutorrent'
  | 'paths'
  | 'advanced'
  | 'protect'
  | 'review'

const STEPS: StepId[] = [
  'welcome',
  'radarr',
  'sonarr',
  'amutorrent',
  'paths',
  'advanced',
  'protect',
  'review',
]

const SERVICE_LABEL: Record<ServiceKey, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  amutorrent: 'aMuTorrent',
}

/** The step heading — only aMuTorrent differs from its service label. */
const STEP_HEADING: Record<ServiceKey, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  amutorrent: 'aMuTorrent (opcional)',
}

const SERVICE_PLACEHOLDER: Record<ServiceKey, string> = {
  radarr: 'http://localhost:7878',
  sonarr: 'http://localhost:8989',
  amutorrent: 'http://localhost:4000',
}

/**
 * Service fields start empty (they are credentials only the user has); the
 * engine settings start from the backend defaults so a step that saves them
 * cannot wipe values the deployment already had. GET /api/settings overlays
 * the real values on mount.
 */
const DEFAULT_FORM: Record<string, string> = {
  'services.radarr.url': '',
  'services.radarr.api_key': '',
  'services.sonarr.url': '',
  'services.sonarr.api_key': '',
  'services.amutorrent.url': '',
  'services.amutorrent.api_key': '',
  'services.amutorrent.user': '',
  'services.amutorrent.password': '',
  'paths.download_amule': '/mnt/storage-6tb/shared-downloads/amule',
  'paths.download_torrent': '/mnt/storage/downloads/qbittorrent/completed',
  'paths.allowed_roots': '/mnt/storage, /mnt/storage-6tb',
  'intervals.check': '15',
  'intervals.max_retries': '3',
  'intervals.retry_delay': '2',
  'intervals.request_timeout': '5',
  'intervals.import_timeout': '40',
  'tracing.limit': '25',
  'server.port': '8000',
}

type ProbeState =
  | { status: 'probing' }
  | { status: 'done'; ok: boolean; tone: Tone; text: string; url: string }

/**
 * The four outcomes the API distinguishes, mapped from `error_kind`.
 *
 * `http` (a non-auth failure like a 500) folds into "no se pudo conectar":
 * the documented outcome set has four states and no separate HTTP-error one.
 */
function probeOutcome(result: ServiceTestResult): { tone: Tone; text: string } {
  if (result.ok) {
    return { tone: 'ok', text: result.version ? `✓ Conectado (${result.version})` : '✓ Conectado' }
  }
  if (result.error_kind === 'auth') {
    const status = /HTTP (\d+)/.exec(result.detail)?.[1] ?? '401'
    return { tone: 'fail', text: `✗ API key rechazada (HTTP ${status})` }
  }
  if (result.error_kind === 'timeout') {
    return { tone: 'warn', text: '⏱ no respondió a tiempo' }
  }
  return { tone: 'fail', text: '⚠ no se pudo conectar' }
}

/** Flatten the groups the wizard owns out of a GET /api/settings response. */
function seedFromSettings(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const group of ['paths', 'intervals', 'tracing', 'server']) {
    const value = data[group]
    if (!value || typeof value !== 'object') continue
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (group === 'paths' && key === 'allowed_roots') {
        if (Array.isArray(raw)) {
          out['paths.allowed_roots'] = raw.filter((s): s is string => typeof s === 'string').join(', ')
        }
        continue
      }
      if (typeof raw === 'string' || typeof raw === 'number') out[`${group}.${key}`] = String(raw)
    }
  }
  return out
}

export function SetupPage({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState(0)
  const [form, setForm] = useState<Record<string, string>>({ ...DEFAULT_FORM })
  const [apiKey, setApiKey] = useState('')
  const [probes, setProbes] = useState<Partial<Record<ServiceKey, ProbeState>>>({})
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // True once the app key exists: from then on POST /api/setup answers 403,
  // so every earlier step becomes read-only instead of failing on save.
  const [writeLocked, setWriteLocked] = useState(false)

  // Show what the deployment actually has, not just the defaults: a step that
  // re-saves a group must not clobber values set through the environment.
  useEffect(() => {
    let active = true
    apiFetch('/api/settings')
      .then((res) => (res.ok ? (res.json() as Promise<Record<string, unknown>>) : null))
      .then((data) => {
        if (!active || !data) return
        setForm((prev) => ({ ...prev, ...seedFromSettings(data) }))
      })
      .catch(() => {
        // The defaults are good enough to keep the wizard usable.
      })
    return () => {
      active = false
    }
  }, [])

  const step = STEPS[current]
  const f = form

  function update(path: string, value: string) {
    setForm((prev) => ({ ...prev, [path]: value }))
  }

  // Going back is always allowed; forward movement is Siguiente only, so a
  // step index beyond the current one never has to be addressed.
  function back() {
    if (busy || current === 0) return
    setCurrent((c) => c - 1)
  }

  // Step 8 gate: at least one of Radarr/Sonarr must have url+API key.
  // aMuTorrent contributes nothing. This set is a strict subset of the old
  // "some service configured or an app key exists" floor, so whenever Entrar
  // is enabled `needs_setup` has already flipped — `onDone` invalidating the
  // ['setup'] query can never bounce straight back into the wizard.
  const arrConfigured = (['radarr', 'sonarr'] as ServiceKey[]).some(
    (key) => f[`services.${key}.url`].trim() && f[`services.${key}.api_key`].trim(),
  )
  const canEnter = arrConfigured

  function numberOr(path: string): number {
    const raw = f[path].trim()
    const parsed = Number(raw)
    return raw !== '' && Number.isFinite(parsed) ? parsed : Number(DEFAULT_FORM[path])
  }

  function stepBody(id: StepId): SetupStepBody | null {
    switch (id) {
      case 'radarr':
      case 'sonarr':
        return {
          services: { [id]: { url: f[`services.${id}.url`], api_key: f[`services.${id}.api_key`] } },
        }
      case 'amutorrent':
        return {
          services: {
            amutorrent: {
              url: f['services.amutorrent.url'],
              api_key: f['services.amutorrent.api_key'],
              user: f['services.amutorrent.user'],
              password: f['services.amutorrent.password'],
            },
          },
        }
      case 'paths':
        return {
          paths: {
            download_amule: f['paths.download_amule'],
            download_torrent: f['paths.download_torrent'],
            allowed_roots: f['paths.allowed_roots']
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        }
      case 'advanced':
        return {
          intervals: {
            check: numberOr('intervals.check'),
            max_retries: numberOr('intervals.max_retries'),
            retry_delay: numberOr('intervals.retry_delay'),
            request_timeout: numberOr('intervals.request_timeout'),
            import_timeout: numberOr('intervals.import_timeout'),
          },
          tracing: { limit: numberOr('tracing.limit') },
          server: { port: numberOr('server.port') },
        }
      case 'protect':
        return { api_key: apiKey.trim() }
      default:
        return null
    }
  }

  function applyNotice(res: SetupSaveResult) {
    if (res.persisted === false) {
      // Applied in memory, not on disk: the config volume is read-only.
      setNotice({
        tone: 'fail',
        text: 'No se pudo escribir el archivo de configuración: el volumen es de solo lectura. Los cambios se aplicaron solo en memoria.',
      })
    } else if (res.restart_required?.length) {
      setNotice({ tone: 'warn', text: `Guardado. Reinicia para aplicar: ${res.restart_required.join(', ')}` })
    } else {
      setNotice(null)
    }
  }

  async function goNext() {
    if (busy) return
    if (step === 'review') {
      // Step 8 writes nothing.
      onDone()
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = stepBody(step)
      if (body && !writeLocked) {
        const res = await saveSetupStep(body)
        applyNotice(res)
        if (step === 'protect' && apiKey.trim()) {
          // The key takes effect immediately: every later request needs
          // X-Api-Key, or a 401 sends the user to the AuthGate.
          rememberApiKey(apiKey.trim())
          setWriteLocked(true)
        }
      }
      setCurrent((c) => c + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la configuración')
    } finally {
      setBusy(false)
    }
  }

  async function probe(key: ServiceKey) {
    setProbes((prev) => ({ ...prev, [key]: { status: 'probing' } }))
    try {
      const result = await probeService({
        service: key,
        url: f[`services.${key}.url`],
        api_key: f[`services.${key}.api_key`],
        ...(key === 'amutorrent'
          ? { user: f['services.amutorrent.user'], password: f['services.amutorrent.password'] }
          : {}),
      })
      const { tone, text } = probeOutcome(result)
      setProbes((prev) => ({
        ...prev,
        [key]: { status: 'done', ok: result.ok, tone, text, url: result.url },
      }))
    } catch {
      setProbes((prev) => ({
        ...prev,
        [key]: {
          status: 'done',
          ok: false,
          tone: 'fail',
          text: '⚠ no se pudo conectar',
          url: f[`services.${key}.url`],
        },
      }))
    }
  }

  function field(
    path: string,
    label: string,
    opts: { ariaLabel?: string; type?: string; placeholder?: string; restart?: boolean } = {},
  ) {
    return (
      <Field
        label={label}
        ariaLabel={opts.ariaLabel}
        type={opts.type}
        placeholder={opts.placeholder}
        restart={opts.restart}
        disabled={writeLocked}
        value={f[path] ?? ''}
        onChange={(v) => update(path, v)}
      />
    )
  }

  function probeCard(key: ServiceKey) {
    const p = probes[key]
    const probing = p?.status === 'probing'
    const done = p && p.status === 'done'
    const toneClass = done ? (p.tone === 'ok' ? 'ok' : p.tone === 'warn' ? 'warn' : 'fail') : ''
    return (
      <div className="setup-probe-row">
        <button
          type="button"
          className="action-btn"
          onClick={() => probe(key)}
          disabled={busy || Boolean(probing) || !f[`services.${key}.url`].trim()}
        >
          {probing ? 'Probando…' : 'Probar conexión'}
        </button>
        <div
          className={`service-test setup-probe-result ${toneClass}`}
          role={done && !p.ok ? 'alert' : undefined}
        >
          <div className="service-test-head">
            <span className="service-test-name">{key}</span>
            <span className="service-test-url">
              {done ? p.url : f[`services.${key}.url`] || '—'}
            </span>
          </div>
          <div className="service-test-detail">
            {probing ? '… comprobando' : done ? p.text : 'Sin comprobar'}
          </div>
        </div>
      </div>
    )
  }

  function serviceStep(key: ServiceKey) {
    const lede: Record<ServiceKey, string> = {
      radarr: 'Se usa para localizar e importar películas. Puedes probar la conexión antes de guardar nada.',
      sonarr:
        'Se usa para localizar e importar series. Una API key incorrecta se reporta como tal, no como un servicio caído.',
      amutorrent:
        'Gestor de descargas. Es opcional: basta con Radarr o Sonarr para terminar el asistente.',
    }
    return (
      <>
        <h2>{STEP_HEADING[key]}</h2>
        <p className="setup-lede">{lede[key]}</p>
        <div className="setup-form">
          {field(`services.${key}.url`, 'URL', {
            ariaLabel: `URL de ${SERVICE_LABEL[key]}`,
            placeholder: SERVICE_PLACEHOLDER[key],
          })}
          {field(`services.${key}.api_key`, 'API Key', {
            ariaLabel: `API Key de ${SERVICE_LABEL[key]}`,
            type: 'password',
          })}
          {key === 'amutorrent' && (
            <>
              {field('services.amutorrent.user', 'Usuario', { ariaLabel: 'Usuario de aMuTorrent' })}
              {field('services.amutorrent.password', 'Contraseña', {
                ariaLabel: 'Contraseña de aMuTorrent',
                type: 'password',
              })}
            </>
          )}
          {probeCard(key)}
        </div>
      </>
    )
  }

  function summaryRow(label: string, value: string, right: React.ReactNode) {
    return (
      <div className="setup-sum-row">
        <span className="sum-k">{label}</span>
        <span className="sum-v">{value}</span>
        {right}
      </div>
    )
  }

  /**
   * Review row for one service: configured state first, then whatever its
   * last probe said. An unconfigured optional service reads as a choice, not
   * as a failure.
   */
  function summaryService(key: ServiceKey) {
    const p = probes[key]
    const done = p && p.status === 'done'
    const url = f[`services.${key}.url`].trim()
    const configured = Boolean(url && f[`services.${key}.api_key`].trim())
    const state = configured
      ? url
      : key === 'amutorrent'
        ? 'Sin configurar (opcional)'
        : 'Sin configurar'
    return summaryRow(
      SERVICE_LABEL[key],
      state,
      <span className={`setup-result ${done ? p.tone : ''}`}>
        {done ? p.text : 'Sin comprobar'}
      </span>,
    )
  }

  function stepContent() {
    switch (step) {
      case 'welcome':
        return (
          <>
            <h2>Bienvenido a Flow Controller</h2>
            <p className="setup-lede">
              Este asistente deja Flow Controller listo para usar en la primera ejecución.
              Configura lo esencial ahora; todo lo demás se cambia después desde{' '}
              <strong>Configuración</strong>.
            </p>
            <ul className="setup-checklist">
              <li>
                <span className="ico">🎬</span>
                <span>
                  <strong>Radarr</strong> — URL y clave de la API para localizar e importar películas.
                </span>
              </li>
              <li>
                <span className="ico">📺</span>
                <span>
                  <strong>Sonarr</strong> — URL y clave de la API para series.
                </span>
              </li>
              <li>
                <span className="ico">⬇️</span>
                <span>
                  <strong>aMuTorrent (opcional)</strong> — URL, clave, usuario y contraseña del
                  gestor de descargas.
                </span>
              </li>
              <li>
                <span className="ico">📁</span>
                <span>
                  <strong>Rutas</strong> — carpetas de descarga y raíces permitidas.
                </span>
              </li>
              <li>
                <span className="ico">🛡️</span>
                <span>
                  <strong>Protección</strong> — clave de la app para cerrar el puerto.
                </span>
              </li>
            </ul>
            <p className="setup-hint">
              Cada paso guarda lo suyo. Nada se escribe en el paso final.
            </p>
          </>
        )
      case 'radarr':
      case 'sonarr':
      case 'amutorrent':
        return serviceStep(step)
      case 'paths':
        return (
          <>
            <h2>Rutas</h2>
            <p className="setup-lede">Dónde caen las descargas y qué carpetas puede tocar la app.</p>
            <div className="setup-form">
              {field('paths.download_amule', 'Carpeta descargas aMuTorrent')}
              {field('paths.download_torrent', 'Carpeta descargas Torrent')}
              {field('paths.allowed_roots', 'Raíces permitidas (separadas por coma)')}
            </div>
            <p className="setup-hint">
              Separadas por comas. La app no trabajará fuera de estas raíces.
            </p>
          </>
        )
      case 'advanced':
        return (
          <>
            <h2>Ajustes</h2>
            <p className="setup-lede">
              Tiempos y límites del motor. Estos valores se aplican al instante, salvo el puerto.
            </p>
            <div className="setup-form setup-grid">
              {field('intervals.check', 'Check interval (segundos)', { type: 'number' })}
              {field('intervals.max_retries', 'Max reintentos', { type: 'number' })}
              {field('intervals.retry_delay', 'Delay entre reintentos (segundos)', { type: 'number' })}
              {field('intervals.request_timeout', 'Timeout peticiones HTTP (segundos)', {
                type: 'number',
              })}
              {field('intervals.import_timeout', 'Timeout import (segundos)', { type: 'number' })}
              {field('tracing.limit', 'Límite de trazas', { type: 'number' })}
            </div>
            {field('server.port', 'Puerto', { type: 'number', restart: true })}
            <p className="setup-hint">
              Solo el puerto necesita reiniciar el contenedor. El resto se aplica sin reiniciar.
            </p>
          </>
        )
      case 'protect':
        return (
          <>
            <h2>Proteger la app</h2>
            <p className="setup-lede">Última escritura del asistente.</p>
            <div className="setup-form">
              <Field
                label="API key de la app"
                type="password"
                placeholder="Déjalo vacío para no protegerla"
                disabled={writeLocked}
                value={apiKey}
                onChange={setApiKey}
              />
            </div>
            <p className="setup-callout">
              🛡️ Sin clave, cualquiera que alcance el puerto puede entrar. Con la clave definida, el
              endpoint de primera ejecución responde 403: este asistente ya no puede escribir — por
              eso es el último paso que guarda.
            </p>
          </>
        )
      case 'review':
        return (
          <>
            <h2>Revisar y entrar</h2>
            <p className="setup-lede">
              Resumen de lo guardado y resultado de las comprobaciones. Este paso no escribe nada.
            </p>
            <div className="setup-summary">
              {(['radarr', 'sonarr', 'amutorrent'] as ServiceKey[]).map(summaryService)}
              {summaryRow(
                'Descargas aMuTorrent',
                f['paths.download_amule'] || '(sin definir)',
                <span className="sum-k">guardado</span>,
              )}
              {summaryRow(
                'Descargas Torrent',
                f['paths.download_torrent'] || '(sin definir)',
                <span className="sum-k">guardado</span>,
              )}
              {summaryRow(
                'Raíces permitidas',
                f['paths.allowed_roots'] || '(ninguna)',
                <span className="sum-k">guardado</span>,
              )}
              {summaryRow(
                'Ajustes',
                `${f['intervals.check']} s · ${f['intervals.max_retries']} reintentos · ${f['intervals.retry_delay']} s · ${f['intervals.request_timeout']} s · ${f['intervals.import_timeout']} s · trazas ${f['tracing.limit']}`,
                <span className="sum-k">aplicado</span>,
              )}
              {summaryRow(
                'Puerto',
                f['server.port'],
                <span className="settings-restart-badge">Requiere reinicio</span>,
              )}
              {summaryRow(
                'Protección',
                apiKey.trim() ? 'Clave de la app definida' : 'Sin clave de la app',
                <span className="sum-k">{apiKey.trim() ? 'protegida' : 'abierto'}</span>,
              )}
            </div>
            {!canEnter && (
              <p className="setup-hint setup-enter-hint">
                Configura Radarr o Sonarr para continuar
              </p>
            )}
            <p className="setup-hint">
              Para corregir algo, vuelve con Atrás. Al entrar, la configuración queda tal cual está
              aquí.
            </p>
          </>
        )
    }
  }

  return (
    <div className="setup-page">
      <main className="setup-card">
        <div className="setup-counter">
          <span className="setup-count">{`${current + 1} de ${STEPS.length}`}</span>
          <span className="setup-dots" aria-hidden="true">
            {STEPS.map((id, i) => (
              <span
                key={id}
                className={`setup-dot${i === current ? ' is-now' : i < current ? ' is-done' : ''}`}
              />
            ))}
          </span>
        </div>

        {notice && (
          <div
            className={`setup-notice ${notice.tone}`}
            role={notice.tone === 'fail' ? 'alert' : 'status'}
          >
            {notice.text}
          </div>
        )}
        {writeLocked && step !== 'welcome' && step !== 'review' && (
          <div className="setup-notice warn" role="status">
            La clave de la app ya está definida: este paso ya no puede escribir. Los cambios se
            hacen después, desde Configuración.
          </div>
        )}

        <section className="setup-step">{stepContent()}</section>

        {error && (
          <div className="setup-error" role="alert">
            {error}
          </div>
        )}

        <footer className="setup-nav">
          <button
            type="button"
            className="action-btn setup-back"
            onClick={back}
            disabled={current === 0 || busy}
          >
            Atrás
          </button>
          <div className="setup-nav-right">
            {step === 'protect' && <span className="setup-gate">Último paso que guarda</span>}
            <button
              type="button"
              className="action-btn setup-primary"
              onClick={goNext}
              disabled={busy || (step === 'review' && !canEnter)}
            >
              {current === 0 ? 'Empezar' : step === 'review' ? 'Entrar' : 'Siguiente'}
            </button>
          </div>
        </footer>
      </main>
    </div>
  )
}

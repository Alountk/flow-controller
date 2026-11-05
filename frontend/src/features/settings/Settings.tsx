import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Settings, SaveSettingsResponse } from '../../shared/types.ts'
import { apiFetch } from '../../shared/api/auth.ts'
import {
  fetchServices,
  probeService,
  testServiceConnections,
  testNotification,
  type ServiceCandidate,
  type ServiceListing,
  type ServiceTestResult,
} from '../../shared/api/services.ts'
import { toast } from '../../shared/utils/toast.ts'
import { SharedDirsSection } from './SharedDirsSection.tsx'
import { QualityThresholdSection } from './QualityThresholdSection.tsx'
import { IndexadoresSection } from './IndexadoresSection.tsx'
import { AmuleEcSection, type AmuleEcValues } from './AmuleEcSection.tsx'
import { AmuleServerActions } from './AmuleServerActions.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import './Settings.css'

interface LogEntry {
  time: string
  level: string
  message: string
}

/** Fila de «Estado de las conexiones»: lo configurado antes de sondear, el
 *  resultado medido después. `unprobed` no es un fallo: es que nadie pulsó
 *  «Probar conexiones», y la sección nunca sondea al montar. `external` es
 *  aMule: su sonda es EC sobre TCP, no HTTP, así que este botón nunca lo
 *  comprobará y la fila no puede decir «Sin comprobar» para siempre. */
type ConnectionState = 'ok' | 'fail' | 'unconfigured' | 'unprobed' | 'external'

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  ok: 'Conectado',
  fail: 'Alerta',
  unconfigured: 'No configurado',
  unprobed: 'Sin comprobar',
  external: 'Sin sonda',
}

/** El nombre que ve el usuario, no la clave del backend: la tabla del diseño
 *  escribe «Radarr» y «aMuTorrent», y `services[].key` es lo que es.
 *  Una clave desconocida cae al propio key, nunca a vacío. */
const SERVICE_NAME: Record<string, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  prowlarr: 'Prowlarr',
  amutorrent: 'aMuTorrent',
  amuleapi: 'aMule API',
  qbit: 'qBittorrent',
  amule: 'aMule',
  opensubtitles: 'OpenSubtitles',
}

interface ConnectionRow {
  service: ServiceListing
  name: string
  state: ConnectionState
  latency: string
  url: string
  reason: string
  hint: string
}

/** Los servicios cuyo sondeo no es HTTP: aMule responde por EC (TCP), así que
 *  el botón de la sección no lo toca y la fila lo dice en vez de quedarse
 *  eternamente en «Sin comprobar». */
const NOT_PROBED_KIND = new Set(['amule'])

function connectionRows(
  services: ServiceListing[] | undefined,
  probes: Map<string, ServiceTestResult>,
): ConnectionRow[] {
  return (services ?? []).map((service) => {
    const probe = probes.get(service.key)
    const external = NOT_PROBED_KIND.has(service.kind)
    const state: ConnectionState = !service.configured
      ? 'unconfigured'
      : external
        ? 'external'
        : probe
          ? (probe.ok ? 'ok' : 'fail')
          : 'unprobed'
    // Un timeout gana a la medida: los milisegundos que tardó en rendirse no
    // son una latencia que nadie quiera leer. Y sin sondeo real no hay medida:
    // un «0ms» en una fila «No configurado» sería inventado.
    const measured = state === 'ok' || state === 'fail'
    const latency = !probe || !measured
      ? '—'
      : probe.error_kind === 'timeout'
        ? 'Timeout'
        : probe.elapsed_ms != null
          ? `${probe.elapsed_ms}ms`
          : '—'
    // La URL del sondeo manda sobre la guardada: durante una migración a proxy
    // la pregunta es a qué host se llamó de verdad. Y el motivo del fallo se
    // conserva —«API key rechazada» es justo lo que el usuario viene a leer—.
    return {
      service,
      name: SERVICE_NAME[service.key] ?? service.key,
      state,
      latency,
      url: probe?.url || service.url,
      reason: state === 'fail' ? (probe?.detail ?? '') : '',
      hint: external ? 'aMule responde por EC (TCP): este botón no lo sondea' : '',
    }
  })
}

function LogsSection() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function fetchLogs() {
    setLoading(true)
    try {
      const res = await apiFetch('/api/logs', {})
      if (res.ok) {
        const data = await res.json() as { logs: LogEntry[] }
        setLogs(data.logs)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
  }, [])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchLogs, 3000)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  return (
    <Section
        icon="📜"
        title="Logs del Sistema"
        subtitle="Últimas líneas del registro del panel, para ver qué hizo el orquestador."
      >
      <div className="settings-logs-controls">
        <button className="action-btn" onClick={fetchLogs} disabled={loading}>
          {loading ? 'Cargando...' : '🔄 Actualizar'}
        </button>
        <label className="settings-toggle-label" htmlFor="settings-auto-refresh">
          <button
            className={`settings-toggle ${autoRefresh ? 'on' : 'off'}`}
            id="settings-auto-refresh"
            name="settings-auto-refresh"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? 'Sí' : 'No'}
          </button>
          Auto-refresh (3s)
        </label>
      </div>
      <div className="settings-logs-scroll" ref={scrollRef}>
        {logs.length === 0 ? (
          <div className="settings-logs-empty">No hay logs recientes (solo se muestran WARN+)</div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className={`settings-log-entry log-${entry.level.toLowerCase()}`}>
              <span className="log-time">{entry.time}</span>
              <span className={`log-level log-level-${entry.level.toLowerCase()}`}>{entry.level}</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </Section>
  )
}

async function fetchSettings(): Promise<Settings> {
  const res = await apiFetch('/api/settings', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<Settings>
}

async function saveSettings(data: Settings): Promise<SaveSettingsResponse> {
  const res = await apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<SaveSettingsResponse>
}

/** Cabecera de tarjeta del diseño (S2): icono, título y el subtítulo que
 *  explica para qué sirve el grupo. El icono es decorativo —el título ya lo
 *  dice— así que se esconde al lector de pantalla. */
function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: string
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span className="settings-section-icon" aria-hidden="true">{icon}</span>
        <div>
          <h3 className="settings-section-title">{title}</h3>
          <p className="settings-section-subtitle">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

/** The form also binds `services.amule.*` (config-submenu S2). The group is
 *  optional in the payload (its defaults are env-backed and may never have
 *  been saved), so it is seeded here: `update()` writes nested paths and
 *  needs the object to exist. */
type SettingsForm = Settings & { services: Settings['services'] & { amule?: AmuleEcValues } }

function withAmuleEc(data: Settings): SettingsForm {
  const next = JSON.parse(JSON.stringify(data)) as SettingsForm
  const amule = next.services.amule
  next.services.amule = {
    url: amule?.url ?? '',
    ec_port: amule?.ec_port ?? '',
    ec_password: amule?.ec_password ?? '',
  }
  // El grupo de avisos se siembra igual: un `settings.json` anterior a C-01 no
  // lo tiene, y una tarjeta que lee `notifications.ntfy.url` sin guardas es
  // exactamente la regresión de producción del qbit-nativo (Log L8).
  const ntfy = next.notifications?.ntfy
  next.notifications = {
    ntfy: {
      url: ntfy?.url ?? '',
      topic: ntfy?.topic ?? '',
      token: ntfy?.token ?? '',
      enabled: ntfy?.enabled ?? false,
    },
  }
  // Same tolerance for amuleapi: payloads written before amule-32 lack the
  // group, and the card reads `services.amuleapi.url` without guards.
  const amuleapi = next.services.amuleapi
  next.services.amuleapi = { url: amuleapi?.url ?? '', password: amuleapi?.password ?? '' }
  return next
}

/** Anclajes ARIA del par tab/panel (tablist del sub-raíl, stitch-12). */
const TABS = {
  general: { id: 'settings-tab-general', panel: 'settings-panel-general' },
  indexadores: { id: 'settings-tab-indexadores', panel: 'settings-panel-indexadores' },
  amule: { id: 'settings-tab-amule', panel: 'settings-panel-amule' },
} as const

/** «Probar conexión» de cada tarjeta de Servicios — sondea LO QUE EL FORM
 *  CONTIENE AHORA con `POST /api/services/test` (patrón candidato de la tarjeta
 *  aMule EC): sin guardar y sin disparar descargas. Un campo vacío o
 *  enmascarado (`****…`, lo que GET devuelve para un secreto guardado) se
 *  OMITE para que mande el valor guardado — la misma regla de
 *  `_restore_masked_secrets` en el backend. El veredicto sale como toast con
 *  el `detail` del backend, que siempre incluye la URL intentada (L9: esa URL
 *  a un clic es exactamente lo que faltaba cuando «http://host:8088/» volvió
 *  «HTTP 404» en una descarga real). */
function ServiceProbeButton({
  service,
  values,
}: {
  service: string
  values: Omit<ServiceCandidate, 'service'>
}) {
  const [pending, setPending] = useState(false)

  async function probe() {
    setPending(true)
    try {
      const candidate: ServiceCandidate = { service }
      const url = (values.url ?? '').trim()
      if (url) candidate.url = url
      const apiKey = (values.api_key ?? '').trim()
      if (apiKey && !apiKey.startsWith('****')) candidate.api_key = apiKey
      const user = (values.user ?? '').trim()
      if (user) candidate.user = user
      // Nunca se trimmea: los espacios son legales en una contraseña.
      const password = values.password ?? ''
      if (password !== '' && !password.startsWith('****')) candidate.password = password
      const result = await probeService(candidate)
      toast(result.detail, result.ok ? 'ok' : 'error')
    } catch {
      toast('No se pudo probar la conexión con el backend.', 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      className="settings-btn settings-btn-secondary"
      onClick={pending ? undefined : probe}
    >
      {pending ? 'Probando…' : 'Probar conexión'}
    </button>
  )
}

/** «Probar aviso» (S2): un envío real, con su veredicto a la vista.
 *
 *  No guarda nada: probar el canal y guardar la configuración son dos actos
 *  distintos, y el botón prueba lo guardado — que es lo que va a usarse.
 */
function NotificationTestButton() {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function run() {
    setPending(true)
    try {
      const answer = await testNotification()
      if (answer.ok) {
        setResult({ ok: true, text: `Aviso enviado en ${answer.elapsed_ms} ms.` })
      } else if (answer.error === 'not-configured') {
        setResult({ ok: false, text: 'Canal sin configurar: hacen falta la URL y el topic.' })
      } else {
        setResult({ ok: false, text: `No se pudo enviar: ${answer.error}` })
      }
    } catch {
      setResult({ ok: false, text: 'No se pudo enviar: el backend no respondió.' })
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="settings-btn settings-btn-secondary"
        onClick={pending ? undefined : run}
      >
        {pending ? 'Enviando…' : 'Probar aviso'}
      </button>
      {result && (
        <span className={result.ok ? 'settings-hint' : 'settings-hint settings-hint-error'} role={result.ok ? 'status' : 'alert'}>
          {result.text}
        </span>
      )}
    </>
  )
}

export function Settings() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SettingsForm | null>(null)
  /** T6/S4 — el estado «dirty» del aviso de la cabecera compara `form` contra
   *  `baseline`, el último estado que se sabe persistido/cargado: la config al
   *  cargar (`withAmuleEc(data)`), el payload recién guardado tras un guardado
   *  exitoso, y lo restaurado por «Descartar». Todo el form es JSON puro y
   *  `update()`/`updateList()` copian por JSON (orden de claves estable), así
   *  que la comparación es `JSON.stringify`. */
  const [baseline, setBaseline] = useState<SettingsForm | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [restartFields, setRestartFields] = useState<string[]>([])
  const [tab, setTab] = useState<'general' | 'indexadores' | 'amule'>('general')

  const { data, isPending, error } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })

  useEffect(() => {
    if (data && !form) {
      const seeded = withAmuleEc(data)
      setForm(seeded)
      setBaseline(seeded)
    }
  }, [data, form])

  const testMutation = useMutation({
    mutationFn: testServiceConnections,
  })

  // Misma query key que Indexadores: reutiliza la lista que ya está en caché
  // en vez de pedir /api/services otra vez.
  const servicesQuery = useQuery({ queryKey: ['services'], queryFn: () => fetchServices() })
  const probes = new Map(
    (testMutation.data?.results ?? []).map((result) => [result.key, result] as const),
  )

  const saveMutation = useMutation({
    mutationFn: (payload: SettingsForm) => saveSettings(payload),
    onSuccess: (result, payload) => {
      // Un guardado exitoso limpia el aviso dirty: lo guardado ES el nuevo
      // baseline (explícito, sin depender del refetch — el GET puede seguir
      // devolviendo enmascarados/valores que difieren del form). Es el MISMO
      // mutation para el «Guardar cambios» de la cabecera y el de la tarjeta
      // aMule (T6/S4), así ambos caminos limpian el aviso.
      setBaseline(payload)
      setRestartFields(result.restart_required || [])
      setToast(result.restart_required?.length
        ? `Guardado. Reinicia para aplicar: ${result.restart_required.join(', ')}`
        : 'Configuración guardada')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['config'] })
      setTimeout(() => setToast(null), 5000)
    },
  })

  if (isPending) return <div className="wanted-loading">Cargando configuración...</div>
  if (error) return <div className="error-box">Error cargando configuración</div>
  if (!form) return null

  const dirty = baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline)

  /** El MISMO guardado para la cabecera y la tarjeta aMule (T6/S4):
   *  `saveMutation` → `POST /api/settings` → `rebuild()`. */
  function doSave() {
    if (form) saveMutation.mutate(form)
  }

  function update(path: string, value: string) {
    setForm((prev) => {
      if (!prev) return prev
      const next = JSON.parse(JSON.stringify(prev)) as Settings
      const keys = path.split('.')
      let obj = next as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]] as Record<string, unknown>
      }
      const last = keys[keys.length - 1]
      const current = obj[last]
      if (typeof current === 'boolean') {
        obj[last] = value === 'true'
      } else if (typeof current === 'number') {
        obj[last] = Number(value) || 0
      } else {
        obj[last] = value
      }
      return next
    })
  }

  function updateList(path: string, value: string) {
    setForm((prev) => {
      if (!prev) return prev
      const next = JSON.parse(JSON.stringify(prev)) as Settings
      const keys = path.split('.')
      let obj = next as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]] as Record<string, unknown>
      }
      obj[keys[keys.length - 1]] = value.split(',').map((s) => s.trim()).filter(Boolean)
      return next
    })
  }

  const isRestarting = (path: string) => restartFields.includes(path)

  return (
    <div className="settings-page">
      {toast && <div className="settings-toast">{toast}</div>}

      {/* Sub-raíl VERTICAL de ~320px (config-1x1 T3/S2, stitch-12-general.html):
          título, descripción, ítems «General»/«Indexadores» (semántica de
          pestañas) y la tarjeta de pie «Sincronización de Daemons». Copia y
          disposición literales del diseño; sin rutas nuevas. */}
      <aside className="settings-rail">
        <div className="settings-rail-top">
          <div>
            <span className="settings-rail-title">Configuración</span>
            <p className="settings-rail-desc">
              Parámetros operacionales, endpoints locales, demonios multimedia y credenciales de acceso.
            </p>
          </div>
          <nav aria-label="Secciones de configuración">
            <div
              role="tablist"
              aria-label="Secciones de configuración"
              aria-orientation="vertical"
              className="settings-rail-tabs"
            >
              <button
                type="button"
                role="tab"
                id={TABS.general.id}
                aria-controls={TABS.general.panel}
                aria-selected={tab === 'general'}
                className={`settings-rail-item ${tab === 'general' ? 'active' : ''}`}
                onClick={() => setTab('general')}
              >
                <span className="settings-rail-item-label">General</span>
                <span className="settings-rail-item-dot" aria-hidden="true" />
              </button>
              <button
                type="button"
                role="tab"
                id={TABS.indexadores.id}
                aria-controls={TABS.indexadores.panel}
                aria-selected={tab === 'indexadores'}
                className={`settings-rail-item ${tab === 'indexadores' ? 'active' : ''}`}
                onClick={() => setTab('indexadores')}
              >
                <span className="settings-rail-item-label">Indexadores</span>
                <span className="settings-rail-item-tag" aria-hidden="true">Torznab</span>
              </button>
              <button
                type="button"
                role="tab"
                id={TABS.amule.id}
                aria-controls={TABS.amule.panel}
                aria-selected={tab === 'amule'}
                className={`settings-rail-item ${tab === 'amule' ? 'active' : ''}`}
                onClick={() => setTab('amule')}
              >
                <span className="settings-rail-item-label">aMule</span>
                <span className="settings-rail-item-dot" aria-hidden="true" />
              </button>
            </div>
          </nav>
        </div>
        <div className="settings-rail-foot">
          <div className="settings-rail-foot-title">Sincronización de Daemons</div>
          <p className="settings-rail-foot-text">
            Los perfiles y conexiones críticas se sincronizan directamente con los daemons locales de Node y sockets UNIX. Cualquier cambio surte efecto de forma inmediata sin necesidad de reiniciar el host salvo que se modifique el puerto de escucha.
          </p>
        </div>
      </aside>

      {/* Ambos paneles siguen montados (el inactivo, oculto y con aria-hidden):
          así la mitad llena de un formulario no se pierde al pestañear, y las
          queries de jsdom siguen encontrando lo que ya encontraban. */}
      <div
        role="tabpanel"
        id={TABS.general.panel}
        aria-labelledby={TABS.general.id}
        aria-hidden={tab !== 'general'}
        hidden={tab !== 'general'}
        className="settings-panel"
      >
      {/* Cabecera del panel (stitch-12): título + subtítulo y las acciones
          «Guardar cambios» / «Descartar» arriba a la derecha. «Descartar»
          hereda la semántica del antiguo «Restablecer» (recarga lo guardado y
          limpia los avisos de reinicio); sólo cambian sitio y nombre.
          T6/S4: mientras `form` difiera del baseline se muestra el aviso
          «cambios sin guardar» y el «Guardar cambios» marca estado dirty
          (`.settings-btn-dirty`, Settings.css); lo limpian un guardado
          exitoso y «Descartar». */}
      <div className="settings-panel-header">
        <div>
          <h2 className="settings-panel-title">General</h2>
          <p className="settings-panel-subtitle">
            Ajustes generales del panel y conexiones de los servicios
          </p>
        </div>
        <div className="settings-panel-actions">
          {dirty && <span className="settings-unsaved-badge">cambios sin guardar</span>}
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={() => {
              const restored = data ? withAmuleEc(data) : null
              setForm(restored)
              setBaseline(restored)
              setRestartFields([])
            }}
          >
            Descartar
          </button>
          <button
            type="button"
            className={`settings-btn settings-btn-primary${dirty ? ' settings-btn-dirty' : ''}`}
            onClick={doSave}
            disabled={saveMutation.isPending || !form}
          >
            {saveMutation.isPending ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </div>
      <Section
        icon="🔄"
        title="Estado de las conexiones"
        subtitle="Una fila por servicio con la URL intentada, el estado y la latencia medida. Distingue una clave rechazada de un servicio inalcanzable, antes y después de moverlos de sitio. La comprobación es a petición, no al abrir la página; aMule vive sobre EC (TCP) y no se sondea aquí."
      >
        <button
          type="button"
          className="action-btn search-all"
          onClick={() => testMutation.mutate()}
          disabled={testMutation.isPending}
        >
          {testMutation.isPending ? 'Probando…' : '🔌 Probar conexiones'}
        </button>

        {testMutation.isError && (
          <div className="service-test fail" role="alert">
            <div className="service-test-detail">
              No se pudo completar la comprobación. Revisa la conexión con el backend.
            </div>
          </div>
        )}

        <div className="connections-table-wrap">
          <table className="connections-table">
            <thead>
              <tr>
                <th scope="col">Servicio</th>
                <th scope="col">Endpoint</th>
                <th scope="col">Estado</th>
                <th scope="col">Latencia</th>
              </tr>
            </thead>
            <tbody>
              {connectionRows(servicesQuery.data?.services, probes).map((row) => (
                <tr key={row.service.key}>
                  <td className="connections-name">{row.name}</td>
                  <td className="connections-endpoint">{row.url || '—'}</td>
                  <td>
                    <span className={`connections-pill ${row.state}`} title={row.hint || undefined}>
                      {CONNECTION_LABEL[row.state]}
                    </span>
                    {row.reason && (
                      <span className="connections-reason" role="alert">{row.reason}</span>
                    )}
                  </td>
                  <td className="connections-latency">{row.latency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        icon="🔌"
        title="Servicios"
        subtitle="Endpoints y tokens de autenticación para la orquestación arr."
      >
        <div className="settings-group">
          <h4>Radarr</h4>
          <Field label="URL" value={form.services.radarr.url} onChange={(v) => update('services.radarr.url', v)} restart={isRestarting('services.radarr.url')} placeholder="http://localhost:7878" />
          <Field label="API Key" value={form.services.radarr.api_key} onChange={(v) => update('services.radarr.api_key', v)} restart={isRestarting('services.radarr.api_key')} placeholder="Tu API key de Radarr" type="password" />
          <div className="settings-group-actions">
            <ServiceProbeButton
              service="radarr"
              values={{ url: form.services.radarr.url, api_key: form.services.radarr.api_key }}
            />
          </div>
        </div>
        <div className="settings-group">
          <h4>Sonarr</h4>
          <Field label="URL" value={form.services.sonarr.url} onChange={(v) => update('services.sonarr.url', v)} restart={isRestarting('services.sonarr.url')} placeholder="http://localhost:8989" />
          <Field label="API Key" value={form.services.sonarr.api_key} onChange={(v) => update('services.sonarr.api_key', v)} restart={isRestarting('services.sonarr.api_key')} placeholder="Tu API key de Sonarr" type="password" />
          <div className="settings-group-actions">
            <ServiceProbeButton
              service="sonarr"
              values={{ url: form.services.sonarr.url, api_key: form.services.sonarr.api_key }}
            />
          </div>
        </div>
        <div className="settings-group">
          <h4>aMuTorrent</h4>
          <p className="settings-hint">Ruta de rollback (AMULE_EC_DIRECT=0): el camino activo va por EC directo y búsqueda vía aMule API.</p>
          <Field label="URL" value={form.services.amutorrent.url} onChange={(v) => update('services.amutorrent.url', v)} restart={isRestarting('services.amutorrent.url')} placeholder="http://localhost:4000" />
          <Field label="API Key" value={form.services.amutorrent.api_key} onChange={(v) => update('services.amutorrent.api_key', v)} restart={isRestarting('services.amutorrent.api_key')} placeholder="Tu API key" type="password" />
          <Field label="Usuario" value={form.services.amutorrent.user} onChange={(v) => update('services.amutorrent.user', v)} restart={isRestarting('services.amutorrent.user')} />
          <Field label="Contraseña" value={form.services.amutorrent.password} onChange={(v) => update('services.amutorrent.password', v)} restart={isRestarting('services.amutorrent.password')} type="password" />
          <div className="settings-group-actions">
            <ServiceProbeButton
              service="amutorrent"
              values={{
                url: form.services.amutorrent.url,
                api_key: form.services.amutorrent.api_key,
                user: form.services.amutorrent.user,
                password: form.services.amutorrent.password,
              }}
            />
          </div>
        </div>
        <div className="settings-group">
          <h4>aMule API</h4>
          <Field label="URL" value={form.services.amuleapi.url} onChange={(v) => update('services.amuleapi.url', v)} restart={isRestarting('services.amuleapi.url')} placeholder="http://localhost:4713" />
          <Field label="Contraseña" value={form.services.amuleapi.password} onChange={(v) => update('services.amuleapi.password', v)} restart={isRestarting('services.amuleapi.password')} type="password" />
          <div className="settings-group-actions">
            <ServiceProbeButton
              service="amuleapi"
              values={{
                url: form.services.amuleapi.url,
                password: form.services.amuleapi.password,
              }}
            />
          </div>
        </div>
        <div className="settings-group">
          <h4>qBittorrent</h4>
          <Field label="URL" value={form.services.qbit.url} onChange={(v) => update('services.qbit.url', v)} restart={isRestarting('services.qbit.url')} placeholder="http://localhost:8080" />
          <Field label="Usuario" value={form.services.qbit.user} onChange={(v) => update('services.qbit.user', v)} restart={isRestarting('services.qbit.user')} />
          <Field label="Contraseña" value={form.services.qbit.password} onChange={(v) => update('services.qbit.password', v)} restart={isRestarting('services.qbit.password')} type="password" />
          <div className="settings-group-actions">
            <ServiceProbeButton
              service="qbit"
              values={{
                url: form.services.qbit.url,
                user: form.services.qbit.user,
                password: form.services.qbit.password,
              }}
            />
          </div>
        </div>
        <div className="settings-group">
          <h4>OpenSubtitles</h4>
          <Field label="API Key" value={form.services.opensubtitles.api_key} onChange={(v) => update('services.opensubtitles.api_key', v)} restart={isRestarting('services.opensubtitles.api_key')} placeholder="Clave API de OpenSubtitles" type="password" />
          <div className="settings-group-actions">
            <ServiceProbeButton service="opensubtitles" values={{ api_key: form.services.opensubtitles.api_key }} />
          </div>
        </div>
      </Section>


      <Section
        icon="🔒"
        title="Seguridad"
        subtitle="Autenticación del propio panel FlowController y políticas de integridad."
      >
        <Field label="API Key propia" value={form.security.api_key} onChange={(v) => update('security.api_key', v)} restart={isRestarting('security.api_key')} placeholder="Clave para proteger la API" type="password" />
        <Field label="Modo seguro (bloquea acciones destructivas)" value={form.security.safe_mode} onChange={(v) => update('security.safe_mode', v)} type="toggle" />
      </Section>

      <Section
        icon="📁"
        title="Rutas"
        subtitle="Mapeo de almacenamiento en disco, librerías y puntos de montaje ZFS/RAID."
      >
        <Field label="Carpeta descargas aMuTorrent" value={form.paths.download_amule} onChange={(v) => update('paths.download_amule', v)} />
        <Field label="Carpeta descargas Torrent" value={form.paths.download_torrent} onChange={(v) => update('paths.download_torrent', v)} />
        <Field label="Raíces permitidas (separadas por coma)" value={(form.paths.allowed_roots ?? []).join(", ")} onChange={(v) => updateList('paths.allowed_roots', v)} />
        <Field
          label="Carpeta de los 4K (vacío = biblioteca de Radarr)"
          value={form.paths.path_4k ?? ''}
          onChange={(v) => update('paths.path_4k', v)}
          placeholder="/mnt/storage/peliculas-4k"
        />
        <Field
          label="Carpeta de las 3D (vacío = no enrutarlas aparte)"
          value={form.paths.path_3d ?? ''}
          onChange={(v) => update('paths.path_3d', v)}
          placeholder="/mnt/storage/peliculas-3d"
        />
      </Section>

      {/* Not inside the form above: it writes aMule's own files and takes
          effect on its own button, where "Guardar cambios" would
          otherwise claim to have saved something it never saw. */}
      <SharedDirsSection />

      <Section
        icon="⏱️"
        title="Intervalos"
        subtitle="Temporizadores de sondeo, reintentos de red y límites de procesamiento."
      >
        <Field label="Check interval (segundos)" value={form.intervals.check} onChange={(v) => update('intervals.check', v)} type="number" />
        <Field label="Max reintentos" value={form.intervals.max_retries} onChange={(v) => update('intervals.max_retries', v)} type="number" />
        <Field label="Delay entre reintentos (segundos)" value={form.intervals.retry_delay} onChange={(v) => update('intervals.retry_delay', v)} type="number" />
        <Field label="Timeout peticiones HTTP (segundos)" value={form.intervals.request_timeout} onChange={(v) => update('intervals.request_timeout', v)} type="number" />
        <Field label="Timeout import (segundos)" value={form.intervals.import_timeout} onChange={(v) => update('intervals.import_timeout', v)} type="number" />
        {/* The retention window is the Intervalos group's only value measured
            in days instead of seconds; no `restart` badge because the backend
            reads it live through config.rebuild(). */}
        <Field label="Días antes de poder borrar una descarga" value={form.retention.amule_days} onChange={(v) => update('retention.amule_days', v)} type="number" />
      </Section>

      <Section
        icon="🎚️"
        title="Calidad de biblioteca"
        subtitle="El umbral por debajo del cual una película cuenta como baja calidad."
      >
        {/* S2 («umbral-calidad»): what «baja calidad» means. The chip and the
            below-threshold list both read this, so it lives with the rest of
            the saved configuration — no separate save button. */}
        <QualityThresholdSection
          minClass={form.quality?.min_class ?? '1080p'}
          minWidth={form.quality?.min_width ?? 0}
          onClass={(value) => update('quality.min_class', value)}
          onWidth={(value) => {
            setForm((prev) => (prev ? { ...prev, quality: { ...prev.quality, min_width: value } } : prev))
          }}
        />
      </Section>

      <Section
        icon="🧹"
        title="Seguimiento"
        subtitle="Políticas de retención y limpieza automatizada."
      >
        <Field label="Límite de trazas" value={form.tracing.limit} onChange={(v) => update('tracing.limit', v)} type="number" />
      </Section>

      <Section
        icon="🔔"
        title="Avisos"
        subtitle="Cuándo avisar y por dónde: el canal ntfy que recibe los mensajes."
      >
        <div className="settings-group">
          <h4>ntfy</h4>
          <Field
            label="URL del servidor"
            value={form.notifications.ntfy.url}
            onChange={(v) => update('notifications.ntfy.url', v)}
            placeholder="http://ntfy.local:8080"
          />
          <Field
            label="Topic"
            value={form.notifications.ntfy.topic}
            onChange={(v) => update('notifications.ntfy.topic', v)}
            placeholder="flowcontroller"
          />
          <Field
            label="Token (sólo si el topic está protegido)"
            value={form.notifications.ntfy.token}
            onChange={(v) => update('notifications.ntfy.token', v)}
            placeholder="tk_…"
            type="password"
          />
          <Field
            label="Enviar avisos"
            value={form.notifications.ntfy.enabled}
            onChange={(v) => update('notifications.ntfy.enabled', v)}
            type="toggle"
          />
          <div className="settings-group-actions">
            <NotificationTestButton />
          </div>
        </div>
      </Section>

      <Section
        icon="🖥️"
        title="Servidor"
        subtitle="Control del daemon HTTP central de FlowController."
      >
        <Field label="Puerto" value={form.server.port} onChange={(v) => update('server.port', v)} type="number" restart={isRestarting('server.port')} />
      </Section>

      <LogsSection />
      </div>

      <div
        role="tabpanel"
        id={TABS.indexadores.panel}
        aria-labelledby={TABS.indexadores.id}
        aria-hidden={tab !== 'indexadores'}
        hidden={tab !== 'indexadores'}
        className="settings-panel"
      >
        {/* T6/S5 — direct connections: its own SQLite table and its own
            buttons, so (like SharedDirsSection) it is not part of the form
            that "Guardar cambios" claims to save. S1: the callout's «aMule
            (EC directo)» destination now lives in its own tab. */}
        <IndexadoresSection onOpenGeneral={() => setTab('amule')} />
      </div>

      {/* S1 (amule-control): la config de aMule, su watchdog y sus acciones EC
          en la tercera pestaña — mismas claves `services.amule.*` y mismo ciclo
          Guardar/Descartar, sólo cambia de sitio. */}
      <div
        role="tabpanel"
        id={TABS.amule.panel}
        aria-labelledby={TABS.amule.id}
        aria-hidden={tab !== 'amule'}
        hidden={tab !== 'amule'}
        className="settings-panel"
      >
        {/* S2 — «Recuerda que los datos para conectar amule son diferentes a
            los indexadores de prowlarr y jackett por ejemplo» (Log L1c): su
            propia tarjeta (S1: esta pestaña); los indexadores Torznab viven en
            la pestaña Indexadores. Form-bindings como los servicios vecinos,
            pero la contraseña EC llega siempre enmascarada y «vacío/máscara =
            conservar la guardada» lo aplica el backend. */}
        <AmuleEcSection
          values={form.services.amule ?? { url: '', ec_port: '', ec_password: '' }}
          update={update}
          isRestarting={isRestarting}
          onOpenIndexadores={() => setTab('indexadores')}
          onSave={doSave}
          saving={saveMutation.isPending}
        />
        <AmuleServerActions />
      </div>
    </div>
  )
}

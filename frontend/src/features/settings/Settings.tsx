import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Settings, SaveSettingsResponse } from '../../shared/types.ts'
import { apiFetch } from '../../shared/api/auth.ts'
import {
  probeService,
  testServiceConnections,
  type ServiceCandidate,
  type ServiceTestResult,
} from '../../shared/api/services.ts'
import { toast } from '../../shared/utils/toast.ts'
import { SharedDirsSection } from './SharedDirsSection.tsx'
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
    <Section title="Logs del Sistema">
      <div className="settings-logs-controls">
        <button className="action-btn" onClick={fetchLogs} disabled={loading}>
          {loading ? 'Cargando...' : '🔄 Actualizar'}
        </button>
        <label className="settings-toggle-label">
          <button
            className={`settings-toggle ${autoRefresh ? 'on' : 'off'}`}
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{title}</h3>
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
      <Section title="Servicios">
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

      <Section title="Estado de las conexiones">
        <p className="settings-hint">
          Comprueba que Radarr, Sonarr, aMuTorrent y qBittorrent responden con la configuración
          actual. Útil antes y después de mover los servicios de sitio: muestra la
          URL con la que se intenta conectar y distingue una clave rechazada de
          un servicio inalcanzable.
        </p>
        <button
          type="button"
          className="action-btn search-all"
          onClick={() => testMutation.mutate()}
          disabled={testMutation.isPending}
        >
          {testMutation.isPending ? 'Probando…' : '🔌 Probar conexiones'}
        </button>

        {testMutation.data && (
          <div className="settings-service-tests">
            {testMutation.data.results.map((result: ServiceTestResult) => (
              <div
                key={result.key}
                className={`service-test ${result.ok ? 'ok' : 'fail'}`}
                role={result.ok ? undefined : 'alert'}
              >
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

        {testMutation.isError && (
          <div className="settings-service-tests">
            <div className="service-test fail" role="alert">
              <div className="service-test-detail">
                No se pudo completar la comprobación. Revisa la conexión con el backend.
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section title="Seguridad">
        <Field label="API Key propia" value={form.security.api_key} onChange={(v) => update('security.api_key', v)} restart={isRestarting('security.api_key')} placeholder="Clave para proteger la API" type="password" />
        <Field label="Modo seguro (bloquea acciones destructivas)" value={form.security.safe_mode} onChange={(v) => update('security.safe_mode', v)} type="toggle" />
      </Section>

      <Section title="Rutas">
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

      <Section title="Intervalos">
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

      <Section title="Seguimiento">
        <Field label="Límite de trazas" value={form.tracing.limit} onChange={(v) => update('tracing.limit', v)} type="number" />
      </Section>

      <Section title="Servidor">
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

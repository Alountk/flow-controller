import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Settings, SaveSettingsResponse } from '../../shared/types.ts'
import { apiFetch } from '../../shared/api/auth.ts'
import { testServiceConnections, type ServiceTestResult } from '../../shared/api/services.ts'
import { SharedDirsSection } from './SharedDirsSection.tsx'
import { IndexadoresSection } from './IndexadoresSection.tsx'
import { AmuleEcSection, type AmuleEcValues } from './AmuleEcSection.tsx'
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

/** Doble raíl (S1) — sub-nav «Configuración», estilo Radarr. Los estilos son
 *  en línea porque `Settings.css` queda fuera de las superficies de edición de
 *  esta tarea. */
const subnavStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  margin: '0 0 12px',
}

function subnavTabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 8,
    border: active ? '1px solid var(--accent, #b48ead)' : '1px solid var(--border)',
    background: active ? 'var(--surface-1)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-2)',
    fontWeight: active ? 600 : 500,
    fontSize: 13,
    cursor: 'pointer',
  }
}

const subnavTagStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-dim)',
  fontFamily: 'monospace',
}

/** Ambos paneles siguen montados (el inactivo, oculto): así la mitad llena de
 *  un formulario no se pierde al pestañear, y las queries de jsdom siguen
 *  encontrando lo que ya encontraban. */
function panelStyle(active: boolean): React.CSSProperties {
  return active ? {} : { display: 'none' }
}

export function Settings() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [restartFields, setRestartFields] = useState<string[]>([])
  const [tab, setTab] = useState<'general' | 'indexadores'>('general')

  const { data, isPending, error } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })

  useEffect(() => {
    if (data && !form) setForm(withAmuleEc(data))
  }, [data, form])

  const testMutation = useMutation({
    mutationFn: testServiceConnections,
  })

  const saveMutation = useMutation({
    mutationFn: () => saveSettings(form!),
    onSuccess: (result) => {
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

      {/* S1: submenú interno — sin rutas nuevas; la barra lateral no se toca. */}
      <nav className="settings-subnav" aria-label="Secciones de configuración" style={subnavStyle}>
        <button
          type="button"
          style={subnavTabStyle(tab === 'general')}
          aria-current={tab === 'general' ? 'page' : undefined}
          onClick={() => setTab('general')}
        >
          General
        </button>
        <button
          type="button"
          style={subnavTabStyle(tab === 'indexadores')}
          aria-current={tab === 'indexadores' ? 'page' : undefined}
          onClick={() => setTab('indexadores')}
        >
          Indexadores
        </button>
        <span aria-hidden="true" style={subnavTagStyle}>Torznab</span>
      </nav>
      <p className="settings-hint">
        Parámetros operacionales, endpoints locales, demonios multimedia y credenciales de acceso.
      </p>

      <div hidden={tab !== 'general'} style={panelStyle(tab === 'general')}>
      <Section title="Servicios">
        <div className="settings-group">
          <h4>Radarr</h4>
          <Field label="URL" value={form.services.radarr.url} onChange={(v) => update('services.radarr.url', v)} restart={isRestarting('services.radarr.url')} placeholder="http://localhost:7878" />
          <Field label="API Key" value={form.services.radarr.api_key} onChange={(v) => update('services.radarr.api_key', v)} restart={isRestarting('services.radarr.api_key')} placeholder="Tu API key de Radarr" type="password" />
        </div>
        <div className="settings-group">
          <h4>Sonarr</h4>
          <Field label="URL" value={form.services.sonarr.url} onChange={(v) => update('services.sonarr.url', v)} restart={isRestarting('services.sonarr.url')} placeholder="http://localhost:8989" />
          <Field label="API Key" value={form.services.sonarr.api_key} onChange={(v) => update('services.sonarr.api_key', v)} restart={isRestarting('services.sonarr.api_key')} placeholder="Tu API key de Sonarr" type="password" />
        </div>
        <div className="settings-group">
          <h4>aMuTorrent</h4>
          <Field label="URL" value={form.services.amutorrent.url} onChange={(v) => update('services.amutorrent.url', v)} restart={isRestarting('services.amutorrent.url')} placeholder="http://localhost:4000" />
          <Field label="API Key" value={form.services.amutorrent.api_key} onChange={(v) => update('services.amutorrent.api_key', v)} restart={isRestarting('services.amutorrent.api_key')} placeholder="Tu API key" type="password" />
          <Field label="Usuario" value={form.services.amutorrent.user} onChange={(v) => update('services.amutorrent.user', v)} restart={isRestarting('services.amutorrent.user')} />
          <Field label="Contraseña" value={form.services.amutorrent.password} onChange={(v) => update('services.amutorrent.password', v)} restart={isRestarting('services.amutorrent.password')} type="password" />
        </div>
        <div className="settings-group">
          <h4>OpenSubtitles</h4>
          <Field label="API Key" value={form.services.opensubtitles.api_key} onChange={(v) => update('services.opensubtitles.api_key', v)} restart={isRestarting('services.opensubtitles.api_key')} placeholder="Clave API de OpenSubtitles" type="password" />
        </div>
      </Section>

      <Section title="Estado de las conexiones">
        <p className="settings-hint">
          Comprueba que Radarr, Sonarr y aMuTorrent responden con la configuración
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

      {/* S2 — «Recuerda que los datos para conectar amule son diferentes a
          los indexadores de prowlarr y jackett por ejemplo» (Log L1c): su
          propia tarjeta, aquí en General; los indexadores Torznab viven en la
          pestaña Indexadores. Form-bindings como los servicios vecinos, pero
          la contraseña EC llega siempre enmascarada y «vacío/máscara =
          conservar la guardada» lo aplica el backend. */}
      <AmuleEcSection
        values={form.services.amule ?? { url: '', ec_port: '', ec_password: '' }}
        update={update}
        isRestarting={isRestarting}
      />

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
          effect on its own button, where "Guardar configuración" would
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

      <div className="settings-actions">
        <button
          className="action-btn search-all"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !form}
        >
          {saveMutation.isPending ? 'Guardando...' : '💾 Guardar configuración'}
        </button>
        <button
          className="action-btn"
          onClick={() => { setForm(data ? withAmuleEc(data) : null); setRestartFields([]) }}
        >
          Restablecer
        </button>
      </div>
      </div>

      <div hidden={tab !== 'indexadores'} style={panelStyle(tab === 'indexadores')}>
        {/* T6/S5 — direct connections: its own SQLite table and its own
            buttons, so (like SharedDirsSection) it is not part of the form
            that "Guardar configuración" claims to save. */}
        <IndexadoresSection />
      </div>
    </div>
  )
}

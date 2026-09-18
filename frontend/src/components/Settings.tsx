import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Settings, SaveSettingsResponse } from '../types'
import { authHeaders } from '../api/auth'

async function fetchSettings(): Promise<Settings> {
  const res = await fetch('/api/settings', { headers: authHeaders() })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<Settings>
}

async function saveSettings(data: Settings): Promise<SaveSettingsResponse> {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<SaveSettingsResponse>
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  restart = false,
  placeholder,
}: {
  label: string
  value: string | number | boolean
  onChange: (v: string) => void
  type?: string
  restart?: boolean
  placeholder?: string
}) {
  return (
    <div className="settings-field">
      <label className="settings-label">
        {label}
        {restart && <span className="settings-restart-badge">Requiere reinicio</span>}
      </label>
      {type === 'toggle' ? (
        <button
          className={`settings-toggle ${value ? 'on' : 'off'}`}
          onClick={() => onChange(value ? 'false' : 'true')}
        >
          {value ? 'Sí' : 'No'}
        </button>
      ) : (
        <input
          className="settings-input"
          type={type}
          value={String(value)}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{title}</h3>
      {children}
    </div>
  )
}

export function Settings() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Settings | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [restartFields, setRestartFields] = useState<string[]>([])

  const { data, isPending, error } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })

  useEffect(() => {
    if (data && !form) setForm(data)
  }, [data, form])

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
      let obj: Record<string, unknown> = next as Record<string, unknown>
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
      let obj: Record<string, unknown> = next as Record<string, unknown>
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

      <Section title="Servicios">
        <div className="settings-group">
          <h4>Radarr</h4>
          <Field label="URL" value={form.services.radarr.url} onChange={(v) => update('services.radarr.url', v)} restart={isRestarting('services.radarr.url')} placeholder="http://localhost:7878" />
          <Field label="API Key" value={form.services.radarr.api_key} onChange={(v) => update('services.radarr.api_key', v)} restart={isRestarting('services.radarr.api_key')} placeholder="Tu API key de Radarr" />
        </div>
        <div className="settings-group">
          <h4>Sonarr</h4>
          <Field label="URL" value={form.services.sonarr.url} onChange={(v) => update('services.sonarr.url', v)} restart={isRestarting('services.sonarr.url')} placeholder="http://localhost:8989" />
          <Field label="API Key" value={form.services.sonarr.api_key} onChange={(v) => update('services.sonarr.api_key', v)} restart={isRestarting('services.sonarr.api_key')} placeholder="Tu API key de Sonarr" />
        </div>
        <div className="settings-group">
          <h4>aMuTorrent</h4>
          <Field label="URL" value={form.services.amutorrent.url} onChange={(v) => update('services.amutorrent.url', v)} restart={isRestarting('services.amutorrent.url')} placeholder="http://localhost:4000" />
          <Field label="API Key" value={form.services.amutorrent.api_key} onChange={(v) => update('services.amutorrent.api_key', v)} restart={isRestarting('services.amutorrent.api_key')} placeholder="Tu API key" />
          <Field label="Usuario" value={form.services.amutorrent.user} onChange={(v) => update('services.amutorrent.user', v)} restart={isRestarting('services.amutorrent.user')} />
          <Field label="Contraseña" value={form.services.amutorrent.password} onChange={(v) => update('services.amutorrent.password', v)} restart={isRestarting('services.amutorrent.password')} type="password" />
        </div>
      </Section>

      <Section title="Seguridad">
        <Field label="API Key propia" value={form.security.api_key} onChange={(v) => update('security.api_key', v)} restart={isRestarting('security.api_key')} placeholder="Clave para proteger la API" />
        <Field label="Modo seguro (bloquea acciones destructivas)" value={form.security.safe_mode} onChange={(v) => update('security.safe_mode', v)} type="toggle" />
      </Section>

      <Section title="Rutas">
        <Field label="Carpeta descargas aMuTorrent" value={form.paths.download_amule} onChange={(v) => update('paths.download_amule', v)} />
        <Field label="Carpeta descargas Torrent" value={form.paths.download_torrent} onChange={(v) => update('paths.download_torrent', v)} />
        <Field label="Raíces permitidas (separadas por coma)" value={form.paths.allowed_roots.join(', ')} onChange={(v) => updateList('paths.allowed_roots', v)} />
      </Section>

      <Section title="Intervalos">
        <Field label="Check interval (segundos)" value={form.intervals.check} onChange={(v) => update('intervals.check', v)} type="number" />
        <Field label="Max reintentos" value={form.intervals.max_retries} onChange={(v) => update('intervals.max_retries', v)} type="number" />
        <Field label="Delay entre reintentos (segundos)" value={form.intervals.retry_delay} onChange={(v) => update('intervals.retry_delay', v)} type="number" />
        <Field label="Timeout peticiones HTTP (segundos)" value={form.intervals.request_timeout} onChange={(v) => update('intervals.request_timeout', v)} type="number" />
        <Field label="Timeout import (segundos)" value={form.intervals.import_timeout} onChange={(v) => update('intervals.import_timeout', v)} type="number" />
      </Section>

      <Section title="Trazabilidad">
        <Field label="Límite de trazas" value={form.tracing.limit} onChange={(v) => update('tracing.limit', v)} type="number" />
      </Section>

      <Section title="Servidor">
        <Field label="Puerto" value={form.server.port} onChange={(v) => update('server.port', v)} type="number" restart={isRestarting('server.port')} />
      </Section>

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
          onClick={() => { setForm(data ?? null); setRestartFields([]) }}
        >
          Restablecer
        </button>
      </div>
    </div>
  )
}
